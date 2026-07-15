/**
 * The transport contract — what the core sees of any call, regardless of which
 * provider carried it.
 *
 * One interface per source or sink (AGENTS.md): adapters differ only in how
 * they connect and map. Nothing in this file may import from an adapter
 * directory, and no adapter type may leak through it. Identity travels WITH
 * the record — `provider` and `sessionId` are fields, and no downstream stage
 * may re-derive them from a provider quirk.
 *
 * ## The clock and its layer (frozen by Increment 1)
 *
 * Every `atMs` in this contract is:
 *
 *   - **monotonic milliseconds since the session's own zero** (Node
 *     `performance.now()` deltas — never `Date.now()`, which steps under NTP),
 *   - **stamped in the adapter's socket-message handler**, before any parsing
 *     or buffering of ours.
 *
 * `anchorEpochMs` is the wall-clock epoch captured at the same instant as the
 * session's zero, so records can be placed in calendar time. Durations are
 * always `atMs - atMs`, never epoch arithmetic.
 *
 * The rule this encodes (AGENTS.md, "measure the clock you claim to measure"):
 * both endpoints of any duration must be stamps from THIS clock at THIS layer.
 * A provider's own timestamp (e.g. a media frame's `timestamp` field) is a
 * different clock at a different layer — it may be recorded as data, but a
 * duration that mixes it with `atMs` is confidently wrong and must not exist.
 */

export interface MediaFormat {
	readonly encoding: string;
	readonly sampleRate: number;
	readonly channels: number;
}

/** Inbound events, in the order the wire produced them. */
export type TransportEvent =
	/** Provider-level socket established; no media yet. */
	| { readonly type: 'connected'; readonly atMs: number }
	/** Media negotiated. `format` is what the provider DECLARED — the adapter
	 * verifies it against what the bench expects and surfaces a mismatch as an
	 * error event rather than parsing garbage. */
	| {
			readonly type: 'started';
			readonly atMs: number;
			readonly format: MediaFormat;
			readonly tracks: readonly string[];
	  }
	/** One frame of inbound audio, decoded to raw bytes (no base64, no header). */
	| {
			readonly type: 'audio';
			readonly atMs: number;
			readonly track: string;
			readonly bytes: Uint8Array;
	  }
	| { readonly type: 'dtmf'; readonly atMs: number; readonly digit: string }
	/** The provider finished playing audio we sent, up to the named mark. The
	 * only honest "we have stopped talking" signal — a local timer is a guess
	 * about someone else's buffer. */
	| { readonly type: 'mark'; readonly atMs: number; readonly name: string }
	| { readonly type: 'stopped'; readonly atMs: number }
	/** Anything abnormal: a malformed message, a format mismatch, a socket
	 * error. Surfaced, never papered over (product invariant). The session ends
	 * after an error event; there is no in-transport recovery or retry. */
	| { readonly type: 'error'; readonly atMs: number; readonly reason: string };

/**
 * One live call, from media-established to hangup. Produced by an adapter;
 * consumed by the core. How the call came to exist (we dialed / we answered)
 * is the adapter's business and is not visible here.
 */
export interface TransportSession {
	/** Which adapter produced this record — travels with the data forever. */
	readonly provider: string;
	/** The provider's stable identifier for this media session. */
	readonly sessionId: string;
	/** Wall-clock epoch at this session's atMs = 0. */
	readonly anchorEpochMs: number;

	/** Inbound events in wire order. Iteration ends at `stopped` or `error`. */
	readonly events: AsyncIterable<TransportEvent>;

	/** Queue raw audio bytes (in the provider's negotiated format) to play to
	 * the far end. Fire-and-forget; completion is observed via `mark`. */
	sendAudio(bytes: Uint8Array): void;
	/** Ask the provider to emit a `mark` event once everything queued before
	 * this point has finished playing. */
	sendMark(name: string): void;
	/** Flush all queued-but-unplayed audio — the barge-in primitive. */
	clearAudio(): void;
	/** End the session from our side. Idempotent. */
	end(): void;
}
