/**
 * Turn-detector tests: a synthetic frame stream (silence and voiced frames)
 * drives the boundary logic. What's pinned is the honesty of the two events —
 * speech-start fires once at onset, turn-end fires only after the full hangover
 * of trailing silence, and a mid-speech gap shorter than the hangover does NOT
 * end the turn (the "paused mid-sentence" case the docstring warns about).
 */

import { encodePcm } from '@callbench/transport';
import { describe, expect, it } from 'vitest';
import { EnergyTurnDetector, type TurnDetectorConfig } from '../vad.ts';

const CFG: TurnDetectorConfig = { speechEnergy: 500, hangoverMs: 100, frameMs: 20 };

// A 20ms voiced frame (loud PCM → mulaw) and a 20ms mulaw-silence frame.
const voiced = encodePcm(new Int16Array(160).fill(10000));
const silence = new Uint8Array(160).fill(0xff);

/** Feed frames at 20ms cadence from t=0, collecting events. */
function run(frames: Uint8Array[]): ReturnType<EnergyTurnDetector['push']>[] {
	const d = new EnergyTurnDetector(CFG);
	const events: ReturnType<EnergyTurnDetector['push']>[] = [];
	frames.forEach((f, i) => {
		const ev = d.push(f, i * 20);
		if (ev) events.push(ev);
	});
	return events;
}

describe('EnergyTurnDetector', () => {
	it('fires speech-start once at the first voiced frame', () => {
		const events = run([silence, voiced, voiced, voiced]);
		const starts = events.filter((e) => e?.type === 'speech-start');
		expect(starts).toHaveLength(1);
		expect(starts[0]?.atMs).toBe(20); // the second frame, at t=20ms
	});

	it('fires turn-end only after a full hangover of trailing silence', () => {
		// speech for 3 frames (0..40ms), then silence. hangover=100ms.
		const events = run([voiced, voiced, voiced, silence, silence, silence, silence, silence]);
		const end = events.find((e) => e?.type === 'turn-end');
		if (end?.type !== 'turn-end') throw new Error('no turn-end');
		// last speech at 40ms; +100ms hangover = first eligible at 140ms.
		expect(end.atMs).toBeGreaterThanOrEqual(140);
		expect(end.spokeMs).toBeGreaterThan(0);
	});

	it('does NOT end the turn on a gap shorter than the hangover', () => {
		// speech, one silence frame (20ms < 100ms hangover), speech again.
		const events = run([voiced, silence, voiced, voiced]);
		expect(events.some((e) => e?.type === 'turn-end')).toBe(false);
		// only the initial speech-start
		expect(events.filter((e) => e?.type === 'speech-start')).toHaveLength(1);
	});

	it('emits nothing for pure silence — there was no turn to end', () => {
		expect(run([silence, silence, silence])).toEqual([]);
	});

	it('goes quiet after turn-end (one turn per detector)', () => {
		const d = new EnergyTurnDetector(CFG);
		const frames = [voiced, voiced, silence, silence, silence, silence, silence, voiced, voiced];
		let ends = 0;
		frames.forEach((f, i) => {
			if (d.push(f, i * 20)?.type === 'turn-end') ends++;
		});
		expect(ends).toBe(1); // the later speech does not start a second turn
	});
});
