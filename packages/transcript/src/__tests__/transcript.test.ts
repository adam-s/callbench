/**
 * Transcript tests pin the five invariants of the architectural center:
 * append-only, verbatim, one-clock ordering, hash+freeze, refuse-on-mismatch.
 * These are correctness-critical — a transcript that can be edited, or whose
 * hash doesn't pin its bytes, is how a bench lies about what was said.
 */

import { describe, expect, it } from 'vitest';
import { hashTurns, Transcript, type Turn, verifyFrozen } from '../transcript.ts';

const heard = (over: Partial<Turn> = {}): Turn => ({
	speaker: 'target',
	text: 'we handle recalibration in-house',
	startMs: 1000,
	endMs: 2000,
	confidence: { score: 0.54, raw: { avgLogprob: -0.27, noSpeechProb: 0.002, minWordProb: 0.54 } },
	provider: 'faster-whisper:large-v3',
	...over,
});

const spoke = (over: Partial<Turn> = {}): Turn => ({
	speaker: 'bench',
	text: "I'd like a quote for a windshield",
	startMs: 0,
	endMs: 900,
	confidence: null,
	provider: 'scripted',
	...over,
});

describe('append-only', () => {
	it('accumulates turns in order', () => {
		const t = new Transcript(1_784_000_000_000);
		t.append(spoke());
		t.append(heard());
		expect(t.turns).toHaveLength(2);
		expect(t.turns[0]?.speaker).toBe('bench');
		expect(t.turns[1]?.speaker).toBe('target');
	});

	it('refuses appends after freeze — the record is closed', () => {
		const t = new Transcript(0);
		t.append(spoke());
		t.freeze();
		expect(() => t.append(heard())).toThrow(/frozen/);
	});

	it('hands back a copy, so a caller cannot mutate the record in place', () => {
		const t = new Transcript(0);
		t.append(spoke());
		(t.turns as Turn[]).push(heard()); // mutate the returned array
		expect(t.turns).toHaveLength(1); // the real record is untouched
	});
});

describe('one clock, one layer', () => {
	it('rejects a turn that starts before the previous one', () => {
		const t = new Transcript(0);
		t.append(heard({ startMs: 2000, endMs: 3000 }));
		expect(() => t.append(heard({ startMs: 1000, endMs: 1500 }))).toThrow(/out-of-order/);
	});

	it('rejects a turn that ends before it starts', () => {
		const t = new Transcript(0);
		expect(() => t.append(heard({ startMs: 2000, endMs: 1000 }))).toThrow(/ends before/);
	});

	it('allows adjacent turns that share a boundary', () => {
		const t = new Transcript(0);
		t.append(spoke({ startMs: 0, endMs: 900 }));
		expect(() => t.append(heard({ startMs: 900, endMs: 1800 }))).not.toThrow();
	});
});

describe('confidence and provider travel with the turn', () => {
	it('keeps STT confidence on a heard turn and null on a spoken one', () => {
		const t = new Transcript(0);
		t.append(spoke());
		t.append(heard());
		expect(t.turns[0]?.confidence).toBeNull();
		expect(t.turns[0]?.provider).toBe('scripted');
		expect(t.turns[1]?.confidence?.score).toBe(0.54);
		expect(t.turns[1]?.provider).toBe('faster-whisper:large-v3');
	});
});

describe('hash + freeze', () => {
	it('freezes to a stable hash, idempotently', () => {
		const t = new Transcript(1_784_000_000_000);
		t.append(spoke());
		t.append(heard());
		const a = t.freeze();
		const b = t.freeze();
		expect(a.hash).toBe(b.hash);
		expect(a).toBe(b); // same artifact object
		expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('hashes the CONTENT: any change to a turn changes the hash', () => {
		const base = [spoke(), heard()];
		const h0 = hashTurns(base, 0);
		expect(hashTurns([spoke(), heard({ text: 'DIFFERENT' })], 0)).not.toBe(h0);
		expect(hashTurns([spoke(), heard({ startMs: 1001 })], 0)).not.toBe(h0);
		expect(
			hashTurns([spoke(), heard({ confidence: { score: 0.01, raw: { avgLogprob: -9 } } })], 0),
		).not.toBe(h0);
		// The anchor is part of the identity too.
		expect(hashTurns(base, 1)).not.toBe(h0);
	});

	it('is order-sensitive — swapping two turns changes the hash', () => {
		expect(hashTurns([spoke(), heard()], 0)).not.toBe(hashTurns([heard(), spoke()], 0));
	});
});

describe('refuse on mismatch — the report gate', () => {
	it('verifies a clean frozen artifact', () => {
		const t = new Transcript(0);
		t.append(spoke());
		expect(verifyFrozen(t.freeze())).toBe(true);
	});

	it('fails verification when the turns are tampered but the hash is not', () => {
		const t = new Transcript(0);
		t.append(spoke());
		const frozen = t.freeze();
		const tampered = { ...frozen, turns: [heard()] }; // swap content, keep old hash
		expect(verifyFrozen(tampered)).toBe(false);
	});
});
