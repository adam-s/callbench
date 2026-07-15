/**
 * Twilio Media Streams adapter: turns one live socket into a TransportSession.
 *
 * The factory consumes the wire handshake (`connected` → `start`) BEFORE the
 * session exists, so `sessionId` and the verified media format are facts at
 * construction, not fields that fill in later. A connection that never
 * completes the handshake, or declares a format the bench doesn't speak,
 * rejects — a session is never handed to the core half-formed.
 *
 * Clock and layer, per the contract: `atMs` is `now() - zero`, with `now`
 * monotonic (performance.now) and read at the TOP of the socket-message
 * handler, before parsing. Both are injectable for deterministic tests.
 *
 * The socket is the four-method `MediaSocket` interface rather than a `ws`
 * WebSocket so the whole adapter is testable against fixture messages with no
 * network; `serve.ts` adapts the real thing in a handful of lines.
 */

import { DEBUG } from '@callbench/shared';
import type { MediaFormat, TransportEvent, TransportSession } from '../contract.ts';
import {
	clearMessage,
	decodePayload,
	markMessage,
	mediaMessage,
	parseMessage,
	TWILIO_MEDIA_FORMAT,
} from './frames.ts';

export interface MediaSocket {
	send(text: string): void;
	close(): void;
	onMessage(cb: (text: string) => void): void;
	onClose(cb: () => void): void;
	onError(cb: (err: Error) => void): void;
}

export interface TwilioSessionOptions {
	/** Monotonic clock; injectable for tests. Defaults to performance.now. */
	readonly now?: () => number;
	/** Wall-clock anchor; injectable for tests. Defaults to Date.now(). */
	readonly anchorEpochMs?: number;
	/** Reject the handshake if `start` hasn't arrived by then. */
	readonly handshakeTimeoutMs?: number;
	/** What the bench expects the wire to speak. */
	readonly expectedFormat?: MediaFormat;
	/**
	 * Inbound event buffer cap. A consumer that falls this far behind a live
	 * call (default ≈ 40s of media frames) is broken; the session surfaces an
	 * error and ends rather than growing without bound or dropping silently.
	 */
	readonly maxBufferedEvents?: number;
}

/** Async queue: push from the socket handler, pull via for-await. */
class EventQueue {
	readonly #cap: number;
	#buf: TransportEvent[] = [];
	#waiters: Array<(r: IteratorResult<TransportEvent>) => void> = [];
	#done = false;

	constructor(cap: number) {
		this.#cap = cap;
	}

	/** Returns false when the cap is hit; the caller decides what that means. */
	push(ev: TransportEvent): boolean {
		if (this.#done) return true;
		const waiter = this.#waiters.shift();
		if (waiter) {
			waiter({ value: ev, done: false });
			return true;
		}
		if (this.#buf.length >= this.#cap) return false;
		this.#buf.push(ev);
		return true;
	}

	/**
	 * Deliver a terminal event PAST the cap and close the queue. The cap bounds
	 * media buffering; the event that says WHY the session ended must never be
	 * the thing the cap drops — that was a real bug, caught by the overflow
	 * test: the overflow error itself didn't fit in the full buffer.
	 */
	pushTerminal(ev: TransportEvent): void {
		if (this.#done) return;
		const waiter = this.#waiters.shift();
		if (waiter) waiter({ value: ev, done: false });
		else this.#buf.push(ev);
		this.finish();
	}

	finish(): void {
		this.#done = true;
		for (const w of this.#waiters.splice(0)) w({ value: undefined, done: true });
	}

	[Symbol.asyncIterator](): AsyncIterator<TransportEvent> {
		return {
			next: (): Promise<IteratorResult<TransportEvent>> => {
				const buffered = this.#buf.shift();
				if (buffered) return Promise.resolve({ value: buffered, done: false });
				if (this.#done) return Promise.resolve({ value: undefined, done: true });
				return new Promise((r) => this.#waiters.push(r));
			},
		};
	}
}

function formatsEqual(a: MediaFormat, b: MediaFormat): boolean {
	return a.encoding === b.encoding && a.sampleRate === b.sampleRate && a.channels === b.channels;
}

/**
 * Wrap one already-accepted media socket. Resolves once the handshake
 * completes and the declared format matches; rejects (and closes the socket)
 * otherwise. Events on the resolved session begin with `connected` and
 * `started`, stamped at their actual arrival times.
 */
export function createTwilioSession(
	socket: MediaSocket,
	options: TwilioSessionOptions = {},
): Promise<TransportSession> {
	const now = options.now ?? (() => performance.now());
	const zero = now();
	const anchorEpochMs = options.anchorEpochMs ?? Date.now();
	const expected = options.expectedFormat ?? TWILIO_MEDIA_FORMAT;
	const cap = options.maxBufferedEvents ?? 2048;
	const at = () => now() - zero;

	return new Promise<TransportSession>((resolve, reject) => {
		const queue = new EventQueue(cap);
		let streamSid = '';
		let terminal = false;
		let settled = false;

		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			socket.close();
			reject(
				new Error(
					`Twilio handshake incomplete after ${options.handshakeTimeoutMs ?? 10_000}ms — no start event`,
				),
			);
		}, options.handshakeTimeoutMs ?? 10_000);

		const endWith = (ev: TransportEvent) => {
			if (terminal) return;
			terminal = true;
			queue.pushTerminal(ev);
		};

		const pushOrOverflow = (ev: TransportEvent) => {
			if (!queue.push(ev)) {
				DEBUG('transport: inbound buffer overflow', () => ({ streamSid, cap }));
				endWith({
					type: 'error',
					atMs: at(),
					reason: `inbound buffer exceeded ${cap} events; consumer not keeping up with live media`,
				});
				socket.close();
			}
		};

		socket.onMessage((text) => {
			const atMs = at(); // stamped before parsing — the frozen layer
			let msg: ReturnType<typeof parseMessage>;
			try {
				msg = parseMessage(text);
			} catch (e) {
				if (!settled) {
					settled = true;
					clearTimeout(timer);
					socket.close();
					reject(new Error(`malformed message during handshake: ${(e as Error).message}`));
					return;
				}
				endWith({ type: 'error', atMs, reason: `malformed wire message: ${(e as Error).message}` });
				socket.close();
				return;
			}

			switch (msg.event) {
				case 'connected':
					pushOrOverflow({ type: 'connected', atMs });
					return;
				case 'start': {
					if (settled) return; // a second start is wire nonsense; first one wins
					clearTimeout(timer);
					const declared = msg.start.mediaFormat;
					if (!formatsEqual(declared, expected)) {
						settled = true;
						socket.close();
						reject(
							new Error(
								`media format mismatch: wire declared ${JSON.stringify(declared)}, ` +
									`bench speaks ${JSON.stringify(expected)} — refusing to parse garbage`,
							),
						);
						return;
					}
					settled = true;
					streamSid = msg.start.streamSid;
					pushOrOverflow({
						type: 'started',
						atMs,
						format: declared,
						tracks: msg.start.tracks,
					});
					resolve(session);
					return;
				}
				case 'media':
					pushOrOverflow({
						type: 'audio',
						atMs,
						track: msg.media.track,
						bytes: decodePayload(msg.media.payload),
					});
					return;
				case 'dtmf':
					pushOrOverflow({ type: 'dtmf', atMs, digit: msg.dtmf.digit });
					return;
				case 'mark':
					pushOrOverflow({ type: 'mark', atMs, name: msg.mark.name });
					return;
				case 'stop':
					endWith({ type: 'stopped', atMs });
					return;
				case 'unknown':
					// A benign event type Twilio added must not end a live call, and
					// must not vanish either: logged with its payload, not forwarded.
					DEBUG('transport: unknown wire event', () => ({ raw: msg.raw }));
					return;
			}
		});

		socket.onClose(() => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				reject(new Error('socket closed during handshake'));
				return;
			}
			if (!terminal) {
				endWith({ type: 'error', atMs: at(), reason: 'socket closed without a stop event' });
			}
		});

		socket.onError((err) => {
			if (!settled) {
				settled = true;
				clearTimeout(timer);
				socket.close();
				reject(err);
				return;
			}
			endWith({ type: 'error', atMs: at(), reason: `socket error: ${err.message}` });
			socket.close();
		});

		const session: TransportSession = {
			provider: 'twilio',
			get sessionId() {
				return streamSid;
			},
			anchorEpochMs,
			events: queue,
			sendAudio(bytes) {
				if (terminal) return;
				socket.send(mediaMessage(streamSid, bytes));
			},
			sendMark(name) {
				if (terminal) return;
				socket.send(markMessage(streamSid, name));
			},
			clearAudio() {
				if (terminal) return;
				socket.send(clearMessage(streamSid));
			},
			end() {
				if (terminal) return;
				endWith({ type: 'stopped', atMs: at() });
				socket.close();
			},
		};
	});
}
