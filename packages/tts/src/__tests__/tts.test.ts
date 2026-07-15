/**
 * TTS framing tests. The adapter's network call is thin glue (not tested — the
 * suite never dials); what's pinned is the PCM→mulaw framing that turns a
 * synthesized utterance into transport-ready frames, because a wrong frame size
 * or a dropped tail would play back garbled on a real call.
 */

import { BYTES_PER_FRAME, decodeMulaw } from '@callbench/transport';
import { describe, expect, it } from 'vitest';
import { durationMs, toMulawFrames, type Utterance } from '../tts.ts';

const utter = (samples: number, rate = 8000): Utterance => ({
	pcm: new Int16Array(samples).fill(8000),
	sampleRate: rate,
	provider: 'kokoro-82m',
});

describe('toMulawFrames', () => {
	it('splits into whole 160-byte (20ms) frames', () => {
		const frames = toMulawFrames(utter(160 * 3)); // exactly 3 frames
		expect(frames).toHaveLength(3);
		expect(frames.every((f) => f.length === BYTES_PER_FRAME)).toBe(true);
	});

	it('pads a partial tail to a whole frame with mulaw silence', () => {
		const frames = toMulawFrames(utter(160 * 2 + 40)); // 2 full + a 40-sample tail
		expect(frames).toHaveLength(3);
		const tail = frames[2];
		if (!tail) throw new Error('no tail frame');
		expect(tail.length).toBe(BYTES_PER_FRAME);
		// The padding is 0xFF (mulaw silence): the last bytes are silence.
		expect(tail[BYTES_PER_FRAME - 1]).toBe(0xff);
	});

	it('preserves the audio: a framed voiced utterance is still voiced', () => {
		const frames = toMulawFrames(utter(160 * 2));
		const decoded = decodeMulaw(frames[0]!);
		expect(decoded.some((s) => Math.abs(s) > 1000)).toBe(true);
	});

	it('refuses a wrong sample rate rather than playing at the wrong speed', () => {
		expect(() => toMulawFrames(utter(160, 24000))).toThrow(/24000Hz but the transport is 8000Hz/);
	});
});

describe('durationMs', () => {
	it('computes playback length from samples and rate', () => {
		expect(durationMs(utter(8000))).toBe(1000); // 8000 samples at 8kHz = 1s
		expect(durationMs(utter(4000))).toBe(500);
	});
});
