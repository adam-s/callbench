/**
 * Outbound pacer — emit audio onto the wire at the rate it plays.
 *
 * WHY THIS EXISTS. `sendAudio` used to base64 whatever it was handed into ONE
 * `media` message. That was invisible while the only caller sent 400ms tones,
 * and it is the first thing real speech breaks: hand it a multi-second utterance
 * and it goes out as one enormous frame, or a caller loops over frames and
 * bursts an entire reply in microseconds. Twilio's Error 31931 (Stream - Media -
 * Discarded) documents exactly that — audio discarded when `media` arrives faster
 * than playback — and its own first remediation is "pace outbound `media` so the
 * buffer can drain" (docs/references.md, Transport).
 *
 * The failure is silent in the worst way: Twilio discards the tail, `mark` still
 * fires, and the far end simply heard less than we said. Nothing errors.
 *
 * WHY PACE AT ALL, when twilio-samples and vocode-core do not: because they
 * don't need to. Their audio arrives from a streaming LLM or TTS that already
 * emits at generation pace — the network is paced by the generator. callbench
 * synthesises the whole utterance up front (a deliberate choice: scripted lines
 * are rendered before the call so the ~455ms link is paid off-call), so nothing
 * throttles it. Structurally we are pipecat's case, not theirs, and pipecat
 * paces. That resolves the disagreement between three production stacks on
 * architectural grounds rather than by picking a favourite.
 *
 * THE OTHER SIDE OF THE BOUND. Pacing too conservatively starves the stream and
 * raises Twilio's audio-timeout ("Long duration elapsed without audio"). So the
 * pacer runs slightly AHEAD of real time — a small lead is a jitter buffer, and
 * the 10-minute buffer ceiling means a lead measured in tens of milliseconds is
 * nowhere near it.
 *
 * DRIFT. `setTimeout(20)` does not fire every 20ms; it fires at least 20ms
 * later, and the error accumulates. Over a 10-second utterance a naive interval
 * drifts seconds late and starves the very stream it was meant to feed. So the
 * schedule is absolute — each frame is due at `startedAt + n * FRAME_MS`, and
 * the sleep is the remaining distance to that instant. Late frames catch up
 * instead of pushing the next one later. Same shape pipecat uses.
 *
 * WHAT THIS IS NOT. It is not a jitter buffer for INBOUND audio, and it does not
 * touch the clock the session stamps arrivals with. It only decides when bytes
 * leave.
 */

/** One Twilio media frame: 20ms of 8kHz mulaw = 160 bytes. Not configurable —
 * it is the format the provider negotiated (frames.ts TWILIO_MEDIA_FORMAT). */
export const FRAME_MS = 20;

/**
 * How far ahead of real time to run. Twilio's own guidance and the sampled
 * implementations sit around a 40-80ms lead; 60ms is three frames, enough to
 * absorb an event-loop hiccup without approaching any documented ceiling.
 *
 * UNMEASURED HERE. This is somebody else's number until a real call says
 * otherwise — the probe is to send a long utterance and watch for 31931 and for
 * `mark` timing that disagrees with wall-clock playback. Treat it as a starting
 * point with a citation, not a tuned constant.
 */
export const LEAD_MS = 60;

export interface Pacer {
	/** Queue frames. Returns immediately; they leave on schedule. */
	push(frames: readonly Uint8Array[]): void;
	/** Drop everything not yet sent — the barge-in half of `clearAudio`. The
	 * provider's own `clear` flushes what it already has; this stops us adding
	 * more. Both are needed: without this, a cleared utterance keeps arriving. */
	flush(): void;
	/** Frames queued but not yet on the wire. */
	pending(): number;
	/** Stop for good. Idempotent. */
	stop(): void;
}

export interface PacerOptions {
	/** Emit one frame. */
	send(frame: Uint8Array): void;
	/** Monotonic ms. Injected so a test can drive the schedule without waiting —
	 * a pacer tested by sleeping is a pacer tested at one speed. */
	now?: () => number;
	/** Schedule a callback. Injected for the same reason. */
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (h: unknown) => void;
	leadMs?: number;
}

export function createPacer(opts: PacerOptions): Pacer {
	const now = opts.now ?? (() => performance.now());
	const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	const leadMs = opts.leadMs ?? LEAD_MS;

	const queue: Uint8Array[] = [];
	let timer: unknown = null;
	let stopped = false;
	/** The instant frame 0 of the current run was due. null when idle. */
	let anchor: number | null = null;
	/** Frames sent since the anchor. The schedule is anchor + sent * FRAME_MS —
	 * absolute, so a late frame catches up rather than shifting the rest late. */
	let sent = 0;

	function pump(): void {
		timer = null;
		if (stopped) return;
		if (queue.length === 0) {
			// Idle: drop the anchor so the next push starts a fresh schedule rather
			// than trying to catch up on a gap that was never ours to fill.
			anchor = null;
			sent = 0;
			return;
		}
		if (anchor === null) {
			anchor = now();
			sent = 0;
		}
		// Send everything already due, plus the lead. A single pump can emit
		// several frames — that is the catch-up, and its size is proportional to
		// how long the loop was blocked (plus the lead), capped by what remains
		// queued. That burst is CORRECT, not a hazard: while the loop was stalled
		// the wire went quiet and Twilio's outbound buffer drained by exactly the
		// stall, so the burst refills what played out, and the discard ceiling is
		// ten MINUTES of buffered audio (Error 31931, verified 2026-07-16) — three
		// orders of magnitude above a scripted utterance. pipecat re-anchors here
		// instead, stretching the utterance by the stall; both are safe, and
		// keeping the utterance its recorded length is the better fit for a bench
		// that measures timing. Re-anchoring on EVERY pump, though, is the drift
		// bug — see the fires-late test.
		const horizon = now() + leadMs;
		while (queue.length > 0 && anchor + sent * FRAME_MS <= horizon) {
			const frame = queue.shift();
			if (frame) opts.send(frame);
			sent++;
		}
		if (queue.length === 0) {
			anchor = null;
			sent = 0;
			return;
		}
		const dueIn = anchor + sent * FRAME_MS - horizon;
		timer = setTimer(pump, Math.max(0, dueIn));
	}

	return {
		push(frames) {
			if (stopped) return;
			queue.push(...frames);
			if (timer === null) pump();
		},
		flush() {
			queue.length = 0;
			anchor = null;
			sent = 0;
			// Cancel any pending pump too: push() defers to a live timer, so a
			// stale one left here would delay the first frame after a barge-in by
			// up to its remaining interval. Small, but barge-in is exactly the
			// moment latency is audible.
			if (timer !== null) {
				clearTimer(timer);
				timer = null;
			}
		},
		pending: () => queue.length,
		stop() {
			stopped = true;
			queue.length = 0;
			if (timer !== null) clearTimer(timer);
			timer = null;
		},
	};
}

/** Split a payload into wire frames. A trailing partial frame is sent as-is:
 * Twilio accepts a short final frame, and padding it with silence would add
 * audio the caller never said. */
export function toFrames(bytes: Uint8Array, frameBytes: number): Uint8Array[] {
	const out: Uint8Array[] = [];
	for (let i = 0; i < bytes.length; i += frameBytes) out.push(bytes.subarray(i, i + frameBytes));
	return out;
}
