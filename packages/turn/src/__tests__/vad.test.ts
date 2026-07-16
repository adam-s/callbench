/**
 * Turn-detector tests: a synthetic frame stream (silence and voiced frames)
 * drives the boundary logic. What's pinned is the honesty of the events —
 * speech-start fires once at onset, turn-end fires only after the CONFIRM
 * window, and the load-bearing new behavior: speech resuming between the
 * provisional and confirm windows RE-ATTACHES to the same turn. That
 * re-attachment is the fix for the live mid-sentence split ("It's a 2015
 * [pause] Audi A3" became two turns, take bf519398, 2026-07-16) — a
 * regression here re-splits real utterances.
 */

import { encodePcm } from '@callbench/transport';
import { describe, expect, it } from 'vitest';
import { EnergyTurnDetector, type TurnDetectorConfig } from '../vad.ts';

const CFG: TurnDetectorConfig = {
	speechEnergy: 500,
	provisionalSilenceMs: 60,
	confirmSilenceMs: 160,
	minSpeechMs: 40,
	frameMs: 20,
};

// A 20ms voiced frame (loud PCM → mulaw) and a 20ms mulaw-silence frame.
const voiced = encodePcm(new Int16Array(160).fill(10000));
const silence = new Uint8Array(160).fill(0xff);

/** Feed frames at 20ms cadence from t=0, collecting events. */
function run(frames: Uint8Array[], cfg: TurnDetectorConfig = CFG) {
	const d = new EnergyTurnDetector(cfg);
	const events: ReturnType<EnergyTurnDetector['push']>[] = [];
	frames.forEach((f, i) => {
		const ev = d.push(f, i * 20);
		if (ev) events.push(ev);
	});
	return events;
}

const v = (n: number) => Array.from({ length: n }, () => voiced);
const s = (n: number) => Array.from({ length: n }, () => silence);

describe('EnergyTurnDetector', () => {
	it('fires speech-start once at the first voiced frame', () => {
		const events = run([silence, ...v(3)]);
		const starts = events.filter((e) => e?.type === 'speech-start');
		expect(starts).toHaveLength(1);
		expect(starts[0]?.atMs).toBe(20);
	});

	it('turn-maybe-end at the provisional window, turn-end only at confirm', () => {
		// 3 voiced (last speech t=40), then silence: provisional at ≥100
		// (40+60), confirm at ≥200 (40+160).
		const events = run([...v(3), ...s(10)]);
		const maybe = events.find((e) => e?.type === 'turn-maybe-end');
		const end = events.find((e) => e?.type === 'turn-end');
		if (maybe?.type !== 'turn-maybe-end' || end?.type !== 'turn-end') throw new Error('missing');
		expect(maybe.atMs).toBeGreaterThanOrEqual(100);
		expect(maybe.atMs).toBeLessThan(end.atMs);
		expect(end.atMs).toBeGreaterThanOrEqual(200);
	});

	it('RE-ATTACHES speech that resumes between provisional and confirm — the live-split pin', () => {
		// speech, a 100ms pause (past provisional 60, short of confirm 160),
		// then more speech, then real silence. Must be ONE turn: one
		// speech-start, one turn-end, after the SECOND run of speech.
		const events = run([...v(3), ...s(5), ...v(3), ...s(10)]);
		expect(events.filter((e) => e?.type === 'speech-start')).toHaveLength(1);
		const ends = events.filter((e) => e?.type === 'turn-end');
		expect(ends).toHaveLength(1);
		const end = ends[0];
		if (end?.type !== 'turn-end') throw new Error('no turn-end');
		// The end is measured from the LAST speech (t=200), not the first run:
		// confirm at ≥360.
		expect(end.atMs).toBeGreaterThanOrEqual(360);
		// And spokeMs spans the whole re-attached turn (first start → last speech).
		expect(end.spokeMs).toBe(200 - 0 + 20);
	});

	it('announces the re-attach as turn-resumed — the cancel signal for speculative work', () => {
		// Same shape as the re-attach pin: maybe-end fires during the 100ms
		// pause, so the resume must announce itself (a speculative STT started
		// at maybe-end is now stale). Exactly one, at the resuming frame.
		const events = run([...v(3), ...s(5), ...v(3), ...s(10)]);
		const resumed = events.filter((e) => e?.type === 'turn-resumed');
		expect(resumed).toHaveLength(1);
		expect(resumed[0]?.atMs).toBe(160); // first voiced frame of the second run
		// A pause SHORTER than provisional never fired maybe-end, so resuming
		// from it is silent — no stale speculation exists to cancel.
		const quick = run([...v(3), ...s(2), ...v(3), ...s(10)]);
		expect(quick.filter((e) => e?.type === 'turn-resumed')).toHaveLength(0);
	});

	it('reports spokeMs as (last-speech − start + one frame), exactly', () => {
		const events = run([...v(3), ...s(10)]);
		const end = events.find((e) => e?.type === 'turn-end');
		if (end?.type !== 'turn-end') throw new Error('no turn-end');
		expect(end.spokeMs).toBe(60);
	});

	it('a blip shorter than minSpeechMs never ends a turn — and expires cleanly', () => {
		// One voiced frame (20ms < 40ms guard) then long silence: no turn-end,
		// no phantom turn. A later real utterance still works.
		const d = new EnergyTurnDetector(CFG);
		const frames = [voiced, ...s(12), ...v(3), ...s(10)];
		const events: ReturnType<EnergyTurnDetector['push']>[] = [];
		frames.forEach((f, i) => {
			const ev = d.push(f, i * 20);
			if (ev) events.push(ev);
		});
		const ends = events.filter((e) => e?.type === 'turn-end');
		expect(ends).toHaveLength(1); // only the real utterance ends
		const end = ends[0];
		if (end?.type !== 'turn-end') throw new Error('no turn-end');
		expect(end.spokeMs).toBeLessThanOrEqual(80); // the real 60ms turn, not blip+turn
	});

	it('emits nothing for pure silence — there was no turn to end', () => {
		expect(run(s(5))).toEqual([]);
	});

	it('goes quiet after turn-end (one turn per detector)', () => {
		const d = new EnergyTurnDetector(CFG);
		const frames = [...v(3), ...s(10), ...v(2)];
		let ends = 0;
		frames.forEach((f, i) => {
			if (d.push(f, i * 20)?.type === 'turn-end') ends++;
		});
		expect(ends).toBe(1);
	});
});
