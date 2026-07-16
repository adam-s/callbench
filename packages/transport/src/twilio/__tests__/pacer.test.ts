/**
 * The pacer's job is a schedule, so the clock is injected and the tests drive it.
 * A pacer tested by sleeping is tested at one speed, on one machine, and tells
 * you nothing about the case that matters: what happens when the loop is late.
 */

import { describe, expect, it } from 'vitest';
import { createPacer, FRAME_MS, toFrames } from '../pacer.ts';

/** A clock the test moves by hand, plus a timer queue keyed to it. */
function harness(leadMs = 60) {
	let t = 0;
	const timers: Array<{ at: number; fn: () => void }> = [];
	const sent: Array<{ frame: Uint8Array; at: number }> = [];
	const pacer = createPacer({
		send: (frame) => sent.push({ frame, at: t }),
		now: () => t,
		setTimer: (fn, ms) => {
			const h = { at: t + ms, fn };
			timers.push(h);
			return h;
		},
		clearTimer: (h) => {
			const i = timers.indexOf(h as { at: number; fn: () => void });
			if (i >= 0) timers.splice(i, 1);
		},
		leadMs,
	});
	/** Advance the clock, firing anything due. */
	const advance = (ms: number) => {
		const target = t + ms;
		for (;;) {
			const next = timers
				.filter((x) => x.at <= target)
				.sort((a, b) => a.at - b.at)
				.shift();
			if (!next) break;
			timers.splice(timers.indexOf(next), 1);
			t = Math.max(t, next.at);
			next.fn();
		}
		t = target;
	};
	return { pacer, sent, advance, now: () => t };
}

const frame = (n: number) => new Uint8Array(160).fill(n);

describe('outbound pacer', () => {
	it('sends only the lead immediately, not the whole utterance', () => {
		// The bug this exists for: a caller hands over a whole reply and every
		// frame hits the wire at once. Twilio discards the overflow (31931) and
		// nothing errors — the far end just hears less than was said.
		const { pacer, sent } = harness(60);
		const frames = Array.from({ length: 50 }, (_, i) => frame(i)); // 1 second
		pacer.push(frames);
		// At t=0 with a 60ms lead, only frames due within 60ms may go: 0, 20, 40, 60.
		expect(sent.length).toBe(4);
		expect(pacer.pending()).toBe(46);
	});

	it('paces at real time across a long utterance', () => {
		const { pacer, sent, advance } = harness(60);
		pacer.push(Array.from({ length: 50 }, (_, i) => frame(i)));
		advance(1000);
		// 1s of audio in 1s of clock: all 50 frames, none left.
		expect(sent.length).toBe(50);
		expect(pacer.pending()).toBe(0);
	});

	it('holds an absolute schedule instead of accumulating drift', () => {
		// setTimeout(20) fires at LEAST 20ms later, never exactly. A relative
		// schedule adds that error every frame and drifts seconds late over a long
		// utterance — starving the stream it was meant to feed, which is the
		// opposite failure (Twilio's audio-timeout). The schedule is absolute:
		// frame n is due at anchor + n*20, whatever happened before it.
		const { pacer, sent, advance } = harness(0);
		pacer.push(Array.from({ length: 10 }, (_, i) => frame(i)));
		advance(200);
		expect(sent.length).toBe(10);
		// Every frame left on its own slot — the nth at n*20ms — not n*(20+overhead).
		for (let i = 0; i < 10; i++) expect(sent[i].at).toBe(i * FRAME_MS);
	});

	it('catches up after the loop blocks, without shifting the rest late', () => {
		// A blocked event loop is the realistic case: one pump is late, and a
		// relative schedule would push every later frame late by the same amount,
		// compounding. Absolute scheduling absorbs it in one catch-up burst.
		const { pacer, sent, advance } = harness(0);
		pacer.push(Array.from({ length: 10 }, (_, i) => frame(i)));
		advance(100); // frames due at 0..100 -> 6 of them
		const afterStall = sent.length;
		advance(100); // the rest are now due
		expect(afterStall).toBeLessThan(10);
		expect(sent.length).toBe(10);
		// Total elapsed is still ~200ms for 200ms of audio: the stall did not
		// stretch the utterance.
		expect(sent[9].at).toBeLessThanOrEqual(200);
	});

	it('flush drops what has not been sent — the barge-in half', () => {
		// The provider's `clear` flushes ITS buffer. Without dropping ours, a
		// cleared utterance keeps arriving frame by frame and plays over whatever
		// the caller barged in to say. Both halves are needed.
		const { pacer, sent, advance } = harness(0);
		pacer.push(Array.from({ length: 50 }, (_, i) => frame(i)));
		advance(100);
		const before = sent.length;
		pacer.flush();
		advance(1000);
		expect(pacer.pending()).toBe(0);
		expect(sent.length).toBe(before); // nothing left after the flush
	});

	it('starts a fresh schedule after idle rather than catching up on the gap', () => {
		// If the anchor survived an idle stretch, the next utterance would be
		// "due" for the whole silence and burst out at once — reintroducing the
		// original bug at the seam between two turns.
		const { pacer, sent, advance } = harness(0);
		pacer.push([frame(1)]);
		advance(1000); // long silence
		pacer.push(Array.from({ length: 10 }, (_, i) => frame(i)));
		expect(sent.length).toBe(2); // the first, plus frame 0 of the new run — not all 11
	});

	it('stop is idempotent and sends nothing after', () => {
		const { pacer, sent, advance } = harness(0);
		pacer.push(Array.from({ length: 10 }, (_, i) => frame(i)));
		pacer.stop();
		pacer.stop();
		const after = sent.length;
		pacer.push([frame(99)]);
		advance(1000);
		expect(sent.length).toBe(after);
	});
});

describe('toFrames', () => {
	it('splits on the frame boundary', () => {
		expect(toFrames(new Uint8Array(320), 160).map((f) => f.length)).toEqual([160, 160]);
	});

	it('sends a short final frame as-is rather than padding it', () => {
		// Padding to a full frame would put audio on the wire the caller never
		// said. A short final frame is accepted; invented silence is not.
		expect(toFrames(new Uint8Array(170), 160).map((f) => f.length)).toEqual([160, 10]);
	});

	it('is a view, not a copy — a frame aliases its source', () => {
		const src = new Uint8Array(320).fill(7);
		const frames = toFrames(src, 160);
		expect(frames[1][0]).toBe(7);
		expect(frames.length).toBe(2);
	});
});
