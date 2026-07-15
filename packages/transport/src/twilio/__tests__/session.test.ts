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

describe('handshake', () => {
	it('resolves with identity as data: provider, sessionId, anchor', async () => {
		const { session } = await handshaken();
		expect(session.provider).toBe('twilio');
		expect(session.sessionId).toBe(`MZ${'0'.repeat(32)}`);
		expect(session.anchorEpochMs).toBe(1_784_000_000_000);
	});

	it('delivers connected and started first, stamped at their arrival times', async () => {
		const { socket, session } = await handshaken();
		socket.deliver('{"event":"stop","sequenceNumber":"9","streamSid":"MZx"}');
		const [first, second] = await collect(session);
		expect(first).toEqual({ type: 'connected', atMs: 5 });
		expect(second).toMatchObject({ type: 'started', atMs: 10, tracks: ['inbound'] });
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
});

describe('inbound events', () => {
	it('maps media to audio with decoded bytes and a fresh stamp', async () => {
		const { socket, session, tick } = await handshaken();
		tick(20);
		socket.deliver(silenceText);
		socket.deliver('{"event":"stop","sequenceNumber":"9","streamSid":"MZx"}');
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
		socket.deliver('{"event":"stop","sequenceNumber":"9","streamSid":"MZx"}');
		const events = await collect(session);
		expect(events.some((e) => e.type === 'dtmf' && e.digit === '7')).toBe(true);
		expect(events.some((e) => e.type === 'mark' && e.name === 'utt-1')).toBe(true);
	});

	it('ends iteration at stop, and a later close adds nothing', async () => {
		const { socket, session } = await handshaken();
		socket.deliver('{"event":"stop","sequenceNumber":"9","streamSid":"MZx"}');
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
		socket.deliver('{"event":"stop","sequenceNumber":"9","streamSid":"MZx"}');
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
