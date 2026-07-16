/**
 * The pacer's job is a schedule, so the clock is injected and the tests drive it.
 * A pacer tested by sleeping is tested at one speed, on one machine, and tells
 * you nothing about the case that matters: what happens when the loop is late.
 */

import { describe, expect, it } from 'vitest';
import { createPacer, FRAME_MS, LEAD_MS, toFrames } from '../pacer.ts';

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
	/** How late every timer fires. Real setTimeout NEVER fires early and rarely
	 * fires on time — a harness that is punctual is kinder than reality and
	 * cannot see the failure the absolute schedule exists to prevent. */
	let latenessMs = 0;
	const setLateness = (ms: number) => {
		latenessMs = ms;
	};
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
			// Fire LATE, as a real timer does.
			t = Math.max(t, Math.min(next.at + latenessMs, target));
			next.fn();
		}
		t = target;
	};
	return { pacer, sent, advance, setLateness, now: () => t };
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

	it('flush cancels the pending pump, so the next utterance starts now', () => {
		// Red-team finding (07-16): flush() cleared the queue but left the timer,
		// and push() defers to a live timer — so the first frame after a barge-in
		// waited out the stale interval. Bounded to one frame-interval, but
		// barge-in is exactly the moment added latency is audible.
		const { pacer, sent, advance } = harness(0);
		pacer.push(Array.from({ length: 10 }, (_, i) => frame(i)));
		advance(30); // frames 0,1 out; a pump is pending at t=40
		pacer.flush();
		pacer.push([frame(99)]);
		const last = sent[sent.length - 1];
		expect(last.frame[0]).toBe(99);
		expect(last.at).toBe(30); // immediately, not at the stale timer's t=40
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

describe('the absolute schedule — the reason this module exists', () => {
	it('does not drift when every timer fires late', () => {
		// THE test for this module, and it was missing. A mutation that re-anchors
		// the schedule on every pump — reintroducing exactly the drift the docstring
		// warns about — passed all 211 tests, because the harness fired timers
		// exactly on time. Re-anchoring at the instant a frame is due IS absolute
		// scheduling; the two only diverge when a timer is LATE, which is the only
		// thing real timers ever are.
		//
		// setTimeout(20) fires at 20+something. A relative schedule adds that
		// something every frame: over a 10-second utterance it lands seconds late
		// and starves the stream it was meant to feed — Twilio's audio-timeout, the
		// opposite failure from the one that motivated the pacer.
		const { pacer, sent, advance, setLateness } = harness(0);
		setLateness(5); // every timer 5ms late — modest, and relentless
		pacer.push(Array.from({ length: 50 }, (_, i) => frame(i))); // 1s of audio

		advance(1000);

		// An absolute schedule delivers a second of audio in about a second: each
		// late pump catches up rather than pushing the rest later. A relative one
		// would have sent ~40 frames by now (25% behind) and would fall further
		// behind the longer it ran.
		expect(sent.length).toBe(50);
		// And the last frame is not dragged past its slot by the accumulated
		// lateness — 5ms x 50 frames would be 250ms of drift.
		expect(sent[49].at).toBeLessThan(1000 + 50);
	});

	it('keeps the audio the right length even when the loop stalls hard', () => {
		const { pacer, sent, advance, setLateness } = harness(0);
		setLateness(60); // three frames' worth of lateness, every time
		pacer.push(Array.from({ length: 25 }, (_, i) => frame(i))); // 500ms of audio
		advance(600);
		// Still 500ms of audio in ~500ms of clock. The stall is absorbed by
		// catch-up bursts, not by stretching the utterance.
		expect(sent.length).toBe(25);
		expect(sent[24].at).toBeLessThan(500 + 100);
	});
});

describe('the shipped default lead', () => {
	it('is at least one frame — a lead of zero has no cushion at all', () => {
		// Every other test injects leadMs, so the value session.ts actually uses was
		// reachable by nothing: a mutation setting LEAD_MS to 0 passed the suite.
		// The constant is honestly labelled UNMEASURED (it is Twilio's and pipecat's
		// number, not one we took from a call), so this pins the PROPERTY rather
		// than the number: below one frame there is no jitter buffer, and a single
		// late timer becomes a gap of silence — which is the audio-timeout failure,
		// the opposite of the one the pacer was built for.
		expect(LEAD_MS).toBeGreaterThanOrEqual(FRAME_MS);
		// And an upper bound, because a large enough lead IS the original bug:
		// queue far enough ahead and you are dumping again.
		expect(LEAD_MS).toBeLessThanOrEqual(FRAME_MS * 10);
	});

	it('paces with the default, not only with an injected lead', () => {
		// Exercise the real default through the API — no leadMs argument.
		const t = 0;
		const sent: number[] = [];
		const pacer = createPacer({
			send: () => sent.push(t),
			now: () => t,
			setTimer: () => null,
			clearTimer: () => {},
		});
		pacer.push(Array.from({ length: 50 }, () => new Uint8Array(160)));
		expect(sent.length).toBeGreaterThan(0); // something leaves immediately
		expect(sent.length).toBeLessThan(50); // but not the whole utterance
		pacer.stop();
	});
});
