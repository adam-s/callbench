/**
 * Loopback run: the bench calls the simulator's number, both legs stream into
 * THIS process, tones go both ways, and everything is frozen with stamps.
 *
 * This is Increment 1's "done when": one call to a number we own, audio both
 * ways, a timestamped frozen record. It is also the timing baseline the plan
 * demands: both legs' sessions are given the SAME injected clock, so every
 * atMs — bench and simulator alike — is on one axis, stamped at one layer
 * (our socket read). A duration between legs is same-clock by construction.
 * What the durations mean: the full loop out through Twilio and back to us,
 * i.e. the harness's own overhead floor — not the target's latency.
 *
 * Sequence:
 *   1. serve two media routes on one port, tunnel it, verify the tunnel
 *   2. point the simulator number's VoiceUrl at this tunnel (its own realm:
 *      a REST write, so the change actually sticks)
 *   3. place ONE call from the bench number to the simulator number
 *   4. sim: greet with a 600Hz tone on connect; reply 1000Hz when it hears us
 *      bench: send 440Hz once it hears the greeting
 *   5. freeze both legs' events + audio + timings to data/loopback/<epoch>/,
 *      hang up, exit
 *
 * Bounds: one call, no retry, 75s wall-clock hard stop. Dials ONLY the
 * loopback number and refuses if that equals the system under test.
 *
 * Usage:  node --env-file=.env scripts/loopback-call.ts
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	decodeMulaw,
	serveTwilioMedia,
	type TransportEvent,
	type TransportSession,
	tone,
	toneStrength,
} from '@callbench/transport';
import { startTunnel, waitForTunnel } from './lib/tunnel.ts';
import {
	twilioApi as api,
	assertDialAllowed,
	hangUp,
	requireAccountSid,
	required,
} from './lib/twilio.ts';

const PORT = 8790;
const WALL_CAP_MS = 75_000;
/** Mean |PCM| above this = a voiced frame. Tones sit ~10x higher; the PSTN
 * noise floor sits far below. */
const VOICE_ENERGY = 1000;

function isVoiced(bytes: Uint8Array): boolean {
	const pcm = decodeMulaw(bytes);
	let sum = 0;
	for (const s of pcm) sum += Math.abs(s);
	return sum / pcm.length > VOICE_ENERGY;
}

interface LegRecord {
	leg: 'bench' | 'sim';
	events: Array<{ leg: string; type: string; atMs: number; detail?: string; bytes?: number }>;
	audio: Uint8Array[];
	firstVoicedAtMs: number | null;
	voicedBursts: number[];
}

async function main(): Promise<void> {
	const sid = requireAccountSid();
	const token = required('TWILIO_AUTH_TOKEN');
	const from = required('TWILIO_FROM_NUMBER');
	const to = required('CALLBENCH_LOOPBACK_NUMBER');
	// Ownership-checked destination guard (shared with the probes) — dials only
	// account-owned numbers, no unset-env silent pass.
	await assertDialAllowed(sid, token, to);

	// One clock for everything in this process — the whole point of the run.
	const zero = performance.now();
	const clock = () => performance.now() - zero;
	const anchorEpochMs = Date.now();

	const records: Record<'bench' | 'sim', LegRecord> = {
		bench: { leg: 'bench', events: [], audio: [], firstVoicedAtMs: null, voicedBursts: [] },
		sim: { leg: 'sim', events: [], audio: [], firstVoicedAtMs: null, voicedBursts: [] },
	};
	const marks: Array<{ leg: string; name: string; atMs: number }> = [];
	let benchSentAtMs: number | null = null;
	let simRepliedAtMs: number | null = null;
	let simGreetedAtMs: number | null = null;

	const sessions: Partial<Record<'bench' | 'sim', TransportSession>> = {};
	const done = { bench: false, sim: false };
	let finishRun: () => void = () => {};
	const finished = new Promise<void>((r) => {
		finishRun = r;
	});

	// The tone each leg is WAITING to hear from the other. Detection is
	// frequency-specific (Goertzel), not just "loud", so a leg cannot latch onto
	// an echo of its own tone and report an echo as a round trip — the MEDIUM
	// finding from the red-team. A leg hears its counterpart's tone or it hears
	// nothing; there is no third confidently-wrong reading.
	const EXPECTED_TONE: Record<'bench' | 'sim', number> = { bench: 600, sim: 440 };
	const TONE_THRESHOLD = 0.02;

	function hearsExpectedTone(leg: 'bench' | 'sim', bytes: Uint8Array): boolean {
		return isVoiced(bytes) && toneStrength(bytes, EXPECTED_TONE[leg]) > TONE_THRESHOLD;
	}

	function record(leg: 'bench' | 'sim', ev: TransportEvent): void {
		const rec = records[leg];
		if (ev.type === 'audio') {
			rec.audio.push(ev.bytes);
			rec.events.push({ leg, type: 'audio', atMs: ev.atMs, bytes: ev.bytes.length });
			if (hearsExpectedTone(leg, ev.bytes)) {
				if (rec.firstVoicedAtMs === null) rec.firstVoicedAtMs = ev.atMs;
				rec.voicedBursts.push(ev.atMs);
			}
		} else {
			const detail = ev.type === 'error' ? ev.reason : ev.type === 'mark' ? ev.name : undefined;
			rec.events.push({ leg, type: ev.type, atMs: ev.atMs, ...(detail ? { detail } : {}) });
			if (ev.type === 'mark') marks.push({ leg, name: ev.name, atMs: ev.atMs });
		}
	}

	async function runLeg(leg: 'bench' | 'sim', session: TransportSession): Promise<void> {
		sessions[leg] = session;
		console.log(`${leg}   : session up (${session.sessionId})`);
		let greeted = false;
		let replied = false;
		for await (const ev of session.events) {
			record(leg, ev);
			if (leg === 'sim' && ev.type === 'started' && !greeted) {
				greeted = true;
				simGreetedAtMs = clock();
				session.sendAudio(tone(600, 400));
				session.sendMark('sim-greeting');
			}
			if (leg === 'sim' && ev.type === 'audio' && !replied && hearsExpectedTone('sim', ev.bytes)) {
				replied = true;
				simRepliedAtMs = clock();
				session.sendAudio(tone(1000, 400));
				session.sendMark('sim-reply');
			}
			if (
				leg === 'bench' &&
				ev.type === 'audio' &&
				benchSentAtMs === null &&
				hearsExpectedTone('bench', ev.bytes)
			) {
				benchSentAtMs = clock();
				session.sendAudio(tone(440, 400));
				session.sendMark('bench-probe');
			}
			// The exchange is over once Twilio confirms the sim's reply finished
			// playing; a short grace lets the tail frames reach the bench. (The
			// first run tried to detect "two voiced bursts with a gap" instead —
			// the reply followed the greeting so closely that the bursts merged
			// and the run idled to its cap.)
			if (leg === 'sim' && ev.type === 'mark' && ev.name === 'sim-reply') {
				console.log('sim   : reply played — ending after grace');
				setTimeout(finishRun, 2500);
			}
		}
		done[leg] = true;
		if (done.bench && done.sim) finishRun();
	}

	// A leg coroutine that throws must not become an unhandled rejection —
	// Node ≥15 terminates the process on those, which during the call window
	// would skip the hang-up. Route any leg failure into the normal end path;
	// the finally-block cleanup then hangs up.
	const runLegSafely = (leg: 'bench' | 'sim', s: TransportSession) =>
		runLeg(leg, s).catch((e: unknown) => {
			console.error(`${leg}   : leg failed: ${e instanceof Error ? e.message : e}`);
			finishRun();
		});

	// 1. Serve both legs on one port.
	const endpoint = await serveTwilioMedia({
		port: PORT,
		routes: {
			'/bench-media': {
				onSession: (s) => void runLegSafely('bench', s),
				onSessionError: (e) => console.error(`bench : handshake failed: ${e.message}`),
				sessionOptions: { now: clock, zero: 0, anchorEpochMs },
			},
			'/sim-media': {
				onSession: (s) => void runLegSafely('sim', s),
				onSessionError: (e) => console.error(`sim   : handshake failed: ${e.message}`),
				sessionOptions: { now: clock, zero: 0, anchorEpochMs },
			},
		},
	});
	console.log(`local  : :${PORT} (/bench-media, /sim-media)`);

	// 2. Tunnel, verified before anything dials.
	const tunnel = await startTunnel(PORT);
	console.log(`tunnel : ${tunnel.host}`);

	// TwiML for the simulator's number — served from this same process.
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

	// 3. Point the simulator number at this run's tunnel — through Twilio's own
	// API, so the change sticks (a config written anywhere else is a config
	// that LOOKS applied).
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

	// 4. ONE call: bench dials the simulator. Everything from here is inside a
	// try/finally with a signal handler, because between this dial and the
	// hang-up there is a LIVE CALL. A thrown error, an unhandled leg rejection,
	// or an operator Ctrl-C in this window must still hang up the call and drop
	// the tunnel — leaving a stranger-facing line connected is exactly the
	// failure this bench must never cause, even against a number we own.
	console.log(`\nDialing ${to} from ${from} — one call, no retry. No phone rings.`);
	const placed = await api(
		sid,
		token,
		`/Accounts/${sid}/Calls.json`,
		new URLSearchParams({
			To: to,
			From: from,
			Twiml: `<Response><Connect><Stream url="wss://${tunnel.host}/bench-media"/></Connect></Response>`,
		}),
	);
	const callSid = String(placed.sid);
	console.log(`call   : ${callSid} [${placed.status}]`);

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
	// Ctrl-C during the call window: hang up, then leave.
	const onSignal = () => {
		console.log('\nsignal : interrupted — hanging up the live call before exit');
		void cleanup().finally(() => process.exit(130));
	};
	process.once('SIGINT', onSignal);
	process.once('SIGTERM', onSignal);

	try {
		// 5. Run until the exchange completes, or the cap trips.
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

	// 6. Freeze: events, audio, timings, hashes.
	const dir = join('data', 'loopback', String(anchorEpochMs));
	mkdirSync(dir, { recursive: true });
	const allEvents = [...records.bench.events, ...records.sim.events].sort(
		(a, b) => a.atMs - b.atMs,
	);
	const eventsPath = join(dir, 'events.jsonl');
	writeFileSync(eventsPath, allEvents.map((e) => JSON.stringify(e)).join('\n'));
	const hashes: Record<string, string> = {};
	for (const leg of ['bench', 'sim'] as const) {
		const audio = Buffer.concat(records[leg].audio);
		const p = join(dir, `${leg}-inbound.ulaw`);
		writeFileSync(p, audio);
		hashes[`${leg}-inbound.ulaw`] = createHash('sha256').update(audio).digest('hex');
	}
	hashes['events.jsonl'] = createHash('sha256')
		.update(allEvents.map((e) => JSON.stringify(e)).join('\n'))
		.digest('hex');

	// Timing baseline — every figure below is same-clock (this process's
	// monotonic clock) at same-layer (our socket read / our send call).
	const delta = (a: number | null, b: number | null) =>
		a !== null && b !== null ? +(a - b).toFixed(1) : null;
	const timings = {
		clock: 'one performance.now() axis shared by script and BOTH sessions (zero: 0)',
		layer: 'our socket-message handler (inbound) / our sendAudio call (outbound)',
		// The flagship figure: sim spoke, bench answered by reflex, sim heard the
		// answer — a full out-and-back through Twilio, entirely on one leg's
		// stamps. This is the harness+provider overhead floor, not target latency.
		roundTrip_simSpoke_to_simHeardAnswer_ms: delta(records.sim.firstVoicedAtMs, simGreetedAtMs),
		oneWay_simGreeting_to_benchEar_ms: delta(records.bench.firstVoicedAtMs, simGreetedAtMs),
		oneWay_benchTone_to_simEar_ms: delta(records.sim.firstVoicedAtMs, benchSentAtMs),
		simReplyLatency_ms: delta(simRepliedAtMs, records.sim.firstVoicedAtMs),
		marks,
	};
	writeFileSync(
		join(dir, 'summary.json'),
		JSON.stringify(
			{
				callSid,
				anchorEpochMs,
				events: allEvents.length,
				benchAudioBytes: Buffer.concat(records.bench.audio).length,
				simAudioBytes: Buffer.concat(records.sim.audio).length,
				timings,
				hashes,
			},
			null,
			2,
		),
	);

	console.log(`\n=== frozen: ${dir} ===`);
	console.log(`events            : ${allEvents.length}`);
	console.log(
		`round trip (sim)  : ${timings.roundTrip_simSpoke_to_simHeardAnswer_ms ?? 'NOT MEASURED'} ms`,
	);
	console.log(
		`one-way sim→bench : ${timings.oneWay_simGreeting_to_benchEar_ms ?? 'NOT MEASURED'} ms`,
	);
	console.log(`one-way bench→sim : ${timings.oneWay_benchTone_to_simEar_ms ?? 'NOT MEASURED'} ms`);
	if (
		timings.roundTrip_simSpoke_to_simHeardAnswer_ms === null ||
		timings.oneWay_simGreeting_to_benchEar_ms === null
	) {
		console.log('\nA timing is missing — that is a reported gap, not a number to estimate.');
		process.exit(1);
	}
}

main().catch((e: unknown) => {
	console.error(`\nLoopback run failed: ${e instanceof Error ? e.message : e}`);
	console.error('Not retrying. Surface this to the operator.');
	process.exit(1);
});
