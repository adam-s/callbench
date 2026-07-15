/**
 * Twilio Media Streams wire codec — pure functions, no I/O, no clock.
 *
 * The shapes here are pinned to a REAL capture (2026-07-15, one live call;
 * see `__tests__/fixtures/README.md`), not to documentation. Quirks the
 * capture established, which this codec preserves rather than "fixes":
 *
 *   - `sequenceNumber`, `media.chunk`, and `media.timestamp` are STRINGS on
 *     the wire. They stay strings here; a stage that wants numbers converts
 *     at its own boundary and owns the failure mode.
 *   - `streamSid` appears both at the top level and inside `start`.
 *   - `media.timestamp` is Twilio's clock at Twilio's layer. It is data, not
 *     a timing endpoint — see the clock rule in `../contract.ts`.
 *   - Media payloads are base64 mulaw with no header bytes; 20ms of 8kHz
 *     audio is 160 bytes. Silence is `0xFF`.
 *
 * Outbound requirements (Twilio docs, `docs/references.md`): media we send
 * must be base64 mulaw at 8000 with no file-header bytes; `clear` flushes
 * Twilio's buffered audio (the barge-in primitive); `mark` requests a
 * playback checkpoint.
 */

import type { MediaFormat } from '../contract.ts';

/** What Twilio declared on a real capture. The adapter verifies the `start`
 * event against this and surfaces a mismatch instead of parsing garbage. */
export const TWILIO_MEDIA_FORMAT: MediaFormat = {
	encoding: 'audio/x-mulaw',
	sampleRate: 8000,
	channels: 1,
};

/** 20ms of 8kHz mulaw — the frame size observed on the wire. */
export const BYTES_PER_FRAME = 160;
/** The mulaw byte for digital silence, as observed (all-0xFF frames). */
export const MULAW_SILENCE = 0xff;

export type TwilioMessage =
	| { readonly event: 'connected'; readonly protocol: string; readonly version: string }
	| {
			readonly event: 'start';
			readonly sequenceNumber: string;
			readonly streamSid: string;
			readonly start: {
				readonly accountSid: string;
				readonly streamSid: string;
				readonly callSid: string;
				readonly tracks: readonly string[];
				readonly mediaFormat: MediaFormat;
				readonly customParameters: Readonly<Record<string, string>>;
			};
	  }
	| {
			readonly event: 'media';
			readonly sequenceNumber: string;
			readonly media: {
				readonly track: string;
				readonly chunk: string;
				readonly timestamp: string;
				readonly payload: string;
			};
	  }
	| {
			readonly event: 'stop';
			readonly sequenceNumber: string;
			readonly streamSid: string;
			// Twilio's stop carries a nested object with the account and call
			// SIDs. The adapter doesn't read it (a stop is a stop), but the type
			// reflects the real wire shape rather than a convenient subset — an
			// earlier version omitted it, and a fixture pinned to an assumption
			// catches no drift. Optional because it costs nothing to tolerate a
			// bare stop, and stop is terminal regardless.
			readonly stop?: { readonly accountSid: string; readonly callSid: string };
	  }
	| { readonly event: 'dtmf'; readonly dtmf: { readonly track: string; readonly digit: string } }
	| { readonly event: 'mark'; readonly mark: { readonly name: string } }
	/** An event name this codec doesn't know. Preserved verbatim so the adapter
	 * can surface it; never silently dropped. */
	| { readonly event: 'unknown'; readonly raw: Record<string, unknown> };

const KNOWN_EVENTS = new Set(['connected', 'start', 'media', 'stop', 'dtmf', 'mark']);

/**
 * Parse one wire message. Throws on non-JSON or a JSON non-object (that is a
 * broken connection, not a protocol variant); returns `unknown` for a
 * well-formed message with an unrecognized event name.
 */
export function parseMessage(text: string): TwilioMessage {
	const raw: unknown = JSON.parse(text);
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new TypeError(`Twilio message is not a JSON object: ${text.slice(0, 80)}`);
	}
	const msg = raw as Record<string, unknown>;
	if (typeof msg.event !== 'string' || !KNOWN_EVENTS.has(msg.event)) {
		return { event: 'unknown', raw: msg };
	}
	return msg as unknown as TwilioMessage;
}

/** Base64 payload → raw mulaw bytes. */
export function decodePayload(payload: string): Uint8Array {
	return new Uint8Array(Buffer.from(payload, 'base64'));
}

/** Raw mulaw bytes → the outbound media message. No header bytes may be
 * present in `bytes` — this is raw audio, not a WAV. */
export function mediaMessage(streamSid: string, bytes: Uint8Array): string {
	return JSON.stringify({
		event: 'media',
		streamSid,
		media: { payload: Buffer.from(bytes).toString('base64') },
	});
}

/** Ask Twilio to emit a mark once audio queued before this point has played. */
export function markMessage(streamSid: string, name: string): string {
	return JSON.stringify({ event: 'mark', streamSid, mark: { name } });
}

/** Flush Twilio's buffered outbound audio — the barge-in primitive. */
export function clearMessage(streamSid: string): string {
	return JSON.stringify({ event: 'clear', streamSid });
}
