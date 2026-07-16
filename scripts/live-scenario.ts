/**
 * Live scenario run: a REAL spoken conversation over Twilio between the two
 * bench-owned numbers. The bench leg speaks a scenario's caller turns (TTS)
 * and transcribes what it hears (STT, with real per-turn confidence); the sim
 * leg hears (STT), advances the fact-set-driven flow, and speaks its replies
 * (TTS). The frozen transcript is then assessed by the SAME offline assertion
 * layer the suite uses — this is the record half and the assert half joined
 * over real audio for the first time.
 *
 * Both destinations are OWNED numbers: the dial goes through placeCall, whose
 * guard refuses anything this account does not own, and refuses the system
 * under test explicitly. Unattended owned-to-owned dials are sanctioned
 * (AGENTS.md, maintainer decision 2026-07-16); the run stays bounded anyway:
 * ONE call, no retry, a hard wall-clock cap.
 *
 * Usage:
 *   node --env-file=.env scripts/live-scenario.ts
 *   node --env-file=.env scripts/live-scenario.ts --defect fabricateAnswer
 *   node --env-file=.env scripts/live-scenario.ts --scenario windshield-quote --no-judge
 *
 * Output: data/live-sim/<epoch>/ — transcript.json (hashed+frozen), the bench-
 * heard audio as WAV, events.jsonl, meta.json (what the sim THOUGHT it heard,
 * per turn, for divergence analysis), and report.txt from the assessment.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { babble, processBuffer } from '@callbench/audioqc';
import { claudeRunner, MapCache, RunnerError } from '@callbench/judge';
import {
	agentReply,
	allScenarios,
	assess,
	buildRunArtifact,
	type ExchangeTurn,
	NEXUS_IMITATION,
	nextLine,
	probeLines,
	renderScenarioReport,
	runIdOf,
	type Scenario,
	type ScenarioReport,
	writeRunArtifact,
} from '@callbench/scenario';
import { NO_DEFECTS, step } from '@callbench/simulator';
import { ModalWhisperStt, type SttResult } from '@callbench/stt';
import { type Confidence, Transcript } from '@callbench/transcript';
import {
	decodeMulaw,
	serveTwilioMedia,
	type TransportEvent,
	type TransportSession,
} from '@callbench/transport';
import { durationMs, ModalKokoroTts, toMulawFrames, type Utterance } from '@callbench/tts';
import { DEFAULT_TURN_CONFIG, EnergyTurnDetector } from '@callbench/turn';
import { startTunnel, waitForTunnel } from './lib/tunnel.ts';
import {
	twilioApi as api,
	assertDialAllowed,
	hangUp,
	placeCall,
	requireAccountSid,
	required,
} from './lib/twilio.ts';

const PORT = 8791;
/** Speech is slower than tones: 4 caller turns + STT round trips. Hard stop. */
const WALL_CAP_MS = Number(process.env.CALLBENCH_WALL_CAP_MS ?? 240_000);
/** No reply within this after our line finishes = dead air; move on. This is
 * how goSilentAtQuote lands as a real absence rather than a hang. */
const DEAD_AIR_MS = 15_000;

interface Args {
	scenario: string;
	defect: 'fabricateAnswer' | 'dropCorrection' | 'goSilentAtQuote' | null;
	judge: boolean;
	/** Hybrid mode: a model improvises the caller's conversational turns toward
	 * the scenario's persona goal; the harness speaks the probes verbatim. */
	persona: boolean;
	/** Rehearsal mode: the SIM leg (the target) is a model imitating the real
	 * shop, not the deterministic state machine — so a persona caller rehearses
	 * against something that improvises like what it will meet. Owned loop only;
	 * defects don't apply (a model target can't be made deterministically wrong). */
	simModel: boolean;
	/** Babble SNR (dB) mixed into the CALLER's outbound voice — the degradation
	 * gradient's knob. null = clean. Recorded in meta; a degraded take must
	 * never masquerade as a clean one. */
	degradeSnrDb: number | null;
}

function parseArgs(): Args {
	const a = process.argv.slice(2);
	const val = (flag: string) => {
		const i = a.indexOf(flag);
		return i >= 0 ? a[i + 1] : undefined;
	};
	const defect = val('--defect') ?? null;
	if (defect && !['fabricateAnswer', 'dropCorrection', 'goSilentAtQuote'].includes(defect)) {
		throw new Error(`unknown defect "${defect}"`);
	}
	const degrade = val('--degrade-snr');
	return {
		scenario: val('--scenario') ?? 'windshield-quote',
		defect: defect as Args['defect'],
		judge: !a.includes('--no-judge'),
		persona: a.includes('--persona'),
		simModel: a.includes('--sim-model'),
		degradeSnrDb: degrade !== undefined ? Number(degrade) : null,
	};
}

/** Wrap 8kHz mono PCM16 in a canonical WAV container for the STT endpoint. */
function pcm16ToWav(pcm: Int16Array, sampleRate = 8000): Uint8Array {
	const buf = Buffer.alloc(44 + pcm.length * 2);
	buf.write('RIFF', 0, 'ascii');
	buf.writeUInt32LE(36 + pcm.length * 2, 4);
	buf.write('WAVE', 8, 'ascii');
	buf.write('fmt ', 12, 'ascii');
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20); // PCM
	buf.writeUInt16LE(1, 22); // mono
	buf.writeUInt32LE(sampleRate, 24);
	buf.writeUInt32LE(sampleRate * 2, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write('data', 36, 'ascii');
	buf.writeUInt32LE(pcm.length * 2, 40);
	for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i] ?? 0, 44 + i * 2);
	return new Uint8Array(buf);
}

/** Weakest span confidence — the same worst-word rule the STT adapter applies
 * within a span; a turn is only as trustworthy as its least-heard word. */
function turnConfidence(r: SttResult): Confidence | null {
	let worst: Confidence | null = null;
	for (const s of r.spans) {
		if (worst === null || s.confidence.score < worst.score) worst = s.confidence;
	}
	return worst;
}

async function main(): Promise<void> {
	const args = parseArgs();
	const found: Scenario | undefined = allScenarios.find((s) => s.name === args.scenario);
	if (!found) {
		throw new Error(
			`unknown scenario "${args.scenario}" (known: ${allScenarios.map((s) => s.name).join(', ')})`,
		);
	}
	// A separate const so the narrowing survives into the hoisted leg functions.
	const scenario: Scenario = found;
	const defects = args.defect ? { ...NO_DEFECTS, [args.defect]: true } : NO_DEFECTS;

	const sid = requireAccountSid();
	const token = required('TWILIO_AUTH_TOKEN');
	const from = required('TWILIO_FROM_NUMBER');
	const to = required('CALLBENCH_LOOPBACK_NUMBER');
	await assertDialAllowed(sid, token, to);

	const stt = new ModalWhisperStt(required('MODAL_STT_URL'), process.env.STT_API_KEY);
	const tts = new ModalKokoroTts(required('MODAL_TTS_URL'), process.env.TTS_API_KEY);
	// The persona's model — the judge package's runner plumbing, reused as an
	// isolated named stage. Its id lands on every improvised turn's provider.
	const personaRunner = claudeRunner('sonnet');
	const personaLog: Array<{ atMs: number; llmMs?: number; prompt: string; raw: string }> = [];

	// Pre-synthesize EVERYTHING both sides could say (docs/models.md: scripted
	// lines are rendered before the call, so the synth link cost is paid
	// off-call). The correction ack is templated per year, so it synthesizes
	// lazily through the same cache on the rare turn that needs it.
	console.log('synth  : pre-rendering both sides…');
	const synthCache = new Map<string, Utterance>();
	const synth = async (text: string, voice: string): Promise<Utterance> => {
		const key = `${voice} ${text}`;
		const hit = synthCache.get(key);
		if (hit) return hit;
		const u = await tts.synthesize(text, voice);
		synthCache.set(key, u);
		return u;
	};
	const BENCH_VOICE = 'am_adam';
	const SIM_VOICE = 'af_heart';
	const callerLines = scenario.caller.map((t) => (typeof t === 'string' ? t : t.say));
	const simLines = [
		scenario.simScript.greetingLine,
		scenario.simScript.vehicleQuestion,
		scenario.simScript.variantQuestion,
		scenario.simScript.quoteLine,
		scenario.simScript.fallbackLine,
		scenario.simScript.closingLine,
		...scenario.simScript.features.flatMap((f) => [f.honest, f.dishonest]),
	];
	await Promise.all([
		...(args.persona
			? probeLines(scenario).map((p2) => synth(p2.say, BENCH_VOICE))
			: callerLines.map((l) => synth(l, BENCH_VOICE))),
		...simLines.map((l) => synth(l, SIM_VOICE)),
	]);
	console.log(`synth  : ${synthCache.size} utterances cached`);

	const zero = performance.now();
	const clock = () => performance.now() - zero;
	const anchorEpochMs = Date.now();

	// Turns are DRAFTED during the call and frozen after it, all shifted onto
	// the audio's own timeline (t=0 at the first inbound frame) — so a span's
	// startMs is literally an offset into the WAV, and "click a finding, hear
	// its span" aligns by construction rather than by a stored fudge factor.
	interface TurnDraft {
		speaker: 'bench' | 'target';
		text: string;
		startMs: number;
		endMs: number;
		confidence: Confidence | null;
		provider: string;
	}
	const turnDrafts: TurnDraft[] = [];
	const events: Array<{ leg: string; type: string; atMs: number; detail?: string }> = [];
	const simHeard: Array<{ atMs: number; heard: string; replied: string | null }> = [];
	// Everything the bench heard, each frame with its session-clock stamp.
	const benchInbound: Array<{ bytes: Uint8Array; atMs: number }> = [];
	// And everything the bench SAID, placed at the moment it started saying it.
	// The record must carry both voices: a WAV of inbound audio alone leaves
	// every bench span pointing at silence — half a conversation, and the half
	// the findings quote is the one that plays.
	const benchOutbound: Array<{ pcm: Int16Array; atMs: number }> = [];
	const sessions: Partial<Record<'bench' | 'sim', TransportSession>> = {};
	let finishRun: () => void = () => {};
	const finished = new Promise<void>((r) => {
		finishRun = r;
	});

	const note = (leg: string, type: string, detail?: string) => {
		events.push({ leg, type, atMs: clock(), ...(detail ? { detail } : {}) });
	};

	// ---- sim leg: hear → flow → speak -------------------------------------
	const turnCfg = { ...DEFAULT_TURN_CONFIG, ...scenario.turnConfig };

	const simExchange: ExchangeTurn[] = [];
	const simLog: Array<{
		atMs: number;
		sttMs?: number;
		llmMs?: number;
		prompt: string;
		raw: string;
	}> = [];
	let simTurns = 0;

	async function runSim(session: TransportSession): Promise<void> {
		sessions.sim = session;
		let memory = { ...(await import('@callbench/simulator')).INITIAL_MEMORY };
		const detector = new EnergyTurnDetector(turnCfg);
		let buffer: Array<{ bytes: Uint8Array; atMs: number }> = [];
		let speechStartMs: number | null = null;
		let busy = false;

		const speak = async (text: string) => {
			const u = await synth(text, SIM_VOICE);
			session.sendAudio(
				toMulawFrames(u).reduce((acc, f) => {
					const merged = new Uint8Array(acc.length + f.length);
					merged.set(acc);
					merged.set(f, acc.length);
					return merged;
				}, new Uint8Array(0)),
			);
			session.sendMark(`sim-${clock().toFixed(0)}`);
		};

		for await (const ev of session.events) {
			if (ev.type === 'started') {
				note('sim', 'started');
				if (args.simModel) {
					const r = await agentReply(NEXUS_IMITATION, [], personaRunner);
					simLog.push({ atMs: clock(), prompt: r.prompt, raw: r.raw });
					simExchange.push({ speaker: 'agent', text: r.text });
					simTurns++;
					await speak(r.text);
				} else {
					await speak(scenario.simScript.greetingLine);
				}
				continue;
			}
			if (ev.type !== 'audio') {
				note('sim', ev.type, ev.type === 'error' ? ev.reason : undefined);
				continue;
			}
			buffer.push({ bytes: ev.bytes, atMs: ev.atMs });
			const turn = detector.push(ev.bytes, ev.atMs);
			if (turn?.type === 'speech-start') speechStartMs = turn.atMs;
			if (turn?.type === 'turn-end' && !busy) {
				busy = true;
				// Same silence-trim as the bench leg: transcribe the spoken span only.
				const sliceFrom = (speechStartMs ?? buffer[0]?.atMs ?? turn.atMs) - 300;
				const pcmChunks = buffer
					.filter((b) => b.atMs >= sliceFrom)
					.map((b) => decodeMulaw(b.bytes));
				buffer = [];
				speechStartMs = null;
				detector.reset();
				const pcm = new Int16Array(pcmChunks.reduce((n, c) => n + c.length, 0));
				let off = 0;
				for (const c of pcmChunks) {
					pcm.set(c, off);
					off += c.length;
				}
				try {
					// Per-stage timing — the whole point of the measurement: STT
					// (audio→text), LLM (reasoning), TTS (text→audio) as three
					// separate numbers, so "audio speed vs LLM reasoning speed" is
					// visible per turn, not just a lumped total.
					const tStt = performance.now();
					const heard = await stt.transcribe(pcm16ToWav(pcm), 'audio/wav');
					const sttMs = performance.now() - tStt;
					let say: string | null;
					let llmMs = 0;
					if (args.simModel) {
						simExchange.push({ speaker: 'caller', text: heard.text });
						if (simTurns >= NEXUS_IMITATION.maxTurns) {
							say = 'Thanks for calling — goodbye.';
						} else {
							const tLlm = performance.now();
							const r = await agentReply(NEXUS_IMITATION, simExchange, personaRunner);
							llmMs = performance.now() - tLlm;
							say = r.text;
							simLog.push({ atMs: clock(), sttMs, llmMs, prompt: r.prompt, raw: r.raw });
							simExchange.push({ speaker: 'agent', text: say });
							simTurns++;
						}
					} else {
						const reply = step(memory, heard.text, defects, scenario.simScript);
						memory = reply.memory;
						say = reply.say;
					}
					simHeard.push({ atMs: clock(), heard: heard.text, replied: say });
					const tTts = performance.now();
					if (say !== null && say.length > 0) await speak(say);
					const ttsMs = performance.now() - tTts;
					note(
						'sim',
						'turn',
						`stt=${sttMs.toFixed(0)}ms llm=${llmMs.toFixed(0)}ms tts=${ttsMs.toFixed(0)}ms heard="${heard.text.slice(0, 40)}"`,
					);
				} catch (e) {
					note('sim', 'stt-error', e instanceof Error ? e.message : String(e));
				}
				busy = false;
			}
		}
	}

	// ---- bench leg: speak the scenario, transcribe what comes back --------
	async function runBench(session: TransportSession): Promise<void> {
		sessions.bench = session;
		const detector = new EnergyTurnDetector(turnCfg);
		let buffer: Array<{ bytes: Uint8Array; atMs: number }> = [];
		let lineIndex = 0;
		let speechStartMs: number | null = null;
		let deadAir: ReturnType<typeof setTimeout> | null = null;
		let transcribing = false;

		// HALF-DUPLEX DISCIPLINE (rehearsal finding, take 4b32210d): after the
		// caller speaks it WAITS for the far end and never advances the
		// conversation on a timer — two autonomous agents that each generate new
		// speech on silence talk straight over each other, which against a real
		// shop is the caller barrelling over the agent's reply. Dead-air is a
		// two-strike fallback, not a turn: strike one is a fixed, reviewed nudge
		// ("Hello? You still there?"); strike two ends the call, which grades
		// INCONCLUSIVE (a call that stalled is a real, honest outcome). Neither
		// strike pulls the next persona line or probe — only HEARING a far-end
		// turn does that (the STT-complete path calls speakNext).
		let deadAirStrikes = 0;
		const armDeadAir = () => {
			if (deadAir) clearTimeout(deadAir);
			deadAir = setTimeout(async () => {
				deadAirStrikes++;
				if (deadAirStrikes === 1) {
					note('bench', 'dead-air-nudge', `no reply within ${DEAD_AIR_MS}ms`);
					const u = await synth('Hello? Are you still there?', BENCH_VOICE);
					const startMs = clock();
					turnDrafts.push({
						speaker: 'bench',
						text: 'Hello? Are you still there?',
						startMs,
						endMs: startMs + durationMs(u),
						confidence: null,
						provider: 'scripted/nudge',
					});
					benchOutbound.push({ pcm: u.pcm, atMs: startMs });
					for (const f of toMulawFrames(u)) session.sendAudio(f);
					detector.reset();
					buffer = [];
					speechStartMs = null;
					setTimeout(armDeadAir, durationMs(u));
				} else {
					note('bench', 'dead-air-giveup', 'far end silent after a nudge — ending, INCONCLUSIVE');
					setTimeout(finishRun, 1000);
				}
			}, DEAD_AIR_MS);
		};

		// Persona-mode state: the probe queue the harness OWNS (spoken verbatim,
		// in order, after free conversation ends), the free-turn budget, and the
		// prompt/reply log persisted beside the take for review.
		const probes = probeLines(scenario);
		let probeIndex = 0;
		let freeTurns = 0;
		let personaDone = false;

		/** The next caller line: scripted cursor, or the persona loop — free
		 * improvisation until DONE/budget, then the probes, then hang up. */
		const chooseNextLine = async (): Promise<string | null> => {
			if (!args.persona) {
				return lineIndex < callerLines.length ? (callerLines[lineIndex++] as string) : null;
			}
			const persona = scenario.persona;
			if (!persona) throw new Error(`scenario "${scenario.name}" has no persona`);
			// A probe fires at its MILESTONE, not at conversation end: the first
			// persona take let the goal complete, the far end said goodbye, and the
			// probe played into dead air (take baa62100). The windshield probes
			// anchor to the quote, so once a price is on the record the harness
			// takes the floor ahead of the model.
			const priceHeard = turnDrafts.some((t) => t.speaker === 'target' && /\$\s?\d/.test(t.text));
			if (probeIndex < probes.length && priceHeard) {
				const probe = probes[probeIndex++] as { say: string; probe: string };
				note('bench', 'probe-injected', `${probe.probe} (at milestone)`);
				return probe.say;
			}
			if (!personaDone && freeTurns < persona.maxFreeTurns) {
				const exchange: ExchangeTurn[] = turnDrafts
					.sort((a, b) => a.startMs - b.startMs)
					.map((t) => ({ speaker: t.speaker === 'bench' ? 'caller' : 'agent', text: t.text }));
				const tLlm = performance.now();
				const step = await nextLine(persona, exchange, probes.length - probeIndex, personaRunner);
				const llmMs = performance.now() - tLlm;
				personaLog.push({ atMs: clock(), llmMs, prompt: step.prompt, raw: step.raw });
				note('bench', 'persona-llm', `${llmMs.toFixed(0)}ms`);
				if (step.decision.kind === 'say') {
					freeTurns++;
					return step.decision.text;
				}
				personaDone = true;
				note('bench', 'persona-done', `after ${freeTurns} free turns`);
			}
			if (probeIndex < probes.length) {
				const probe = probes[probeIndex++] as { say: string; probe: string };
				note('bench', 'probe-injected', probe.probe);
				return probe.say;
			}
			return null;
		};

		const speakNext = async () => {
			if (deadAir) clearTimeout(deadAir);
			const text = await chooseNextLine();
			if (text === null) {
				// Everything said and the last reply (if any) transcribed: done
				// after a short grace for tail audio.
				setTimeout(finishRun, 2000);
				return;
			}
			const clean = await synth(text, BENCH_VOICE);
			void lineIndex; // scripted-mode cursor; persona mode tracks its own state
			// The gradient knob: the caller's voice leaves ALREADY degraded, so the
			// sim leg's STT hears exactly what a bad line would carry. Deterministic
			// per seed; the clean render stays cached and untouched (a take, with
			// its provenance, never a mutation of source).
			const u: Utterance =
				args.degradeSnrDb === null
					? clean
					: { ...clean, pcm: processBuffer(clean.pcm, babble(args.degradeSnrDb, 0xca11)) };
			const startMs = clock();
			turnDrafts.push({
				speaker: 'bench',
				text,
				startMs,
				endMs: startMs + durationMs(u),
				confidence: null,
				// Model judgment travels labeled: an improvised line is the
				// persona's, never mistaken for the script's.
				provider: args.persona
					? `persona:${personaRunner.id}/${u.provider}`
					: `scripted/${u.provider}`,
			});
			benchOutbound.push({ pcm: u.pcm, atMs: startMs });
			for (const f of toMulawFrames(u)) session.sendAudio(f);
			note('bench', 'spoke', text);
			detector.reset();
			buffer = [];
			speechStartMs = null;
			// Wait out our own playback before arming the dead-air timer.
			setTimeout(armDeadAir, durationMs(u));
		};

		for await (const ev of session.events) {
			if (ev.type === 'started') {
				note('bench', 'started');
				continue;
			}
			if (ev.type !== 'audio') {
				note('bench', ev.type, ev.type === 'error' ? ev.reason : undefined);
				continue;
			}
			benchInbound.push({ bytes: ev.bytes, atMs: ev.atMs });
			buffer.push({ bytes: ev.bytes, atMs: ev.atMs });
			const turn = detector.push(ev.bytes, ev.atMs);
			if (turn?.type === 'speech-start') {
				speechStartMs = turn.atMs;
				// The far end is speaking: not dead air. Clear the timer and reset
				// the strike count — a slow-but-present reply must not accrue toward
				// give-up, and a nudge must never fire over a real answer.
				deadAirStrikes = 0;
				if (deadAir) clearTimeout(deadAir);
			}
			if (turn?.type === 'turn-end' && !transcribing) {
				transcribing = true;
				const startedAt = speechStartMs ?? buffer[0]?.atMs ?? turn.atMs;
				// Transcribe ONLY the spoken span (a 300ms lead-in for the attack of
				// the first word). The buffer holds every frame since our own line —
				// including seconds of dead air while the far end thinks — and
				// Whisper on long leading silence invents text at rock-bottom
				// confidence ("Thanks for watching…"), which is how a clean take
				// graded INCONCLUSIVE (take 6be6150d: 0.00–0.14 vs 0.79–0.88 on the
				// same conversation one take earlier).
				const sliceFrom = startedAt - 300;
				const pcmChunks = buffer
					.filter((b) => b.atMs >= sliceFrom)
					.map((b) => decodeMulaw(b.bytes));
				const pcm = new Int16Array(pcmChunks.reduce((n, c) => n + c.length, 0));
				let off = 0;
				for (const c of pcmChunks) {
					pcm.set(c, off);
					off += c.length;
				}
				try {
					const heard = await stt.transcribe(pcm16ToWav(pcm), 'audio/wav');
					if (heard.text.trim().length > 0) {
						turnDrafts.push({
							speaker: 'target',
							text: heard.text.trim(),
							startMs: startedAt,
							endMs: turn.atMs,
							confidence: turnConfidence(heard),
							provider: heard.provider,
						});
						note('bench', 'heard', heard.text.trim());
					} else {
						note('bench', 'heard-nothing', 'stt returned empty text');
					}
				} catch (e) {
					note('bench', 'stt-error', e instanceof Error ? e.message : String(e));
				}
				transcribing = false;
				await speakNext();
			}
		}
	}

	const safely = (name: string, p: Promise<void>) =>
		p.catch((e: unknown) => {
			console.error(`${name}  : leg failed: ${e instanceof Error ? e.message : e}`);
			finishRun();
		});

	const endpoint = await serveTwilioMedia({
		port: PORT,
		routes: {
			'/bench-media': {
				onSession: (s) => void safely('bench', runBench(s)),
				onSessionError: (e) => console.error(`bench : handshake failed: ${e.message}`),
				sessionOptions: { now: clock, zero: 0, anchorEpochMs, pacerLeadMs: 400 },
			},
			'/sim-media': {
				onSession: (s) => void safely('sim', runSim(s)),
				onSessionError: (e) => console.error(`sim   : handshake failed: ${e.message}`),
				// 400ms lead, measured not guessed: see TwilioSessionOptions.pacerLeadMs.
				sessionOptions: { now: clock, zero: 0, anchorEpochMs, pacerLeadMs: 400 },
			},
		},
	});
	console.log(`local  : :${PORT} (/bench-media, /sim-media)`);

	const tunnel = await startTunnel(PORT);
	console.log(`tunnel : ${tunnel.host}`);
	endpoint.server.on('request', (req, res) => {
		if (req.url?.startsWith('/sim-twiml')) {
			res.writeHead(200, { 'Content-Type': 'text/xml' });
			res.end(
				`<Response><Connect><Stream url="wss://${tunnel.host}/sim-media"/></Connect></Response>`,
			);
			return;
		}
		res.writeHead(404).end();
	});
	const ready = await waitForTunnel(tunnel.host, '/__ready');
	if (ready === null) {
		tunnel.stop();
		await endpoint.close();
		throw new Error('Tunnel never carried a WebSocket. Not dialing.');
	}
	console.log(`ready  : tunnel live after ${ready.toFixed(1)}s`);

	const owned = await api(sid, token, `/Accounts/${sid}/IncomingPhoneNumbers.json`);
	const simNumber = (owned.incoming_phone_numbers as Array<Record<string, unknown>>).find(
		(n) => n.phone_number === to,
	);
	if (!simNumber) throw new Error(`loopback number ${to} is not owned by this account`);
	await api(
		sid,
		token,
		`/Accounts/${sid}/IncomingPhoneNumbers/${simNumber.sid}.json`,
		new URLSearchParams({ VoiceUrl: `https://${tunnel.host}/sim-twiml`, VoiceMethod: 'POST' }),
	);
	console.log(`config : ${to} VoiceUrl -> https://${tunnel.host}/sim-twiml`);

	console.log(
		`\nDialing ${to} from ${from} — scenario "${scenario.name}"` +
			`${args.defect ? ` with defect ${args.defect}` : ''}. One call, no retry. No phone rings.`,
	);
	const placed = await placeCall(sid, token, {
		to,
		from,
		twiml: `<Response><Connect><Stream url="wss://${tunnel.host}/bench-media"/></Connect></Response>`,
	});
	const callSid = String(placed.sid);
	console.log(`call   : ${callSid} [${placed.status}]`);

	// Twilio's own dual-channel recording of the same call — the known-good
	// reference our capture is A/B'd against (both ends are ours; consent is
	// not in question). If its agent channel is clean where ours crackles, the
	// defect is in our receive/assembly path; if it crackles too, the defect is
	// upstream in the send path (TTS → pacer → encode).
	let recordingSid: string | null = null;
	// A queued call is "not eligible for recording" (Twilio 21220); it becomes
	// eligible once in-progress. Bounded retry — each failure reported, never
	// silent, and the run proceeds without the reference if all attempts fail.
	for (let attempt = 0; attempt < 6 && recordingSid === null; attempt++) {
		await new Promise((r) => setTimeout(r, 2000));
		try {
			const rec = await api(
				sid,
				token,
				`/Accounts/${sid}/Calls/${callSid}/Recordings.json`,
				new URLSearchParams({ RecordingChannels: 'dual' }),
			);
			recordingSid = String(rec.sid);
			console.log(`record : ${recordingSid} [dual-channel, Twilio-side, attempt ${attempt + 1}]`);
		} catch (e) {
			console.error(
				`record : attempt ${attempt + 1} failed (${e instanceof Error ? e.message : e})`,
			);
		}
	}

	let cleanedUp = false;
	const cleanup = async () => {
		if (cleanedUp) return;
		cleanedUp = true;
		sessions.bench?.end();
		sessions.sim?.end();
		await hangUp(sid, token, callSid);
		tunnel.stop();
		await endpoint.close();
	};
	const onSignal = () => {
		console.log('\nsignal : interrupted — hanging up the live call before exit');
		void cleanup().finally(() => process.exit(130));
	};
	process.once('SIGINT', onSignal);
	process.once('SIGTERM', onSignal);

	try {
		const capped = setTimeout(() => {
			console.log('cap    : wall clock reached — ending');
			finishRun();
		}, WALL_CAP_MS);
		await finished;
		clearTimeout(capped);
	} finally {
		process.off('SIGINT', onSignal);
		process.off('SIGTERM', onSignal);
		await cleanup();
	}

	// ---- freeze ------------------------------------------------------------
	// Shift everything onto the audio's timeline: t=0 is the first inbound
	// frame, so a turn's startMs is an offset into the WAV. Frames are PLACED
	// at their stamps (gaps become silence), keeping span↔audio alignment a
	// property of the capture, not a correction applied later.
	const firstIn = benchInbound[0]?.atMs ?? Number.POSITIVE_INFINITY;
	const firstOut = benchOutbound[0]?.atMs ?? Number.POSITIVE_INFINITY;
	const wavZero = Number.isFinite(Math.min(firstIn, firstOut)) ? Math.min(firstIn, firstOut) : 0;
	const lastIn = benchInbound[benchInbound.length - 1];
	const lastOut = benchOutbound[benchOutbound.length - 1];
	const totalMs = Math.max(
		lastIn ? lastIn.atMs - wavZero + 20 : 0,
		lastOut ? lastOut.atMs - wavZero + Math.round((lastOut.pcm.length / 8000) * 1000) : 0,
	);
	const inboundPcm = new Int16Array(Math.ceil((totalMs / 1000) * 8000));
	// Contiguous within a burst, stamped across gaps. Placing every frame at
	// its own rounded stamp tears the waveform at each 20ms seam (stamp jitter
	// lands frames a few samples off the previous frame's end) — measured on
	// take 23953f88: 1365 clicks in speech, 918 of them spaced at multiples of
	// 20ms, heard as constant crackle. Within ±3 frames of the expected next
	// sample the frame APPENDS; only a larger deviation (true silence) jumps
	// to its stamp, so long-run alignment still comes from the stamps.
	let cursor = -1;
	for (const f of benchInbound) {
		const stamped = Math.round(((f.atMs - wavZero) / 1000) * 8000);
		const at = cursor >= 0 && Math.abs(stamped - cursor) <= 160 * 3 ? cursor : stamped;
		const pcm = decodeMulaw(f.bytes);
		if (at + pcm.length <= inboundPcm.length) inboundPcm.set(pcm, at);
		cursor = at + pcm.length;
	}
	// Mix the bench's own voice in additively (the two never overlap in a
	// lockstep exchange, but clipping-safe addition costs nothing).
	for (const u of benchOutbound) {
		const at = Math.round(((u.atMs - wavZero) / 1000) * 8000);
		for (let i = 0; i < u.pcm.length && at + i < inboundPcm.length; i++) {
			const mixed = (inboundPcm[at + i] ?? 0) + (u.pcm[i] ?? 0);
			inboundPcm[at + i] = Math.max(-32768, Math.min(32767, mixed));
		}
	}
	const transcript = new Transcript(anchorEpochMs + Math.round(wavZero));
	for (const t of [...turnDrafts].sort((a, b) => a.startMs - b.startMs)) {
		transcript.append({
			speaker: t.speaker,
			text: t.text,
			startMs: Math.max(0, Math.round(t.startMs - wavZero)),
			endMs: Math.max(0, Math.round(t.endMs - wavZero)),
			confidence: t.confidence,
			provider: t.provider,
		});
	}
	const frozen = transcript.freeze();
	const wav = pcm16ToWav(inboundPcm);

	const dir = join('data', 'live-sim', String(anchorEpochMs));
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'transcript.json'), JSON.stringify(frozen, null, 1));
	writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
	writeFileSync(join(dir, 'bench-heard.wav'), wav);
	if (personaLog.length > 0) {
		writeFileSync(join(dir, 'persona-log.json'), JSON.stringify(personaLog, null, 1));
	}
	if (simLog.length > 0) {
		writeFileSync(join(dir, 'sim-agent-log.json'), JSON.stringify(simLog, null, 1));
	}
	writeFileSync(
		join(dir, 'meta.json'),
		JSON.stringify(
			{
				scenario: scenario.name,
				defect: args.defect,
				degradeSnrDb: args.degradeSnrDb,
				callSid,
				from,
				to,
				anchorEpochMs,
				transcriptHash: frozen.hash,
				simHeard,
			},
			null,
			1,
		),
	);
	console.log(
		`\n=== frozen: ${dir} (${frozen.turns.length} turns, hash ${frozen.hash.slice(0, 12)}) ===`,
	);

	// Fetch Twilio's recording of the take (bounded poll — it lands seconds
	// after hang-up). Reference material for the A/B, saved beside our capture.
	if (recordingSid) {
		for (let attempt = 0; attempt < 10; attempt++) {
			await new Promise((r) => setTimeout(r, 3000));
			try {
				const res = await fetch(
					`https://api.twilio.com/2010-04-01/Accounts/${sid}/Recordings/${recordingSid}.wav?RequestedChannels=2`,
					{
						headers: {
							Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
						},
					},
				);
				if (res.ok) {
					const bytes = new Uint8Array(await res.arrayBuffer());
					writeFileSync(join(dir, 'twilio-recording.wav'), bytes);
					console.log(`record : saved twilio-recording.wav (${bytes.length} bytes)`);
					break;
				}
			} catch {
				// not ready yet — poll again within the bound
			}
		}
	}

	// ---- assess (offline, over the frozen artifact) ------------------------
	let report: ScenarioReport;
	try {
		report = args.judge
			? await assess(scenario, frozen, { runner: claudeRunner('sonnet'), cache: new MapCache() })
			: await assess({ ...scenario, judged: [] }, frozen);
	} catch (e) {
		if (args.judge && e instanceof RunnerError) {
			// The judged assertions must not VANISH from the artifact (red-team,
			// 07-16): a dropped check reads as "never existed" where the truth is
			// "could not be evaluated" — exactly what INCONCLUSIVE is for. Record
			// a harness abstention per judged assertion, with the failure named.
			console.error(`judge  : runner failed (${e.message}) — recording judged abstentions`);
			const codeOnly = await assess({ ...scenario, judged: [] }, frozen);
			const verdicts = (scenario.judged ?? []).map((j) => ({
				outcome: 'INCONCLUSIVE' as const,
				assertion: j.rubric.name,
				reasoning: `the judge runner failed before a verdict was reached: ${e.message}`,
				span: null,
				judgedBy: 'harness',
				rubricVersion: j.rubric.version,
				cached: false,
			}));
			report = {
				...codeOnly,
				verdicts,
				counts: {
					...codeOnly.counts,
					INCONCLUSIVE: codeOnly.counts.INCONCLUSIVE + verdicts.length,
				},
			};
		} else {
			throw e;
		}
	}
	const rendered = renderScenarioReport(report);
	writeFileSync(join(dir, 'report.txt'), rendered);
	console.log(`\n${rendered}`);
	console.log('\nsim-side hearing (divergence check):');
	for (const h of simHeard) console.log(`  heard "${h.heard}" -> ${h.replied ?? 'SILENCE'}`);

	// ---- publish for the UI -------------------------------------------------
	// A full RunArtifact (run.json + the real WAV, hash-frozen) into the web
	// app's runs directory, so the finding is LISTENABLE: click it, hear the
	// span. `synthetic: null` — this is a real capture off the wire, the first.
	const audioSha = createHash('sha256').update(wav).digest('hex');
	const artifact = buildRunArtifact(scenario.name, 'simulator', frozen, report, anchorEpochMs, {
		file: 'call.wav',
		sampleRate: 8000,
		channels: 1,
		durationMs: Math.round(totalMs),
		sha256: audioSha,
		// A real capture off the wire — of a call whose two voices are themselves
		// synthesized. The artifact contract reserves `null` for a target with a
		// microphone, so the provenance string carries the honest description
		// (same wording as publish-live-run.ts; the two publish paths must agree).
		synthetic: 'live Twilio wire capture; both voices kokoro-82m over 8kHz mulaw',
	});
	// Working takes land under gitignored data/ — the committed fixtures dir is
	// CURATED, by a deliberate publish-live-run.ts act, never by every run
	// (auto-publishing tripped the fixture-count pins the moment a batch ran;
	// the suite caught it). Point the web app here with CALLBENCH_RUNS_DIR to
	// browse the raw takes.
	const runDir = join('data', 'live-sim', 'runs', scenario.name, runIdOf(frozen));
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, 'call.wav'), wav);
	writeRunArtifact(runDir, artifact);
	console.log(`\npublished: ${runDir} — open the run in the web UI to listen`);
}

main().catch((e: unknown) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
