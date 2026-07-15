/**
 * Increment 1, frame-shape probe: what does Twilio actually send us?
 *
 * This CAPTURES; it does not PARSE. The frame shape is the thing we don't know,
 * and `drivers.md` says so explicitly — the 8kHz-mulaw claim there is a label
 * inherited from documentation, not a fact measured off this account. A parser
 * written before this runs would encode the assumption instead of testing it.
 * So: dump every message verbatim, record the event order and the arrival
 * times, and let the next agent read the real bytes.
 *
 * What it does, end to end, in one command:
 *   1. opens a WebSocket server on localhost
 *   2. spawns a cloudflared quick tunnel and reads its public URL
 *   3. places ONE call whose TwiML points a <Connect><Stream> at that URL
 *   4. records what arrives until a cap trips
 *   5. writes the raw capture + a summary, and exits
 *
 * Bounded by construction: one call, no retry, and three independent caps
 * (wall clock, frame count, connection wait). A probe that can hang is a probe
 * that gets run with a `&` and forgotten.
 *
 * This dials CALLBENCH_LOOPBACK_NUMBER — a number the maintainer owns. It must
 * never point at the system under test; the target path is the `live-call`
 * skill, human-gated dial by dial. The check below is not a formality.
 *
 * Usage:
 *   node --env-file=.env scripts/probes/probe-media-stream.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { startTunnel, waitForTunnel } from '../lib/tunnel.ts';

const PORT = 8788;
const API = 'https://api.twilio.com/2010-04-01';

const MEDIA_PATH = '/media';
const READY_PATH = '/__ready';

/** Caps. Each one independently ends the probe. */
const MAX_SECONDS = 45;
const MAX_FRAMES = 400;
const ANSWER_WAIT_MS = 40_000;

type Raw = { at: number; dir: 'in'; text: string };

function required(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`${name} is not set. Run with --env-file=.env`);
	return v;
}

function authHeader(sid: string, token: string): string {
	return `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;
}

async function api(
	path: string,
	auth: string,
	body?: URLSearchParams,
): Promise<Record<string, unknown>> {
	const res = await fetch(`${API}${path}`, {
		method: body ? 'POST' : 'GET',
		headers: {
			Authorization: auth,
			...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
		},
		body,
	});
	const text = await res.text();
	const parsed = JSON.parse(text) as Record<string, unknown>;
	if (!res.ok) {
		throw new Error(`HTTP ${res.status} from ${path}: ${parsed.message ?? text}`);
	}
	return parsed;
}

async function main(): Promise<void> {
	const sid = required('TWILIO_ACCOUNT_SID');
	const token = required('TWILIO_AUTH_TOKEN');
	const from = required('TWILIO_FROM_NUMBER');
	const to = required('CALLBENCH_LOOPBACK_NUMBER');

	if (!sid.startsWith('AC')) {
		throw new Error(
			`TWILIO_ACCOUNT_SID must be the Account SID (starts with AC), got "${sid.slice(0, 2)}..."`,
		);
	}
	// Not a formality: this probe streams audio and writes it to disk. Pointing
	// it at the system under test would be an unapproved dial AND an unapproved
	// capture, in one command, with no human between.
	const target = process.env.CALLBENCH_TARGET_NUMBER;
	if (target && to === target) {
		throw new Error('Refusing: loopback number equals the system under test.');
	}

	const auth = authHeader(sid, token);
	const raws: Raw[] = [];
	let closed = false;

	// 1. WebSocket server. Two paths: READY_PATH answers the readiness probe
	// below, MEDIA_PATH is the real stream. They must not be confused — a
	// readiness connection arriving on the media path would look like Twilio
	// answering and start the capture clock early.
	const http = createServer();
	const wss = new WebSocketServer({ server: http });
	const gotConnection = new Promise<void>((resolve) => {
		wss.on('connection', (socket, req) => {
			if (req.url !== MEDIA_PATH) {
				socket.close(); // readiness probe; not the call
				return;
			}
			console.log('media: websocket connected');
			resolve();
			socket.on('message', (data) => {
				raws.push({ at: Date.now(), dir: 'in', text: data.toString() });
				if (raws.length >= MAX_FRAMES) {
					console.log(`media: frame cap (${MAX_FRAMES}) reached`);
					socket.close();
				}
			});
			socket.on('close', () => {
				console.log('media: websocket closed');
				closed = true;
			});
		});
	});
	await new Promise<void>((r) => http.listen(PORT, r));
	console.log(`local  : ws://localhost:${PORT}`);

	// 2. Tunnel — and then WAIT for it to actually carry traffic.
	const tunnel = await startTunnel(PORT);
	const wsUrl = `wss://${tunnel.host}${MEDIA_PATH}`;
	console.log(`tunnel : ${wsUrl}`);

	const readyAfter = await waitForTunnel(tunnel.host, READY_PATH);
	if (readyAfter === null) {
		tunnel.stop();
		wss.close();
		http.close();
		throw new Error(
			'Tunnel never carried a WebSocket. Not dialing — ' +
				'a call into a dead tunnel is a wasted ring on a real phone.',
		);
	}
	console.log(`ready  : tunnel carried a WebSocket after ${readyAfter.toFixed(1)}s`);

	// 3. One call
	const twiml = `<Response><Connect><Stream url="${wsUrl}"/></Connect></Response>`;
	console.log(`\nDialing ${to} from ${from} — one call, no retry. Answer it and talk.`);
	const started = Date.now();
	const placed = await api(
		`/Accounts/${sid}/Calls.json`,
		auth,
		new URLSearchParams({ To: to, From: from, Twiml: twiml }),
	);
	const callSid = String(placed.sid);
	console.log(`call   : ${callSid} [${placed.status}]`);

	// 4. Capture, with every exit bounded
	const answered = await Promise.race([
		gotConnection.then(() => true),
		new Promise<boolean>((r) => setTimeout(() => r(false), ANSWER_WAIT_MS)),
	]);
	if (!answered) {
		console.log(`\nNo media socket within ${ANSWER_WAIT_MS / 1000}s — the call was not answered,`);
		console.log('or Twilio could not reach the tunnel. Not retrying.');
	} else {
		await Promise.race([
			new Promise<void>((r) => {
				const t = setInterval(() => {
					if (closed) {
						clearInterval(t);
						r();
					}
				}, 200);
			}),
			new Promise<void>((r) => setTimeout(r, MAX_SECONDS * 1000)),
		]);
	}

	tunnel.stop();
	wss.close();
	http.close();
	await api(
		`/Accounts/${sid}/Calls/${callSid}.json`,
		auth,
		new URLSearchParams({ Status: 'completed' }),
	).catch(() => {});

	// 5. Freeze what arrived — verbatim first, interpretation second.
	const dir = join('data', 'probes', `media-${started}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'raw.jsonl'), raws.map((r) => JSON.stringify(r)).join('\n'));

	console.log(`\n=== what actually arrived ===`);
	console.log(`messages: ${raws.length}`);
	if (raws.length === 0) {
		// AGENTS.md: a silent empty result is a re-probe signal, not a fact.
		console.log('\nNOTHING ARRIVED. That is a hypothesis to re-probe, not a finding.');
		console.log('Look at: did the call connect, did cloudflared stay up, did the');
		console.log('TwiML reach Twilio intact. Read the call record before theorising.');
		process.exit(1);
	}

	const byEvent = new Map<string, number>();
	let firstStart: unknown = null;
	for (const r of raws) {
		try {
			const m = JSON.parse(r.text) as Record<string, unknown>;
			const ev = String(m.event ?? '?');
			byEvent.set(ev, (byEvent.get(ev) ?? 0) + 1);
			if (ev === 'start' && !firstStart) firstStart = m;
		} catch {
			byEvent.set('<non-json>', (byEvent.get('<non-json>') ?? 0) + 1);
		}
	}
	console.log('events  :');
	for (const [ev, n] of byEvent) console.log(`  ${ev.padEnd(12)} ${n}`);

	console.log('\n--- first 3 messages, verbatim (truncated at 300 chars) ---');
	for (const r of raws.slice(0, 3)) console.log(`  ${r.text.slice(0, 300)}`);

	if (firstStart) {
		console.log('\n--- the start event, in full: this is the frame-format fact ---');
		console.log(JSON.stringify(firstStart, null, 2));
	}

	// Inter-arrival timing, measured at ONE layer (our socket read) — this is
	// packet cadence, NOT call latency. Do not promote it into a report.
	const media = raws.filter((r) => r.text.includes('"media"'));
	if (media.length > 2) {
		const gaps: number[] = [];
		for (let i = 1; i < media.length; i++) {
			const prev = media[i - 1];
			const cur = media[i];
			if (prev && cur) gaps.push(cur.at - prev.at);
		}
		gaps.sort((a, b) => a - b);
		const p50 = gaps[Math.floor(gaps.length / 2)];
		console.log(
			`\nmedia frames: ${media.length}, inter-arrival p50 ${p50}ms (our read clock, one layer)`,
		);
	}
	console.log(`\nraw capture: ${dir}/raw.jsonl`);
}

main().catch((e: unknown) => {
	console.error(`\nProbe failed: ${e instanceof Error ? e.message : e}`);
	console.error('Not retrying. Surface this to the operator.');
	process.exit(1);
});
