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
 * Turn-taking policy (recorded in meta.json per take):
 *   --sim-barge-in yield|hold     shop concedes the floor on overtalk (default yield)
 *   --bench-barge-in yield|hold   caller concedes; probes always play out (default hold)
 *   --provisional-ms N            advisory endpoint window override
 *   --confirm-ms N                confirmed endpoint window override
 *
 * Output: data/live-sim/<epoch>/ — transcript.json (hashed+frozen), the bench-
 * heard audio as WAV, events.jsonl, meta.json (what the sim THOUGHT it heard,
 * per turn, for divergence analysis), and report.txt from the assessment.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { babble, processBuffer } from '@callbench/audioqc';
import { claudeRunner, MapCache, RunnerError, resolveRunner } from '@callbench/judge';
import {
	agentReply,
	agentReplyStreaming,
	allScenarios,
	assess,
	buildRunArtifact,
	type ExchangeTurn,
	NEXUS_IMITATION,
	nextLineStreaming,
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
	encodePcm,
	serveTwilioMedia,
	type TransportEvent,
	type TransportSession,
} from '@callbench/transport';
import { durationMs, ModalKokoroTts, toMulawFrames, type Utterance } from '@callbench/tts';
import { DEFAULT_TURN_CONFIG, EnergyTurnDetector, frameEnergy } from '@callbench/turn';
import { startTunnel, waitForTunnel } from './lib/tunnel.ts';
import {
	twilioApi as api,
	assertDialAllowed,
	dialSystemUnderTest,
	hangUp,
	placeCall,
	requireAccountSid,
	required,
} from './lib/twilio.ts';

const PORT = 8791;

/** Concatenate the mulaw frames at or after `sliceFrom` into one PCM span —
 * the spoken portion of a turn, with its 300ms lead-in, ready for STT. */
function slicePcm(
	frames: ReadonlyArray<{ bytes: Uint8Array; atMs: number }>,
	sliceFrom: number,
): Int16Array {
	const chunks = frames.filter((b) => b.atMs >= sliceFrom).map((b) => decodeMulaw(b.bytes));
	const pcm = new Int16Array(chunks.reduce((n, c) => n + c.length, 0));
	let off = 0;
	for (const c of chunks) {
		pcm.set(c, off);
		off += c.length;
	}
	return pcm;
}
/** Speech is slower than tones: 4 caller turns + STT round trips. Hard stop.
 * Clamped: a garbage env value falls back to the default rather than removing
 * the wall bound (or firing it at 0), and no override exceeds 30 minutes. */
const WALL_CAP_MS = (() => {
	const n = Number(process.env.CALLBENCH_WALL_CAP_MS ?? 240_000);
	return Number.isFinite(n) && n > 0 ? Math.min(n, 1_800_000) : 240_000;
})();
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
	/** Turn-taking policy per leg: on a barge-in (the other side starts talking
	 * over this leg's playing audio), does this leg CONCEDE the floor — flush
	 * its queued audio mid-line — or keep talking? Real agents yield, so the
	 * sim defaults to yield; the bench defaults to hold. The bench's PROBES are
	 * exempt from yield by construction, whatever the policy — a probe
	 * interrupted is a probe untested. Recorded in meta per take. */
	simBargeIn: 'yield' | 'hold';
	benchBargeIn: 'yield' | 'hold';
	/** Endpointing window overrides (ms), both legs — the experiment knobs the
	 * offline endpointing replay sweeps without a code edit. null = defaults. */
	provisionalMs: number | null;
	confirmMs: number | null;
	/** Quiet-gate hold (ms): silence required of the far end AT THE MOMENT a
	 * generated line is about to leave, on top of the endpointing confirm
	 * window. 0 disables the gate (the "after-only" arm of the experiment). */
	quietMs: number;
	/** THE REAL CALL: dial CALLBENCH_TARGET_NUMBER instead of the owned loop.
	 * Single leg (the real business answers — no sim), dialed through
	 * `dialSystemUnderTest`, which demands a confirmation typed live at an
	 * interactive terminal. Excludes --sim-model and --defect by construction. */
	target: boolean;
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
	const bargeIn = (flag: string, dflt: 'yield' | 'hold'): 'yield' | 'hold' => {
		const v = val(flag);
		if (v === undefined) return dflt;
		if (v !== 'yield' && v !== 'hold') throw new Error(`${flag} must be "yield" or "hold"`);
		return v;
	};
	const ms = (flag: string): number | null => {
		const v = val(flag);
		if (v === undefined) return null;
		const n = Number(v);
		if (!Number.isFinite(n) || n <= 0) throw new Error(`${flag} must be a positive number of ms`);
		return n;
	};
	const target = a.includes('--target');
	if (target && (a.includes('--sim-model') || defect)) {
		throw new Error(
			'--target dials the real system under test: --sim-model and --defect do not apply',
		);
	}
	return {
		scenario: val('--scenario') ?? 'windshield-quote',
		defect: defect as Args['defect'],
		judge: !a.includes('--no-judge'),
		persona: a.includes('--persona'),
		simModel: a.includes('--sim-model'),
		degradeSnrDb: degrade !== undefined ? Number(degrade) : null,
		simBargeIn: bargeIn('--sim-barge-in', 'yield'),
		benchBargeIn: bargeIn('--bench-barge-in', 'hold'),
		provisionalMs: ms('--provisional-ms'),
		confirmMs: ms('--confirm-ms'),
		quietMs: val('--quiet-ms') !== undefined ? Number(val('--quiet-ms')) : 400,
		target,
	};
}

const HOST_IS_LE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

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
	// The samples are already little-endian Int16 in memory on an LE host — one
	// bulk copy instead of a per-sample write (measured 4.7× at call scale,
	// byte-identical); the guard keeps big-endian hosts correct.
	if (HOST_IS_LE) {
		buf.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 44);
	} else {
		for (let i = 0; i < pcm.length; i++) buf.writeInt16LE(pcm[i] ?? 0, 44 + i * 2);
	}
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
	// Target mode dials the real system under test; its gate lives in
	// `dialSystemUnderTest` (typed confirmation at the moment of the dial).
	// The loopback path keeps its own ownership gate.
	const to = args.target
		? required('CALLBENCH_TARGET_NUMBER')
		: required('CALLBENCH_LOOPBACK_NUMBER');
	if (!args.target) await assertDialAllowed(sid, token, to);

	const stt = new ModalWhisperStt(required('MODAL_STT_URL'), process.env.STT_API_KEY);
	const tts = new ModalKokoroTts(required('MODAL_TTS_URL'), process.env.TTS_API_KEY);
	// The persona's model — the judge package's runner plumbing, reused as an
	// isolated named stage. Its id lands on every improvised turn's provider.
	// CALLBENCH_PERSONA_RUNNER picks it: default claude:sonnet (subprocess, the
	// measured 4.7s block), or openai:<model> for the streaming Modal-vLLM fast
	// path — a config swap, no code change. claudeRunner default keeps existing
	// behavior when the var is unset.
	const personaRunner = process.env.CALLBENCH_PERSONA_RUNNER
		? resolveRunner(process.env.CALLBENCH_PERSONA_RUNNER)
		: claudeRunner('sonnet');
	const personaLog: Array<{
		atMs: number;
		llmMs?: number;
		/** Stream start → first clause handed to TTS; null on a non-streaming
		 * runner or a reply whose boundary never confirmed mid-stream. */
		firstClauseMs?: number;
		prompt: string;
		raw: string;
	}> = [];

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
	// Precedence: defaults < scenario override < explicit experiment flag.
	const turnCfg = {
		...DEFAULT_TURN_CONFIG,
		...scenario.turnConfig,
		...(args.provisionalMs !== null ? { provisionalSilenceMs: args.provisionalMs } : {}),
		...(args.confirmMs !== null ? { confirmSilenceMs: args.confirmMs } : {}),
	};

	const simExchange: ExchangeTurn[] = [];
	const simLog: Array<{
		atMs: number;
		sttMs?: number;
		llmMs?: number;
		firstClauseMs?: number;
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
		/** Speech frames that arrived WHILE a reply cycle was already running —
		 * the caller has said something newer. Replying to the old utterance
		 * anyway is how the sim fell turns behind and answered ever-staler
		 * input (the death spiral, take 1784214738140). */
		let freshSpeechMsDuringCycle = 0;
		/** STT started at turn-maybe-end, discarded on turn-resumed. */
		let speculativeStt: Promise<SttResult> | null = null;
		/** Session-clock time our queued audio finishes playing on the wire —
		 * the window in which far-end speech is a barge-in we must yield to. */
		let speakingUntil = 0;
		/** Speech-start moment while we were speaking: a barge-in CANDIDATE. The
		 * flush waits for ~80ms of sustained speech (endpointing research,
		 * 2026-07-16) so a pop or breath never cancels a reply. */
		let bargeCandidateMs: number | null = null;
		/** The far end's last speech frame, updated continuously. The QUIET GATE:
		 * between deciding to reply (turn-end) and the audio leaving, 1-3s of
		 * pipeline pass — if the far end resumed in that gap, speaking anyway is
		 * how two agents talk over each other (maintainer-heard, take
		 * 1784211829214). No new line leaves until they are quiet RIGHT NOW. */
		let lastFarSpeechMs = -Infinity;
		const waitForQuiet = async (leg: string) => {
			// The agent is MORE patient than the caller (+300ms): both gates measure
			// RECEIVED audio, and Twilio transit lags ~200-400ms, so symmetric gates
			// let both sides start into each other's still-in-flight speech (the
			// 200-440ms double-starts, takes 1784213886728 / 1784214499595).
			const QUIET_MS = args.quietMs > 0 ? args.quietMs + 300 : 0;
			if (QUIET_MS <= 0) return;
			const deadline = clock() + 12_000; // bounded: never deadlock a call
			const started = clock();
			while (clock() - lastFarSpeechMs < QUIET_MS && clock() < deadline) {
				await new Promise((r) => setTimeout(r, 50));
			}
			const waited = clock() - started;
			if (waited > 100) note(leg, 'held-for-quiet', `${waited.toFixed(0)}ms`);
		};

		/** A NEW reply supersedes the unplayed tail of the previous one: a real
		 * agent does not keep playing its last sentence after composing a fresh
		 * answer to fresh input. Without this the queue runs many seconds behind
		 * the conversation — the far end hears stale replies, re-asks, collides,
		 * and probe answers die at the back of a flushed backlog (take
		 * 1784213886728). */
		const supersedeBacklog = () => {
			if (speakingUntil > clock() + 500) {
				session.clearAudio();
				note(
					'sim',
					'superseded',
					`flushed ${(speakingUntil - clock()).toFixed(0)}ms of stale backlog`,
				);
				speakingUntil = 0;
			}
		};

		const mergeFrames = (u: Utterance): Uint8Array => {
			const frames = toMulawFrames(u);
			const total = frames.reduce((n, f) => n + f.length, 0);
			const out = new Uint8Array(total);
			let off = 0;
			for (const f of frames) {
				out.set(f, off);
				off += f.length;
			}
			return out;
		};

		const speak = async (text: string) => {
			const u = await synth(text, SIM_VOICE);
			await waitForQuiet('sim'); // LAST before the send — no drift window
			session.sendAudio(mergeFrames(u));
			speakingUntil = clock() + durationMs(u);
			session.sendMark(`sim-${clock().toFixed(0)}`);
		};

		/** Speak a line with STREAMING synthesis: each PCM chunk goes to the wire
		 * the instant Kokoro flushes it (first audio ~a clause before the full
		 * render exists), and the assembled utterance lands in the synth cache for
		 * the repeats the shop is prone to. Cache hits skip the network entirely.
		 * Sends no mark — the caller marks once per turn. */
		const speakStreaming = async (text: string): Promise<void> => {
			await waitForQuiet('sim');
			const key = `${SIM_VOICE} ${text}`;
			const hit = synthCache.get(key);
			if (hit) {
				session.sendAudio(mergeFrames(hit));
				speakingUntil = Math.max(speakingUntil, clock()) + durationMs(hit);
				return;
			}
			const parts: Int16Array[] = [];
			let provider = 'kokoro-stream';
			for await (const chunk of tts.synthesizeStream(text, SIM_VOICE)) {
				if (chunk.sampleRate !== 8000) {
					// Meet the house standard at the source: the wire is 8kHz mulaw
					// and a mid-call resample would mask an upstream contract break.
					throw new Error(`TTS stream returned ${chunk.sampleRate}Hz; the wire is 8000Hz`);
				}
				parts.push(chunk.pcm);
				provider = chunk.provider;
				session.sendAudio(encodePcm(chunk.pcm));
				// Playback extends from wherever the queue currently ends.
				speakingUntil = Math.max(speakingUntil, clock()) + chunk.pcm.length / 8;
			}
			if (parts.length === 0) return;
			const pcm = new Int16Array(parts.reduce((n, c) => n + c.length, 0));
			let off = 0;
			for (const c of parts) {
				pcm.set(c, off);
				off += c.length;
			}
			synthCache.set(key, { pcm, sampleRate: 8000, provider });
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
			if (frameEnergy(ev.bytes) >= turnCfg.speechEnergy) {
				lastFarSpeechMs = ev.atMs;
				if (busy) freshSpeechMsDuringCycle += 20;
			}
			const turn = detector.push(ev.bytes, ev.atMs);
			if (turn?.type === 'speech-start') {
				speechStartMs = turn.atMs;
				// Barge-in policy: the caller started talking while our reply is
				// still playing. Under `yield` (default — the real shop's agent
				// yields) this arms a CANDIDATE; the flush below fires only after
				// sustained speech, so a blip never cancels a reply.
				if (args.simBargeIn === 'yield' && clock() < speakingUntil) {
					bargeCandidateMs = turn.atMs;
				}
			}
			if (bargeCandidateMs !== null) {
				if (clock() >= speakingUntil) {
					bargeCandidateMs = null; // our audio finished; nothing to yield
				} else if (frameEnergy(ev.bytes) < turnCfg.speechEnergy) {
					bargeCandidateMs = null; // a blip, not a barge-in
				} else if (ev.atMs - bargeCandidateMs >= 80) {
					session.clearAudio();
					note(
						'sim',
						'yielded',
						`flushed ${(speakingUntil - clock()).toFixed(0)}ms of queued reply`,
					);
					// The flushed reply never reached the caller — the model must not
					// remember it as said, or it will never re-state it and the caller
					// re-asks forever (the duplicate loop, take 1784214499595).
					const last = simExchange[simExchange.length - 1];
					if (last?.speaker === 'agent') {
						simExchange[simExchange.length - 1] = {
							speaker: 'agent',
							text: `${last.text.split(' ').slice(0, 5).join(' ')}— (you were cut off; the caller did not hear the rest)`,
						};
					}
					speakingUntil = 0;
					bargeCandidateMs = null;
				}
			}
			// Speculative endpointing: STT starts on the ADVISORY end (300ms of
			// silence) and the confirm window (600ms more) runs concurrently with
			// transcription instead of ahead of it. A resume cancels the
			// speculation — the far end was mid-sentence, the transcript is stale.
			if (turn?.type === 'turn-resumed' && speculativeStt !== null) {
				speculativeStt = null;
				note('sim', 'stt-speculation-discarded', 'speech resumed');
			}
			if (turn?.type === 'turn-maybe-end' && !busy) {
				const sliceFrom = (speechStartMs ?? buffer[0]?.atMs ?? turn.atMs) - 300;
				const p = stt.transcribe(pcm16ToWav(slicePcm(buffer, sliceFrom)), 'audio/wav');
				p.catch(() => {}); // a discarded speculation must not crash the run
				speculativeStt = p;
				note('sim', 'stt-speculative', 'started at maybe-end');
			}
			if (turn?.type === 'turn-end' && !busy) {
				busy = true;
				freshSpeechMsDuringCycle = 0;
				// Same silence-trim as the bench leg: transcribe the spoken span only.
				const sliceFrom = (speechStartMs ?? buffer[0]?.atMs ?? turn.atMs) - 300;
				const speculated = speculativeStt;
				speculativeStt = null;
				const pcm = speculated === null ? slicePcm(buffer, sliceFrom) : null;
				buffer = [];
				speechStartMs = null;
				detector.reset();
				try {
					// Per-stage timing — the whole point of the measurement: STT
					// (audio→text), LLM (reasoning), TTS (text→audio) as three
					// separate numbers, so "audio speed vs LLM reasoning speed" is
					// visible per turn, not just a lumped total. sttMs is what the
					// turn PAID waiting — a speculative hit is mostly already done.
					const tStt = performance.now();
					const heard =
						speculated !== null
							? await speculated
							: await stt.transcribe(pcm16ToWav(pcm as Int16Array), 'audio/wav');
					const sttMs = performance.now() - tStt;
					// The caller has already said something newer: this utterance is
					// stale, and the NEXT turn-end carries the conversation. Skip.
					if (freshSpeechMsDuringCycle > 600) {
						note('sim', 'stale-skip', `caller spoke ${freshSpeechMsDuringCycle}ms of newer input`);
						busy = false;
						continue;
					}
					let say: string | null;
					let llmMs = 0;
					let firstClauseMs: number | null = null;
					// The first clause starts STREAMING to the wire mid-LLM-stream:
					// its audio is playing while the model finishes the line.
					let clauseSend: Promise<void> | null = null;
					let restText = '';
					if (args.simModel) {
						simExchange.push({ speaker: 'caller', text: heard.text });
						if (simTurns >= NEXUS_IMITATION.maxTurns) {
							say = 'Thanks for calling — goodbye.';
						} else {
							const tLlm = performance.now();
							const r = await agentReplyStreaming(
								NEXUS_IMITATION,
								simExchange,
								personaRunner,
								(clause) => {
									supersedeBacklog();
									const p = speakStreaming(clause);
									p.catch(() => {}); // surfaced when awaited below
									clauseSend = p;
								},
							);
							llmMs = performance.now() - tLlm;
							say = r.text;
							restText = r.rest;
							firstClauseMs = r.firstClauseMs;
							simLog.push({
								atMs: clock(),
								sttMs,
								llmMs,
								...(firstClauseMs !== null ? { firstClauseMs } : {}),
								prompt: r.prompt,
								raw: r.raw,
							});
							simExchange.push({ speaker: 'agent', text: say });
							simTurns++;
						}
					} else {
						const reply = step(memory, heard.text, defects, scenario.simScript);
						memory = reply.memory;
						say = reply.say;
					}
					simHeard.push({ atMs: clock(), heard: heard.text, replied: say });
					// ttsMs is what the turn PAID after the reply text existed — the
					// clause's synthesis overlapped the LLM stream and isn't re-billed.
					const tTts = performance.now();
					if (clauseSend !== null && say !== null && say.length > 0) {
						await (clauseSend as Promise<void>);
						if (restText.length > 0) await speakStreaming(restText);
						session.sendMark(`sim-${clock().toFixed(0)}`);
					} else if (say !== null && say.length > 0) {
						supersedeBacklog();
						await speakStreaming(say);
						session.sendMark(`sim-${clock().toFixed(0)}`);
					}
					const ttsMs = performance.now() - tTts;
					note(
						'sim',
						'turn',
						`stt=${sttMs.toFixed(0)}ms${speculated !== null ? '(spec)' : ''} llm=${llmMs.toFixed(0)}ms${firstClauseMs !== null ? ` first-clause=${firstClauseMs.toFixed(0)}ms` : ''} tts=${ttsMs.toFixed(0)}ms heard="${heard.text.slice(0, 40)}"`,
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
		/** STT started at turn-maybe-end, discarded on turn-resumed. */
		let speculativeStt: Promise<SttResult> | null = null;
		/** When our queued audio finishes playing, and whether it is a PROBE —
		 * probes are never flushed on barge-in, whatever the policy. */
		let speakingUntil = 0;
		let speakingProbe = false;
		/** The last line this leg spoke, normalized — a verbatim repeat is
		 * suppressed IN CODE (the prompt rule alone gets ignored under
		 * pressure, take 1784214738140): silence-and-wait beats parroting. */
		let lastBenchLineNorm = '';
		/** Barge-in candidate — see the sim leg; same 80ms sustained-speech rule. */
		let bargeCandidateMs: number | null = null;
		/** Where the WIRE's playback cursor sits: audio queues instantly but
		 * plays serially, so records stamped at queue time overlap where the
		 * call never did (maintainer-heard artifact, take 1784212758906). Every
		 * outbound span is stamped at its true play time instead. */
		let wireCursor = 0;
		const stampWire = (durMs: number): number => {
			// +400: the pacer's lead — audio queues that long before the wire
			// plays it (sessionOptions.pacerLeadMs); stamping at queue time put
			// every bench span ~400ms early on the dashboard.
			const at = Math.max(clock() + 400, wireCursor);
			wireCursor = at + durMs;
			return at;
		};
		/** Quiet gate — see the sim leg: no line leaves while the far end is
		 * speaking RIGHT NOW, whatever state the pipeline was in when it decided. */
		let lastFarSpeechMs = -Infinity;
		const waitForQuiet = async () => {
			const QUIET_MS = args.quietMs;
			if (QUIET_MS <= 0) return;
			const deadline = clock() + 12_000; // bounded: never deadlock a call
			const started = clock();
			while (clock() - lastFarSpeechMs < QUIET_MS && clock() < deadline) {
				await new Promise((r) => setTimeout(r, 50));
			}
			const waited = clock() - started;
			if (waited > 100) note('bench', 'held-for-quiet', `${waited.toFixed(0)}ms`);
		};

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
					const startMs = stampWire(durationMs(u));
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
					speakingUntil = startMs + durationMs(u);
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

		/** A persona line whose first clause is ALREADY in synthesis: the clause's
		 * TTS started the moment the model produced it, while the rest of the
		 * reply was still streaming — the turn's audio leaves a clause early. */
		interface StreamedLine {
			text: string;
			clause: string;
			clauseSynth: Promise<Utterance>;
			restSynth: Promise<Utterance> | null;
		}

		/** The next caller line: scripted cursor, or the persona loop — free
		 * improvisation until DONE/budget, then the probes, then hang up. */
		const chooseNextLine = async (): Promise<string | StreamedLine | null> => {
			speakingProbe = false; // set true only on the probe returns below
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
				speakingProbe = true;
				return probe.say;
			}
			if (!personaDone && freeTurns < persona.maxFreeTurns) {
				const exchange: ExchangeTurn[] = [...turnDrafts]
					.sort((a, b) => a.startMs - b.startMs)
					.map((t) => ({ speaker: t.speaker === 'bench' ? 'caller' : 'agent', text: t.text }));
				const tLlm = performance.now();
				// On a streaming runner the first clause goes to TTS mid-stream, so
				// synthesis overlaps the model finishing the reply; a non-streaming
				// runner takes the same call and falls back to the blocking step.
				let firedClause: string | null = null;
				let clauseSynth: Promise<Utterance> | null = null;
				const step = await nextLineStreaming(
					persona,
					exchange,
					probes.length - probeIndex,
					personaRunner,
					(clause) => {
						firedClause = clause;
						clauseSynth = synth(clause, BENCH_VOICE);
					},
				);
				const llmMs = performance.now() - tLlm;
				personaLog.push({
					atMs: clock(),
					llmMs,
					...(step.firstClauseMs !== null ? { firstClauseMs: step.firstClauseMs } : {}),
					prompt: step.prompt,
					raw: step.raw,
				});
				note(
					'bench',
					'persona-llm',
					`${llmMs.toFixed(0)}ms${step.firstClauseMs !== null ? ` first-clause=${step.firstClauseMs.toFixed(0)}ms` : ''}`,
				);
				if (step.alsoDone) {
					// The model appended DONE to its farewell: speak the farewell,
					// then the persona's part is over (probes may still follow).
					personaDone = true;
					note(
						'bench',
						'persona-done',
						`with a spoken farewell, after ${freeTurns + 1} free turns`,
					);
				}
				if (step.decision.kind === 'say') {
					freeTurns++;
					if (firedClause !== null && clauseSynth !== null) {
						return {
							text: step.decision.text,
							clause: firedClause,
							clauseSynth,
							// The tail synthesizes while the clause plays on the wire.
							restSynth: step.rest.length > 0 ? synth(step.rest, BENCH_VOICE) : null,
						};
					}
					return step.decision.text;
				}
				personaDone = true;
				note('bench', 'persona-done', `after ${freeTurns} free turns`);
			}
			if (probeIndex < probes.length) {
				const probe = probes[probeIndex++] as { say: string; probe: string };
				note('bench', 'probe-injected', probe.probe);
				speakingProbe = true;
				return probe.say;
			}
			return null;
		};

		// The gradient knob: the caller's voice leaves ALREADY degraded, so the
		// sim leg's STT hears exactly what a bad line would carry. Deterministic
		// per seed; the clean render stays cached and untouched (a take, with
		// its provenance, never a mutation of source).
		const degrade = (clean: Utterance): Utterance =>
			args.degradeSnrDb === null
				? clean
				: { ...clean, pcm: processBuffer(clean.pcm, babble(args.degradeSnrDb, 0xca11)) };

		const speakNext = async () => {
			if (deadAir) clearTimeout(deadAir);
			const next = await chooseNextLine();
			if (next === null) {
				// Everything said and the last reply (if any) transcribed: done
				// after a short grace for tail audio.
				setTimeout(finishRun, 2000);
				return;
			}
			const candidateNorm = (typeof next === 'string' ? next : next.text).trim().toLowerCase();
			if (!speakingProbe && candidateNorm === lastBenchLineNorm) {
				note('bench', 'repeat-suppressed', candidateNorm.slice(0, 50));
				detector.reset();
				buffer = [];
				speechStartMs = null;
				armDeadAir();
				return;
			}
			lastBenchLineNorm = candidateNorm;
			if (typeof next !== 'string') {
				// Streamed persona line: the first clause's synthesis started while
				// the model was still finishing the reply, and its audio leaves the
				// moment it's ready — the tail synthesizes while the clause plays.
				const cu = degrade(await next.clauseSynth);
				await waitForQuiet(); // LAST before the send — synthesis takes ~1s and the far end may resume inside it (take 1784215619115, 0:40)
				const startMs = stampWire(durationMs(cu));
				benchOutbound.push({ pcm: cu.pcm, atMs: startMs });
				for (const f of toMulawFrames(cu)) session.sendAudio(f);
				note('bench', 'spoke-clause', next.clause);
				let endMs = startMs + durationMs(cu);
				if (next.restSynth !== null) {
					const ru = degrade(await next.restSynth);
					const restStartMs = stampWire(durationMs(ru));
					benchOutbound.push({ pcm: ru.pcm, atMs: restStartMs });
					for (const f of toMulawFrames(ru)) session.sendAudio(f);
					endMs = restStartMs + durationMs(ru);
				}
				turnDrafts.push({
					speaker: 'bench',
					text: next.text,
					startMs,
					endMs,
					confidence: null,
					provider: `persona:${personaRunner.id}/${cu.provider}`,
				});
				note('bench', 'spoke', next.text);
				speakingUntil = endMs;
				detector.reset();
				buffer = [];
				speechStartMs = null;
				setTimeout(armDeadAir, endMs - startMs);
				return;
			}
			const text = next;
			const u = degrade(await synth(text, BENCH_VOICE));
			await waitForQuiet(); // LAST before the send — see the streamed path
			void lineIndex; // scripted-mode cursor; persona mode tracks its own state
			const startMs = stampWire(durationMs(u));
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
			speakingUntil = startMs + durationMs(u);
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
			if (frameEnergy(ev.bytes) >= turnCfg.speechEnergy) lastFarSpeechMs = ev.atMs;
			const turn = detector.push(ev.bytes, ev.atMs);
			if (turn?.type === 'speech-start') {
				speechStartMs = turn.atMs;
				// The far end is speaking: not dead air. Clear the timer and reset
				// the strike count — a slow-but-present reply must not accrue toward
				// give-up, and a nudge must never fire over a real answer.
				deadAirStrikes = 0;
				if (deadAir) clearTimeout(deadAir);
				// Barge-in policy (default hold — a rehearsing caller talks
				// through). Even under yield, a PROBE always plays out in full:
				// a probe flushed mid-line tests nothing, and the frozen
				// transcript must match what was actually spoken.
				if (args.benchBargeIn === 'yield' && !speakingProbe && clock() < speakingUntil) {
					bargeCandidateMs = turn.atMs;
				}
			}
			if (bargeCandidateMs !== null) {
				if (clock() >= speakingUntil || speakingProbe) {
					bargeCandidateMs = null;
				} else if (frameEnergy(ev.bytes) < turnCfg.speechEnergy) {
					bargeCandidateMs = null; // a blip, not a barge-in
				} else if (ev.atMs - bargeCandidateMs >= 80) {
					session.clearAudio();
					note(
						'bench',
						'yielded',
						`flushed ${(speakingUntil - clock()).toFixed(0)}ms of queued line`,
					);
					// The record must not claim we spoke audio the flush swallowed:
					// close our current turn draft at the flush moment and trim the
					// outbound capture to what actually reached the wire.
					for (let i = turnDrafts.length - 1; i >= 0; i--) {
						const d = turnDrafts[i];
						if (d && d.speaker === 'bench') {
							if (d.endMs > clock()) d.endMs = clock();
							break;
						}
					}
					const out = benchOutbound[benchOutbound.length - 1];
					if (out) {
						const played = Math.max(0, Math.round((clock() - out.atMs) * 8));
						if (played < out.pcm.length) out.pcm = out.pcm.slice(0, played);
					}
					speakingUntil = 0;
					bargeCandidateMs = null;
				}
			}
			if (turn?.type === 'turn-resumed' && speculativeStt !== null) {
				speculativeStt = null;
				note('bench', 'stt-speculation-discarded', 'speech resumed');
			}
			if (turn?.type === 'turn-maybe-end' && !transcribing) {
				// Speculative endpointing: transcription starts on the advisory end
				// and runs through the confirm window instead of after it.
				const sliceFrom = (speechStartMs ?? buffer[0]?.atMs ?? turn.atMs) - 300;
				const p = stt.transcribe(pcm16ToWav(slicePcm(buffer, sliceFrom)), 'audio/wav');
				p.catch(() => {}); // a discarded speculation must not crash the run
				speculativeStt = p;
				note('bench', 'stt-speculative', 'started at maybe-end');
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
				const speculated = speculativeStt;
				speculativeStt = null;
				let heardSomething = false;
				try {
					const tStt = performance.now();
					const heard =
						speculated !== null
							? await speculated
							: await stt.transcribe(pcm16ToWav(slicePcm(buffer, startedAt - 300)), 'audio/wav');
					note(
						'bench',
						'stt',
						`${(performance.now() - tStt).toFixed(0)}ms${speculated !== null ? '(spec)' : ''}`,
					);
					if (heard.text.trim().length > 0) {
						heardSomething = true;
						turnDrafts.push({
							speaker: 'target',
							text: heard.text.trim(),
							startMs: startedAt,
							// turn-end FIRES confirmSilenceMs after the last speech frame — the
							// record wants when they STOPPED, or every span drags a silent tail
							// (dashboard skew, real take 1784216848744).
							endMs: turn.atMs - turnCfg.confirmSilenceMs,
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
				// The turn mutex holds through the WHOLE reply pipeline (LLM → TTS →
				// quiet gate → send): a second far-end turn-end during those seconds
				// must not spawn a concurrent reply — that raced two copies of the
				// same line onto the call (take 1784212758906, maintainer-heard).
				// Advance ONLY on a real heard turn. A garbled fragment (a reply
				// truncated by the far end's own yield, a noise burst) must not
				// pull the next caller line — that raced the probe's answer off
				// the record (take 1784211829214). Silence is the dead-air
				// timer's job, not a cue to talk.
				try {
					if (heardSomething) {
						await speakNext();
					} else {
						detector.reset();
						buffer = [];
						speechStartMs = null;
						armDeadAir();
					}
				} finally {
					transcribing = false;
				}
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
			// Target mode has no sim leg — the real business answers.
			...(args.target
				? {}
				: {
						'/sim-media': {
							onSession: (s: TransportSession) => void safely('sim', runSim(s)),
							onSessionError: (e: Error) => console.error(`sim   : handshake failed: ${e.message}`),
							// 400ms lead, measured not guessed: see TwilioSessionOptions.pacerLeadMs.
							sessionOptions: { now: clock, zero: 0, anchorEpochMs, pacerLeadMs: 400 },
						},
					}),
		},
	});
	console.log(`local  : :${PORT} (${args.target ? '/bench-media' : '/bench-media, /sim-media'})`);

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

	if (!args.target) {
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
	}

	const benchStreamXml = `<Response><Connect><Stream url="wss://${tunnel.host}/bench-media"/></Connect></Response>`;
	let placed: Record<string, unknown>;
	if (args.target) {
		// THE REAL CALL. The gate is a human typing at this terminal, right now:
		// nothing else — no flag, env var, or loop — can supply the confirmation.
		if (!process.stdin.isTTY) {
			throw new Error(
				'target mode requires an interactive terminal: the dial starts only from a typed confirmation',
			);
		}
		const expected = `DIAL ${to.replace(/\D/g, '').slice(-4)}`;
		console.log(`\nREAL TARGET: ${to} — this rings the actual business, one call, no retry.`);
		console.log(
			`scenario "${scenario.name}"${args.persona ? ' (persona improvises; probes verbatim)' : ' (scripted)'}`,
		);
		process.stdout.write(`type "${expected}" to dial (anything else aborts): `);
		const typed: string = await new Promise((resolve) =>
			process.stdin.once('data', (d) => resolve(String(d).trim())),
		);
		placed = await dialSystemUnderTest(sid, token, {
			to,
			from,
			twiml: benchStreamXml,
			confirmation: typed,
		});
	} else {
		console.log(
			`\nDialing ${to} from ${from} — scenario "${scenario.name}"` +
				`${args.defect ? ` with defect ${args.defect}` : ''}. One call, no retry. No phone rings.`,
		);
		placed = await placeCall(sid, token, { to, from, twiml: benchStreamXml });
	}
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
				// The turn-taking policy this take was captured under — an A/B of
				// these knobs is unreadable unless every take carries its own.
				policy: {
					simBargeIn: args.simBargeIn,
					benchBargeIn: args.benchBargeIn,
					quietMs: args.quietMs,
					turn: turnCfg,
				},
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
