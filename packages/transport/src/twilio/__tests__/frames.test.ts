/**
 * Contract tests for the Twilio wire codec, pinned to messages captured from a
 * real Media Stream (see fixtures/README.md for provenance). These pin the
 * quirks a hand-authored fixture would get wrong — string-typed numbers, the
 * duplicated streamSid — so a "cleanup" that breaks the real wire fails here.
 */

import { describe, expect, it } from 'vitest';
import {
	BYTES_PER_FRAME,
	clearMessage,
	decodePayload,
	MULAW_SILENCE,
	markMessage,
	mediaMessage,
	parseMessage,
	TWILIO_MEDIA_FORMAT,
} from '../frames.ts';
import fixtures from './fixtures/messages.json' with { type: 'json' };

const texts = fixtures.map((f) => f.text);
const [connectedText, startText, silenceText, voicedText] = texts as [
	string,
	string,
	string,
	string,
];

describe('parseMessage against the real capture', () => {
	it('parses the connected handshake', () => {
		const msg = parseMessage(connectedText);
		expect(msg).toEqual({ event: 'connected', protocol: 'Call', version: '1.0.0' });
	});

	it('parses start and the measured media format survives verbatim', () => {
		const msg = parseMessage(startText);
		if (msg.event !== 'start') throw new Error(`expected start, got ${msg.event}`);
		// The frozen fact of Increment 1: this is what the wire actually carries.
		expect(msg.start.mediaFormat).toEqual(TWILIO_MEDIA_FORMAT);
		expect(msg.start.tracks).toEqual(['inbound']);
	});

	it('keeps wire-string fields as strings — the quirk a cleanup would break', () => {
		const start = parseMessage(startText);
		if (start.event !== 'start') throw new Error('not start');
		expect(start.sequenceNumber).toBe('1');
		expect(typeof start.sequenceNumber).toBe('string');

		const media = parseMessage(silenceText);
		if (media.event !== 'media') throw new Error('not media');
		expect(typeof media.media.chunk).toBe('string');
		expect(typeof media.media.timestamp).toBe('string');
	});

	it('carries streamSid both at top level and inside start, equal', () => {
		const msg = parseMessage(startText);
		if (msg.event !== 'start') throw new Error('not start');
		expect(msg.streamSid).toBe(msg.start.streamSid);
		expect(msg.streamSid.startsWith('MZ')).toBe(true);
	});

	it('decodes a real frame to exactly 20ms of mulaw', () => {
		const msg = parseMessage(silenceText);
		if (msg.event !== 'media') throw new Error('not media');
		const bytes = decodePayload(msg.media.payload);
		expect(bytes.length).toBe(BYTES_PER_FRAME);
		expect(bytes.every((b) => b === MULAW_SILENCE)).toBe(true);
	});

	it('distinguishes a voiced frame from digital silence', () => {
		const msg = parseMessage(voicedText);
		if (msg.event !== 'media') throw new Error('not media');
		const bytes = decodePayload(msg.media.payload);
		expect(bytes.length).toBe(BYTES_PER_FRAME);
		expect(bytes.some((b) => b !== MULAW_SILENCE)).toBe(true);
	});

	it('tags an unrecognized event as unknown and preserves it verbatim', () => {
		const msg = parseMessage('{"event":"someFutureThing","x":1}');
		expect(msg).toEqual({ event: 'unknown', raw: { event: 'someFutureThing', x: 1 } });
	});

	it('throws on non-JSON and on JSON non-objects — a broken wire, not a variant', () => {
		expect(() => parseMessage('not json at all')).toThrow();
		expect(() => parseMessage('[1,2,3]')).toThrow(TypeError);
		expect(() => parseMessage('"just a string"')).toThrow(TypeError);
	});
});

describe('outbound builders', () => {
	it('round-trips audio bytes through the media message, headerless', () => {
		const bytes = new Uint8Array(BYTES_PER_FRAME).fill(0x2a);
		const wire = JSON.parse(mediaMessage('MZtest', bytes)) as {
			event: string;
			streamSid: string;
			media: { payload: string };
		};
		expect(Object.keys(wire).sort()).toEqual(['event', 'media', 'streamSid']);
		expect(Object.keys(wire.media)).toEqual(['payload']);
		expect(wire.event).toBe('media');
		expect(decodePayload(wire.media.payload)).toEqual(bytes);
	});

	it('builds mark and clear in the documented shapes', () => {
		expect(JSON.parse(markMessage('MZtest', 'utterance-3'))).toEqual({
			event: 'mark',
			streamSid: 'MZtest',
			mark: { name: 'utterance-3' },
		});
		expect(JSON.parse(clearMessage('MZtest'))).toEqual({
			event: 'clear',
			streamSid: 'MZtest',
		});
	});
});
