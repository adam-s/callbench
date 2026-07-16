/**
 * Server run-store tests — the read boundary and the fence, both offline.
 *
 * What's pinned:
 *   - the committed fixture runs enumerate and load, with their real counts;
 *   - loading REFUSES a drifted artifact (hash mismatch) and a MISLABELED one
 *     (folder names disagreeing with the artifact's own fields);
 *   - the fence predicate lets only a simulator run be replayed;
 *   - STRUCTURAL: no file in the app builds a path that could place a call — no
 *     Twilio import, no dial endpoint, no target-number reference. ui.md's
 *     highest-severity rule is "the path must not exist," so this asserts its
 *     absence rather than trusting a review to notice its arrival.
 */

import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canReplay, listRuns, listScenarios, loadRun, readRunAudio } from '../runs.ts';

const here = dirname(fileURLToPath(import.meta.url));
// apps/web/src/lib/server/__tests__ → apps/web/fixtures/runs
const FIXTURES = join(here, '../../../../fixtures/runs');
const APP_SRC = join(here, '../../..'); // apps/web/src

describe('enumerating and loading the committed fixtures', () => {
	// Three committed runs: the two generated simulator takes (baseline all-PASS
	// and the fabrication FAIL), plus the first LIVE Twilio wire capture
	// (2026-07-16, call CA7a1ea…): both assertions abstained there because the
	// far end was heard below the clarity floor — real evidence that abstention
	// fires on real audio, kept as a fixture precisely for that.
	it('lists the windshield-quote scenario with its runs', () => {
		const scenarios = listScenarios(FIXTURES);
		const wq = scenarios.find((s) => s.scenario === 'windshield-quote');
		expect(wq).toBeDefined();
		expect(wq!.runCount).toBe(3);
		expect(wq!.latest).not.toBeNull();
	});

	it('loads each run and verifies its hash (a drifted fixture would throw here)', () => {
		const { ok, broken } = listRuns('windshield-quote', FIXTURES);
		expect(ok).toHaveLength(3);
		expect(broken).toHaveLength(0);
		for (const r of ok) {
			const artifact = loadRun('windshield-quote', r.runId, FIXTURES);
			expect(artifact.runId).toBe(r.runId);
			expect(artifact.target).toBe('simulator');
		}
	});

	it('the runs discriminate: all-PASS, a FAIL (fabrication defect), and the live capture abstaining', () => {
		const { ok } = listRuns('windshield-quote', FIXTURES);
		const fails = ok.map((r) => r.counts.FAIL).sort();
		expect(fails).toEqual([0, 0, 1]);
		// The live capture is the run where INCONCLUSIVE did the work.
		const abstained = ok.filter((r) => r.counts.INCONCLUSIVE === 2);
		expect(abstained).toHaveLength(1);
	});
});

describe('loading refuses drifted or mislabeled artifacts', () => {
	// A unique OS-temp tree we can corrupt — never under the source tree, so a
	// crashed test can't leave an artifact that gets committed.
	let tmp = '';
	let goodRunId = '';

	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), 'callbench-runs-'));
		goodRunId = readdirSync(join(FIXTURES, 'windshield-quote'))[0]!;
		mkdirSync(join(tmp, 'windshield-quote', goodRunId), { recursive: true });
		const good = readFileSync(join(FIXTURES, 'windshield-quote', goodRunId, 'run.json'), 'utf8');
		writeFileSync(join(tmp, 'windshield-quote', goodRunId, 'run.json'), good);
	});

	afterAll(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it('loads the untouched copy fine', () => {
		expect(() => loadRun('windshield-quote', goodRunId, tmp)).not.toThrow();
	});

	it('refuses when the run.json turns are edited but the hash is kept (drift)', () => {
		const p = join(tmp, 'windshield-quote', goodRunId, 'run.json');
		const artifact = JSON.parse(readFileSync(p, 'utf8'));
		artifact.transcript.turns[0].text = `${artifact.transcript.turns[0].text} (tampered)`;
		writeFileSync(p, JSON.stringify(artifact));
		expect(() => loadRun('windshield-quote', goodRunId, tmp)).toThrow(/does not match its turns/);
		// restore for the mislabel test
		writeFileSync(
			p,
			readFileSync(join(FIXTURES, 'windshield-quote', goodRunId, 'run.json'), 'utf8'),
		);
	});

	it('refuses a run whose folder id disagrees with the artifact (mislabeled)', () => {
		const wrongDir = join(tmp, 'windshield-quote', 'not-the-real-id');
		mkdirSync(wrongDir, { recursive: true });
		writeFileSync(
			join(wrongDir, 'run.json'),
			readFileSync(join(FIXTURES, 'windshield-quote', goodRunId, 'run.json'), 'utf8'),
		);
		expect(() => loadRun('windshield-quote', 'not-the-real-id', tmp)).toThrow(/mislabeled/);
	});

	it('surfaces a drifted run as BROKEN rather than dropping it from the list', () => {
		// Corrupt the copied run in place; listRuns must still report it, as broken
		// (this describe shares one tmp tree with the mislabel test, so assert about
		// THIS run specifically rather than the exact broken count).
		const p = join(tmp, 'windshield-quote', goodRunId, 'run.json');
		const artifact = JSON.parse(readFileSync(p, 'utf8'));
		artifact.transcript.turns[0].text = 'tampered';
		writeFileSync(p, JSON.stringify(artifact));
		const { ok, broken } = listRuns('windshield-quote', tmp);
		expect(ok.some((r) => r.runId === goodRunId)).toBe(false); // not silently listed as ok
		const entry = broken.find((b) => b.runId === goodRunId);
		expect(entry).toBeDefined();
		expect(entry!.error).toMatch(/does not match/);
		// restore
		writeFileSync(
			p,
			readFileSync(join(FIXTURES, 'windshield-quote', goodRunId, 'run.json'), 'utf8'),
		);
	});

	it('refuses a run id that is a path-traversal segment, before reading any file', () => {
		expect(() => loadRun('windshield-quote', '../../etc', tmp)).toThrow(/single path segment/);
		expect(() => loadRun('..', goodRunId, tmp)).toThrow(/single path segment/);
	});
});

describe('the fence predicate', () => {
	it('permits replay for a simulator run only', () => {
		expect(canReplay('simulator')).toBe(true);
		expect(canReplay('system-under-test')).toBe(false);
	});
});

describe('serving audio verifies the frozen hash', () => {
	it('returns WAV bytes for a fixture run and refuses if the file drifts', () => {
		const runId = readdirSync(join(FIXTURES, 'windshield-quote'))[0]!;
		const { bytes, contentType } = readRunAudio('windshield-quote', runId, FIXTURES);
		expect(contentType).toBe('audio/wav');
		expect(bytes.length).toBeGreaterThan(1000);
		expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
	});

	it('refuses to serve audio whose bytes drifted from the frozen sha256', () => {
		// Copy a fixture run into tmp, then corrupt the WAV while keeping run.json.
		const runId = readdirSync(join(FIXTURES, 'windshield-quote'))[0]!;
		const dir = mkdtempSync(join(tmpdir(), 'callbench-audio-'));
		mkdirSync(join(dir, 'windshield-quote', runId), { recursive: true });
		const src = join(FIXTURES, 'windshield-quote', runId);
		writeFileSync(
			join(dir, 'windshield-quote', runId, 'run.json'),
			readFileSync(join(src, 'run.json')),
		);
		const wav = readFileSync(join(src, 'call.wav'));
		wav[100] = (wav[100]! + 7) & 0xff; // flip a sample byte
		writeFileSync(join(dir, 'windshield-quote', runId, 'call.wav'), wav);
		expect(() => readRunAudio('windshield-quote', runId, dir)).toThrow(
			/drifted from its frozen hash/,
		);
		rmSync(dir, { recursive: true, force: true });
	});
});

describe('STRUCTURAL: no dial CAPABILITY exists anywhere in the app', () => {
	// ui.md's highest-severity rule: the dial path "must not exist" — not "asks
	// first". A control that dials is a dial path whatever it is built from, so
	// this asserts the absence of the CAPABILITY, not of one vendor. A dial
	// fundamentally requires either outbound network egress (to a telephony API)
	// or a real-time media/WebRTC egress; ban those primitives and no dial can be
	// built from any vendor or in any file type. The telephony-vendor and
	// dial-script names are a second layer on top.
	//
	// Deliberately NOT banned: reading local files and streaming them (a future
	// audio-serving route reads a frozen recording off disk — that is evidence
	// playback, not a dial), and the replay audio engine (AudioContext /
	// AnalyserNode / MediaElementSource over an <audio> element — no mic, no peer).
	const FORBIDDEN: Array<{ token: string; why: string }> = [
		// outbound network egress — the substrate of a telephony API call
		{ token: 'fetch(', why: 'outbound HTTP call' },
		{ token: 'XMLHttpRequest', why: 'outbound HTTP call' },
		{ token: 'node-fetch', why: 'outbound HTTP client' },
		{ token: 'undici', why: 'outbound HTTP client' },
		{ token: 'axios', why: 'outbound HTTP client' },
		// real-time / media egress — the substrate of a browser-side (WebRTC) dial
		{ token: 'RTCPeerConnection', why: 'WebRTC egress' },
		{ token: 'WebSocket', why: 'realtime socket egress' },
		{ token: 'EventSource', why: 'server-sent egress channel' },
		{ token: 'getUserMedia', why: 'microphone capture' },
		{ token: 'mediaDevices', why: 'microphone/WebRTC capture' },
		{ token: 'MediaStreamAudioSource', why: 'live mic stream into audio graph' },
		// the transport contract itself, and driving audio onto a live leg
		{ token: '@callbench/transport', why: 'the transport that dials' },
		{ token: 'sendAudio', why: 'driving audio onto a live leg' },
		// shelling out — a dial script could be spawned as a child process
		{ token: 'child_process', why: 'spawning a process (could shell out to a dialer)' },
		{ token: 'execSync', why: 'shelling out' },
		{ token: 'execFile', why: 'shelling out' },
		{ token: 'spawn(', why: 'spawning a process' },
		{ token: 'spawnSync', why: 'spawning a process' },
		// telephony vendors — a second layer over the capability ban
		{ token: 'twilio', why: 'telephony vendor' },
		{ token: 'telnyx', why: 'telephony vendor' },
		{ token: 'vonage', why: 'telephony vendor' },
		{ token: 'plivo', why: 'telephony vendor' },
		{ token: 'bandwidth.com', why: 'telephony vendor' },
		{ token: 'signalwire', why: 'telephony vendor' },
		{ token: 'Calls.json', why: 'call-placement endpoint' },
		// the dial guard (its presence implies a dial site) and the numbers/script
		{ token: 'assertDialAllowed', why: 'the dial guard implies a dial site' },
		{ token: 'CALLBENCH_TARGET_NUMBER', why: 'the system-under-test number' },
		{ token: 'CALLBENCH_LOOPBACK_NUMBER', why: 'the loopback number' },
		{ token: 'loopback-call', why: 'the dial script' },
	];

	function walk(dir: string): string[] {
		const out: string[] = [];
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			// skip this very test file (it names the forbidden tokens on purpose)
			if (name === '__tests__') continue;
			if (statSync(p).isDirectory()) out.push(...walk(p));
			// every executable module extension, not just .ts/.js — a dial helper
			// in a .mjs/.cjs/.mts must be scanned too
			else if (/\.(ts|mts|cts|js|mjs|cjs|svelte)$/.test(name)) out.push(p);
		}
		return out;
	}

	it('contains no outbound-network, media-egress, or telephony primitive in any source file', () => {
		const files = walk(APP_SRC);
		expect(files.length).toBeGreaterThan(3); // guard against walking nothing/too little
		const offenders: string[] = [];
		for (const f of files) {
			const text = readFileSync(f, 'utf8');
			for (const { token, why } of FORBIDDEN) {
				if (text.includes(token)) offenders.push(`${f}: "${token}" (${why})`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
