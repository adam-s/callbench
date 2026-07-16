/**
 * Persona tests — all offline, scripted runners only. These pin the streaming
 * fast path's safety properties, each one the direct product of a red-team
 * finding or a surviving mutation:
 *
 *   - `firstClause` fires only on a CONFIRMED boundary (punctuation followed by
 *     whitespace), never mid-decimal, never on a one-word fragment — so a
 *     control token (`DONE.`) or a number (`3.5`) can never be spoken aloud;
 *   - `nextLineStreaming` hands the first clause to the callback exactly once,
 *     measures `firstClauseMs` from the stream's start, and returns `rest` —
 *     what remains AFTER the spoken clause — so the caller never double-speaks;
 *   - the DONE convention ends the call without a syllable of it reaching TTS;
 *   - a runner that cannot stream falls back to the blocking path intact.
 */

import type { Runner } from '@callbench/judge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { firstClause, isDoneToken } from '../lines.ts';
import { nextLine, nextLineStreaming, type Persona } from '../persona.ts';

afterEach(() => vi.restoreAllMocks());

const persona: Persona = {
	goal: 'Get a windshield replacement quote.',
	background: ['2019 Subaru Outback', 'cracked windshield'],
	maxFreeTurns: 9,
};

/** A blocking runner: one canned reply, no stream. */
const scripted = (raw: string): Runner => ({ id: 'test:scripted', run: async () => raw });

/** A streaming runner yielding the given chunks in order. */
function streaming(chunks: readonly string[]): Runner {
	async function* stream(): AsyncGenerator<string> {
		for (const c of chunks) yield c;
	}
	return { id: 'test:streaming', stream, run: async () => chunks.join('') };
}

describe('firstClause — the TTS handoff boundary', () => {
	it('returns the first clause once its boundary is confirmed by whitespace', () => {
		expect(firstClause('I can do Tuesday. Does that work?')).toBe('I can do Tuesday.');
	});

	it('returns null while punctuation is still the last character (more may come)', () => {
		expect(firstClause('I can do Tuesday.')).toBeNull();
		expect(firstClause('Sure')).toBeNull();
	});

	it('never splits inside a decimal or a price', () => {
		expect(firstClause("It's 3.5 hours flat. Then polish.")).toBe("It's 3.5 hours flat.");
		expect(firstClause('That runs $249.99 all in. Plus tax.')).toBe('That runs $249.99 all in.');
	});

	it('extends past a one-word candidate (abbreviation) to the next boundary', () => {
		expect(firstClause('Okay. Sure thing. And more')).toBe('Okay. Sure thing.');
	});

	it('never returns a DONE-shaped token', () => {
		expect(firstClause('DONE. ')).toBeNull();
		expect(firstClause('"DONE" ')).toBeNull();
		expect(firstClause('DONE! ')).toBeNull();
	});
});

describe('isDoneToken — the control-token shape', () => {
	it('matches the bare token, quoted, and punctuation-trailed forms', () => {
		for (const t of ['DONE', '"DONE"', 'DONE.', "'DONE'", 'DONE!', '  DONE  ']) {
			expect(isDoneToken(t), t).toBe(true);
		}
	});

	it('rejects lowercase and anything beyond the token', () => {
		for (const t of ['done', 'DONE and more', 'All DONE.', 'D O N E']) {
			expect(isDoneToken(t), t).toBe(false);
		}
	});
});

describe('nextLine — the blocking step', () => {
	it('maps DONE (bare or quoted) to the done decision', async () => {
		for (const raw of ['DONE', '"DONE"']) {
			const r = await nextLine(persona, [], 0, scripted(raw));
			expect(r.decision.kind).toBe('done');
		}
	});

	it('truncates a runaway reply at a sentence boundary inside the cap, raw untouched', async () => {
		const raw = `${'x'.repeat(290)} done. ${'y'.repeat(60)}`;
		const r = await nextLine(persona, [], 0, scripted(raw));
		expect(r.decision.kind).toBe('say');
		if (r.decision.kind === 'say') {
			expect(r.decision.text.endsWith('done.')).toBe(true);
			expect(r.decision.text.length).toBeLessThanOrEqual(300);
		}
		expect(r.raw).toBe(raw);
	});
});

describe('nextLineStreaming — the latency fast path', () => {
	it('fires the callback once with the first clause and measures firstClauseMs', async () => {
		// performance.now is scripted: 1000 at stream start, 1450 at clause fire.
		let t = 1000;
		vi.spyOn(performance, 'now').mockImplementation(() => {
			const v = t;
			t += 450;
			return v;
		});
		const fired: string[] = [];
		const r = await nextLineStreaming(
			persona,
			[],
			1,
			streaming(['I can do Tues', 'day at nine. ', 'Does that work', ' for you?']),
			(c) => fired.push(c),
		);
		expect(fired).toEqual(['I can do Tuesday at nine.']);
		expect(r.firstClauseMs).toBe(450);
		expect(r.decision).toEqual({
			kind: 'say',
			text: 'I can do Tuesday at nine. Does that work for you?',
		});
	});

	it('returns rest = the reply minus the already-spoken clause (no double-speak)', async () => {
		const fired: string[] = [];
		const r = await nextLineStreaming(
			persona,
			[],
			1,
			streaming(['I can do Tuesday at nine. ', 'Does that work for you?']),
			(c) => fired.push(c),
		);
		expect(fired).toEqual(['I can do Tuesday at nine.']);
		expect(r.rest).toBe('Does that work for you?');
		if (r.decision.kind === 'say') {
			expect(`${fired[0]} ${r.rest}`).toBe(r.decision.text);
		}
	});

	it('never speaks a decimal fragment: the clause arrives whole', async () => {
		const fired: string[] = [];
		await nextLineStreaming(
			persona,
			[],
			1,
			streaming(["It's 3.", '5 hours flat. ', 'Then polish.']),
			(c) => fired.push(c),
		);
		expect(fired).toEqual(["It's 3.5 hours flat."]);
	});

	it('DONE with trailing punctuation ends the call without reaching the callback', async () => {
		const fired: string[] = [];
		const r = await nextLineStreaming(persona, [], 0, streaming(['DONE', '. ']), (c) =>
			fired.push(c),
		);
		expect(fired).toEqual([]);
		expect(r.decision.kind).toBe('done');
		expect(r.rest).toBe('');
	});

	it('bare streamed DONE ends the call', async () => {
		const r = await nextLineStreaming(persona, [], 0, streaming(['DO', 'NE']), () => {});
		expect(r.decision.kind).toBe('done');
	});

	it('without a callback, rest is the whole line', async () => {
		const r = await nextLineStreaming(persona, [], 1, streaming(['First bit. ', 'Second bit.']));
		expect(r.rest).toBe('First bit. Second bit.');
		expect(r.firstClauseMs).toBeNull();
	});

	it('a DONE appended to prose is stripped from speech and rest, and ends the turn', async () => {
		// The observed leak (take 1784211829214): "…all the info I needed. DONE."
		// was synthesized and spoken. The prose speaks; the token never does.
		const fired: string[] = [];
		const r = await nextLineStreaming(
			persona,
			[],
			0,
			streaming(["Thanks, that's all the info I needed. ", 'DONE.']),
			(c) => fired.push(c),
		);
		expect(r.decision).toEqual({ kind: 'say', text: "Thanks, that's all the info I needed." });
		expect(r.alsoDone).toBe(true);
		expect(r.rest).not.toMatch(/DONE/);
		expect(fired.join(' ')).not.toMatch(/DONE/);
		const blocking = await nextLine(persona, [], 0, scripted('Thanks so much. DONE'));
		expect(blocking.decision).toEqual({ kind: 'say', text: 'Thanks so much.' });
		expect(blocking.alsoDone).toBe(true);
	});

	it('falls back to the blocking path on a runner that cannot stream', async () => {
		const fired: string[] = [];
		const r = await nextLineStreaming(persona, [], 1, scripted('Sure, that works.'), (c) =>
			fired.push(c),
		);
		expect(fired).toEqual([]);
		expect(r.firstClauseMs).toBeNull();
		expect(r.decision).toEqual({ kind: 'say', text: 'Sure, that works.' });
		expect(r.rest).toBe('Sure, that works.');
	});
});
