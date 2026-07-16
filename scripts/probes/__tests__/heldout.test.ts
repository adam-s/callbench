/**
 * The held-out sets are only held out if nothing enforces forgetting them —
 * so something must. These pins are structural: they cannot prove the prompt
 * AUTHOR never read the files (that is a provenance claim recorded in each
 * file's $comment), but they refuse the two concrete ways held-out material
 * leaks after the fact and turns the evaluation into a memorized answer key:
 *
 *   1. a held-out utterance migrating into the development case set (the
 *      cases the extraction prompt is iterated against), and
 *   2. a held-out utterance quoted into the prompt template itself.
 *
 * Red-team finding (07-16): the extraction fixtures were read by no test at
 * all, so either leak would have shipped green. "Keep the answer out of the
 * exam paper" (AGENTS.md) is the principle; these are its regression tests.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const PROMPTS = join(import.meta.dirname, '..', 'prompts');

interface HeldoutFile {
	conversations: Array<{
		id: string;
		turns: Array<{ speaker: string; text: string }>;
	}>;
}
interface CasesFile {
	cases: Array<{ id: string; utterance: string }>;
}

const readJson = <T>(name: string): T =>
	JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;

const heldout: Array<[string, HeldoutFile]> = [
	['heldout-a.json', readJson<HeldoutFile>('heldout-a.json')],
	['heldout-b.json', readJson<HeldoutFile>('heldout-b.json')],
];
const cases = readJson<CasesFile>('extraction-cases.json').cases;

/** Normalize for comparison: case- and whitespace-insensitive, so a leak
 * cannot hide behind reflowing. */
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Only substantive utterances count toward a leak. Conversational filler
 * ("Sure.", "Okay.") legitimately recurs across independently-authored sets —
 * the first run of this suite tripped on exactly that — and a leak that fits
 * in twenty characters carries no distinguishing content to memorize. */
const SUBSTANTIVE = 20;
const substantive = (t: { text: string }) => norm(t.text).length >= SUBSTANTIVE;

describe('the held-out sets stay held out', () => {
	it('both sets are non-empty and carry turns — a silently emptied set holds nothing out', () => {
		for (const [name, file] of heldout) {
			expect(file.conversations.length, name).toBeGreaterThan(0);
			for (const c of file.conversations) {
				expect(c.turns.length, `${name} ${c.id}`).toBeGreaterThan(0);
			}
		}
	});

	it('no held-out utterance appears in the development case set, in either direction', () => {
		const caseTexts = cases.map((c) => norm(c.utterance)).filter((t) => t.length >= SUBSTANTIVE);
		for (const [name, file] of heldout) {
			for (const conv of file.conversations) {
				for (const turn of conv.turns.filter(substantive)) {
					const t = norm(turn.text);
					for (const dev of caseTexts) {
						expect(
							t.includes(dev) || dev.includes(t),
							`${name} ${conv.id} shares an utterance with a development case: "${turn.text.slice(0, 80)}"`,
						).toBe(false);
					}
				}
			}
		}
	});

	it('no held-out utterance is quoted in the extraction prompt template', () => {
		const prompt = norm(readFileSync(join(PROMPTS, 'extract.md'), 'utf8'));
		for (const [name, file] of heldout) {
			for (const conv of file.conversations) {
				for (const turn of conv.turns.filter(substantive)) {
					expect(
						prompt.includes(norm(turn.text)),
						`${name} ${conv.id} is quoted in extract.md: "${turn.text.slice(0, 80)}"`,
					).toBe(false);
				}
			}
		}
	});

	it('the two held-out sets are disjoint from each other — B was written adversarially against A', () => {
		const [, a] = heldout[0] as [string, HeldoutFile];
		const [, b] = heldout[1] as [string, HeldoutFile];
		const aTexts = new Set(
			a.conversations.flatMap((c) => c.turns.filter(substantive).map((t) => norm(t.text))),
		);
		for (const conv of b.conversations) {
			for (const turn of conv.turns.filter(substantive)) {
				expect(aTexts.has(norm(turn.text)), `heldout-b ${conv.id} repeats a heldout-a turn`).toBe(
					false,
				);
			}
		}
	});
});
