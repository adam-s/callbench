/**
 * Adapter behavior tests: real fixture messages through a fake socket with a
 * hand-cranked clock. What gets pinned here is the session's honesty — stamps
 * from the frozen clock/layer, handshake refusals, surfaced errors, bounded
 * buffering — not the wire shapes, which frames.test.ts already pins.
 */

import { describe, expect, it } from 'vitest';
import type { TransportEvent, TransportSession } from '../../contract.ts';
import { createTwilioSession, type MediaSocket } from '../session.ts';
import fixtures from './fixtures/messages.json' with { type: 'json' };

const [connectedText, startText, silenceText] = fixtures.map((f) => f.text) as [
	string,
	string,
	string,
	string,
];

class FakeSocket implements MediaSocket {
	sent: string[] = [];
	closed = false;
	#onMessage: ((text: string) => void) | undefined;
	#onClose: (() => void) | undefined;
	#onError: ((err: Error) => void) | undefined;

	send(text: string): void {
		this.sent.push(text);
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.#onClose?.();
	}
	onMessage(cb: (text: string) => void): void {
		this.#onMessage = cb;
	}
	onClose(cb: () => void): void {
		this.#onClose = cb;
	}
	onError(cb: (err: Error) => void): void {
		this.#onError = cb;
	}

	// test-side controls
	deliver(text: string): void {
		this.#onMessage?.(text);
	}
	dropConnection(): void {
		this.#onClose?.();
	}
	failWith(err: Error): void {
		this.#onError?.(err);
	}
}

/** Hand-cranked monotonic clock. */
function fakeClock(startAt = 0) {
	let t = startAt;
	const now = () => t;
	return { now, tick: (ms: number) => (t += ms) };
}

/**
 * A clock that advances a fixed step on EVERY read. This is the oracle the
 * red-team asked for: the stamp is `now()` read at the top of the message
 * handler, before parsing. With a per-read clock, "stamp before parse" and
 * "stamp after parse" produce DIFFERENT values — an implementation that moved
 * the read below `parseMessage` would fail the assertions below. A clock that
 * only moves on explicit ticks cannot tell the two apart.
 */
function tickingClock(step: number) {
	let reads = 0;
	return { now: () => reads++ * step, readsSoFar: () => reads };
}

async function handshaken(
	overrides: Partial<Parameters<typeof createTwilioSession>[1]> = {},
): Promise<{ socket: FakeSocket; session: TransportSession; tick: (ms: number) => number }> {
	const socket = new FakeSocket();
	const clock = fakeClock();
	const pending = createTwilioSession(socket, {
		now: clock.now,
		anchorEpochMs: 1_784_000_000_000,
		...overrides,
	});
	clock.tick(5);
	socket.deliver(connectedText);
	clock.tick(5);
	socket.deliver(startText);
	return { socket, session: await pending, tick: clock.tick };
}

async function collect(session: TransportSession): Promise<TransportEvent[]> {
	const events: TransportEvent[] = [];
	for await (const ev of session.events) events.push(ev);
	return events;
}

// The wire's real stop shape (nested stop object), not the bare subset the
// adapter happens to need — a fixture pinned to an assumption catches no drift.
const STOP = JSON.stringify({
	event: 'stop',
	sequenceNumber: '9',
	streamSid: `MZ${'0'.repeat(32)}`,
	stop: { accountSid: `AC${'0'.repeat(32)}`, callSid: `CA${'0'.repeat(32)}` },
});

describe('handshake', () => {
	it('resolves with identity as data: provider, sessionId, anchor', async () => {
		const { session } = await handshaken();
		expect(session.provider).toBe('twilio');
		expect(session.sessionId).toBe(`MZ${'0'.repeat(32)}`);
		expect(session.anchorEpochMs).toBe(1_784_000_000_000);
	});

	it('delivers connected and started first, stamped at their arrival times', async () => {
		const { socket, session } = await handshaken();
		socket.deliver(STOP);
		const [first, second] = await collect(session);
		expect(first).toEqual({ type: 'connected', atMs: 5 });
		expect(second).toEqual({
			type: 'started',
			atMs: 10,
			tracks: ['inbound'],
			format: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
		});
	});

	it('refuses a format the bench does not speak, before any session exists', async () => {
		const socket = new FakeSocket();
		const pending = createTwilioSession(socket, {});
		socket.deliver(connectedText);
		socket.deliver(startText.replace('"sampleRate":8000', '"sampleRate":16000'));
		await expect(pending).rejects.toThrow(/format mismatch/);
		expect(socket.closed).toBe(true);
	});

	it('rejects when start never arrives, within the bound', async () => {
		const socket = new FakeSocket();
		const pending = createTwilioSession(socket, { handshakeTimeoutMs: 20 });
		socket.deliver(connectedText);
		await expect(pending).rejects.toThrow(/handshake incomplete/);
		expect(socket.closed).toBe(true);
	});

	it('rejects when the socket drops mid-handshake', async () => {
		const socket = new FakeSocket();
		const pending = createTwilioSession(socket, {});
		socket.deliver(connectedText);
		socket.dropConnection();
		await expect(pending).rejects.toThrow(/closed during handshake/);
	});

	it('rejects when the socket errors mid-handshake', async () => {
		const socket = new FakeSocket();
		const pending = createTwilioSession(socket, {});
		socket.deliver(connectedText);
		socket.failWith(new Error('econnreset'));
		await expect(pending).rejects.toThrow(/econnreset/);
		expect(socket.closed).toBe(true);
	});
});

describe('the stamp layer — before parse, once per message', () => {
	// The headline frozen fact: atMs is read at the top of the message handler,
	// before parseMessage. A per-read clock is the only oracle that discriminates
	// entry-stamping from re-stamping — the hand-cranked clock cannot, because it
	// does not move between the two positions.
	it('stamps a malformed message from the entry read, not a re-read in the catch', async () => {
		const socket = new FakeSocket();
		const clock = tickingClock(100); // +100ms per clock read
		const pending = createTwilioSession(socket, { now: clock.now });
		socket.deliver(connectedText); // entry read #1 -> 100
		socket.deliver(startText); // entry read #2 -> 200, resolves
		const session = await pending;
		socket.deliver('not json'); // entry read #3 -> 300; parse throws
		const events = await collect(session);
		const err = events.at(-1);
		if (err?.type !== 'error') throw new Error(`expected error, got ${err?.type}`);
		// 300 = the stamp taken on entry, before the throw. A regression that
		// re-read the clock inside the catch would produce 400.
		expect(err.atMs).toBe(300);
	});

	it('takes exactly one clock read per message (monotonic single-step)', async () => {
		const socket = new FakeSocket();
		const clock = tickingClock(100);
		// No `zero` option: construction consumes read #0 (-> 0) as the baseline,
		// so each message's single entry read is 100, 200, 300 — an extra clock
		// read anywhere in the handler path would break this exact-step sequence.
		const pending = createTwilioSession(socket, { now: clock.now });
		socket.deliver(connectedText); // read #1 -> 100
		socket.deliver(startText); // read #2 -> 200
		const session = await pending;
		socket.deliver(silenceText); // read #3 -> 300
		socket.deliver(STOP); // read #4 -> 400
		const [connected, started, audio] = await collect(session);
		expect(connected?.atMs).toBe(100);
		expect(started?.atMs).toBe(200);
		expect(audio?.atMs).toBe(300);
	});
});

describe('EventQueue waiter path (parked consumer, slow producer)', () => {
	// Every other test delivers all messages before iterating, so the buffer is
	// always pre-populated and next() never parks a waiter. That is the OPPOSITE
	// of a live call, where the consumer waits and frames trickle in. These
	// exercise the waiter branches directly.
	it('delivers to a consumer that is already waiting', async () => {
		const { socket, session } = await handshaken();
		const iterator = session.events[Symbol.asyncIterator]();
		void (await iterator.next()); // drain connected
		void (await iterator.next()); // drain started
		const pending = iterator.next(); // now PARKED — no buffered events
		socket.deliver(silenceText); // arrives to a waiter, not a buffer
		const result = await pending;
		expect(result.done).toBe(false);
		if (result.value.type !== 'audio') throw new Error('expected audio');
		expect(result.value.bytes.length).toBe(160);
	});

	it('delivers a terminal event to a parked consumer and then ends', async () => {
		const { socket, session } = await handshaken();
		const iterator = session.events[Symbol.asyncIterator]();
		void (await iterator.next());
		void (await iterator.next());
		const pending = iterator.next(); // parked
		socket.dropConnection(); // terminal error to a waiter
		const result = await pending;
		if (result.done !== false || result.value.type !== 'error') {
			throw new Error('expected a terminal error event to the parked waiter');
		}
		expect((await iterator.next()).done).toBe(true);
	});
});

describe('shared zero', () => {
	it('anchors several sessions to one axis when the runner asks', async () => {
		// Two sessions, one clock, zero: 0 for both — a stamp is the clock's own
		// value, so cross-session subtraction is legitimate. This is the loopback
		// configuration; without zero, each session re-anchors at creation and
		// cross-session math is garbage (measured: a negative 43s "latency").
		const clock = fakeClock(1000); // clock already ran before either session
		const make = async () => {
			const socket = new FakeSocket();
			const pending = createTwilioSession(socket, { now: clock.now, zero: 0 });
			socket.deliver(connectedText);
			socket.deliver(startText);
			return { socket, session: await pending };
		};
		const a = await make();
		clock.tick(500);
		const b = await make();
		a.socket.deliver(STOP);
		b.socket.deliver(STOP);
		const [aFirst] = await collect(a.session);
		const [bFirst] = await collect(b.session);
		if (!aFirst || !bFirst) throw new Error('missing events');
		expect(aFirst.atMs).toBe(1000);
		expect(bFirst.atMs).toBe(1500); // same axis: later session, later stamp
	});
});

describe('inbound events', () => {
	it('maps media to audio with decoded bytes and a fresh stamp', async () => {
		const { socket, session, tick } = await handshaken();
		tick(20);
		socket.deliver(silenceText);
		socket.deliver(STOP);
		const events = await collect(session);
		const audio = events.find((e) => e.type === 'audio');
		if (audio?.type !== 'audio') throw new Error('no audio event');
		expect(audio.atMs).toBe(30);
		expect(audio.track).toBe('inbound');
		expect(audio.bytes.length).toBe(160);
	});

	it('maps dtmf and mark', async () => {
		const { socket, session } = await handshaken();
		socket.deliver('{"event":"dtmf","dtmf":{"track":"inbound_track","digit":"7"}}');
		socket.deliver('{"event":"mark","mark":{"name":"utt-1"}}');
		socket.deliver(STOP);
		const events = await collect(session);
		expect(events.some((e) => e.type === 'dtmf' && e.digit === '7')).toBe(true);
		expect(events.some((e) => e.type === 'mark' && e.name === 'utt-1')).toBe(true);
	});

	it('ends iteration at stop, and a later close adds nothing', async () => {
		const { socket, session } = await handshaken();
		socket.deliver(STOP);
		socket.dropConnection();
		const events = await collect(session);
		expect(events.at(-1)?.type).toBe('stopped');
		expect(events.filter((e) => e.type === 'error')).toEqual([]);
	});

	it('surfaces a drop without stop as an error, never silently', async () => {
		const { socket, session } = await handshaken();
		socket.dropConnection();
		const events = await collect(session);
		const last = events.at(-1);
		if (last?.type !== 'error') throw new Error(`expected error, got ${last?.type}`);
		expect(last.reason).toMatch(/without a stop/);
	});

	it('surfaces malformed mid-call messages as an error and ends', async () => {
		const { socket, session } = await handshaken();
		socket.deliver('this is not json');
		const events = await collect(session);
		expect(events.at(-1)).toMatchObject({ type: 'error' });
		expect(socket.closed).toBe(true);
	});

	it('ignores unknown-but-well-formed events instead of ending a live call', async () => {
		const { socket, session } = await handshaken();
		socket.deliver('{"event":"someFutureThing","x":1}');
		socket.deliver(silenceText);
		socket.deliver(STOP);
		const events = await collect(session);
		expect(events.map((e) => e.type)).toEqual(['connected', 'started', 'audio', 'stopped']);
	});

	it('bounds the inbound buffer and surfaces overflow as an error', async () => {
		const { socket, session } = await handshaken({ maxBufferedEvents: 3 });
		for (let i = 0; i < 6; i++) socket.deliver(silenceText);
		const events = await collect(session);
		const last = events.at(-1);
		if (last?.type !== 'error') throw new Error(`expected error, got ${last?.type}`);
		expect(last.reason).toMatch(/buffer exceeded/);
		expect(socket.closed).toBe(true);
	});
});

describe('outbound', () => {
	it('paces a multi-frame payload instead of dumping it on the wire', async () => {
		// The pacer's own tests prove it PACES. This one proves sendAudio USES it.
		// Without it, ripping the pacer out of sendAudio leaves every transport test
		// green — the same hole the dial guard had, where a well-tested mechanism
		// sat behind an unpinned call site.
		//
		// One second of audio (50 frames). Dumped, all 50 hit the socket at once and
		// Twilio discards the overflow (31931) while `mark` still fires — the far end
		// simply hears less than was said, and nothing errors.
		const { socket, session } = await handshaken();
		session.sendAudio(new Uint8Array(160 * 50).fill(0x2a));

		// Assert on the PAYLOAD, not the message count. A first attempt at this test
		// checked `sent.length < 50` and passed the mutation cleanly — because
		// dumping does not produce 50 messages, it produces ONE carrying all 8000
		// bytes. The count is 1, which is happily under 50. The property that
		// actually distinguishes them is the size of what each message carries.
		const payloads = socket.sent
			.map((raw) => JSON.parse(raw) as { event: string; media?: { payload: string } })
			.filter((m) => m.event === 'media')
			.map((m) => Buffer.from(m.media?.payload ?? '', 'base64').length);

		expect(payloads.length).toBeGreaterThan(0); // the lead leaves immediately
		for (const size of payloads) expect(size).toBe(160); // one frame each, never the whole utterance
		expect(payloads.length).toBeLessThan(50); // and the rest is still on a schedule
		session.end();
	});

	it('sends media, mark, and clear carrying the real streamSid', async () => {
		const { socket, session } = await handshaken();
		session.sendAudio(new Uint8Array(160).fill(0x2a));
		session.sendMark('utt-1');
		session.clearAudio();
		const [media, mark, clear] = socket.sent.map((s) => JSON.parse(s) as { streamSid: string });
		expect(media?.streamSid).toBe(session.sessionId);
		expect(mark?.streamSid).toBe(session.sessionId);
		expect(clear?.streamSid).toBe(session.sessionId);
	});

	it('end() emits stopped, closes the socket, and is idempotent', async () => {
		const { socket, session } = await handshaken();
		session.end();
		session.end();
		session.sendAudio(new Uint8Array(160)); // after end: dropped, not sent
		const events = await collect(session);
		expect(events.at(-1)?.type).toBe('stopped');
		expect(events.filter((e) => e.type === 'stopped')).toHaveLength(1);
		expect(socket.closed).toBe(true);
		expect(socket.sent).toEqual([]);
	});
});
