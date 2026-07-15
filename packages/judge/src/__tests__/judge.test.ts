/**
 * Judge tests — all offline. The judge calls the network only on a cache miss,
 * and the suite must never reach one; so these seed the cache with the
 * calibration verdicts (frozen from a real claude -p run — see
 * fixtures/generate-calibration.mjs) and assert the judge replays them.
 *
 * What's pinned: the judge DISCRIMINATES (the calibration cases came back
 * PASS/FAIL/INCONCLUSIVE correctly when it ran live), replays deterministically
 * offline, keys its cache on everything a verdict depends on, records judgment
 * not fact, and cannot collapse the third state.
 */

import type { Runner } from '@callbench/judge';
import { cacheKey, judge, MapCache, resolveRunner } from '@callbench/judge';
import { describe, expect, it } from 'vitest';
import calibration from './fixtures/calibration.json' with { type: 'json' };

// A runner that MUST NOT be called: reaching it means a cache miss leaked to the
// network, which is the finding, not a fallback.
const forbiddenRunner: Runner = {
	id: calibration.runner,
	run: () => {
		throw new Error('the judge reached the network under test — a cache miss leaked');
	},
};

function seededCache() {
	return new MapCache(calibration.verdicts as Record<string, never>);
}

const rubric = calibration.rubric;

describe('discrimination — the calibration set (frozen from a live judge run)', () => {
	for (const c of calibration.cases) {
		it(`case "${c.id}" replays ${c.expected} without touching the network`, async () => {
			const v = await judge(rubric, c.input, forbiddenRunner, seededCache());
			expect(v.outcome).toBe(c.expected);
			expect(v.cached).toBe(true); // replayed, not recomputed
		});
	}

	it('actually spans the three states — not all one outcome', () => {
		const outcomes = new Set(calibration.cases.map((c) => c.expected));
		expect(outcomes).toEqual(new Set(['PASS', 'FAIL', 'INCONCLUSIVE']));
	});
});

describe('the cache key covers everything a verdict depends on', () => {
	const input = calibration.cases[0]!.input;
	const base = cacheKey(rubric, input, 'claude:sonnet');

	it('changes when the judged text changes', () => {
		expect(cacheKey(rubric, { ...input, text: `${input.text} extra` }, 'claude:sonnet')).not.toBe(
			base,
		);
	});
	it('changes when the rubric criterion changes', () => {
		expect(cacheKey({ ...rubric, criterion: 'different' }, input, 'claude:sonnet')).not.toBe(base);
	});
	it('changes when the rubric VERSION changes (a rubric change is a measurement change)', () => {
		expect(cacheKey({ ...rubric, version: rubric.version + 1 }, input, 'claude:sonnet')).not.toBe(
			base,
		);
	});
	it('changes when the model changes', () => {
		expect(cacheKey(rubric, input, 'claude:opus')).not.toBe(base);
	});
});

describe('a cache miss is the finding, not a fallback', () => {
	it('reaches the runner (which throws) when the cache is empty', async () => {
		await expect(
			judge(rubric, calibration.cases[0]!.input, forbiddenRunner, new MapCache()),
		).rejects.toThrow(/reached the network/);
	});
});

describe('recorded as judgment, not fact', () => {
	it('a replayed verdict carries its reasoning, model, and rubric version', async () => {
		const v = await judge(rubric, calibration.cases[0]!.input, forbiddenRunner, seededCache());
		expect(v.reasoning.length).toBeGreaterThan(0);
		expect(v.judgedBy).toBe(calibration.runner);
		expect(v.rubricVersion).toBe(rubric.version);
	});

	it('an INCONCLUSIVE verdict cites no span; a PASS/FAIL does', async () => {
		const cache = seededCache();
		for (const c of calibration.cases) {
			const v = await judge(rubric, c.input, forbiddenRunner, cache);
			if (v.outcome === 'INCONCLUSIVE') expect(v.span).toBeNull();
			else expect(v.span).not.toBeNull();
		}
	});
});

describe('the runner seam', () => {
	it('resolves a claude selector', () => {
		expect(resolveRunner('claude:sonnet').id).toBe('claude:sonnet');
	});
	it('rejects an unknown provider with an actionable message', () => {
		expect(() => resolveRunner('mystery:x')).toThrow(/unknown runner/);
	});
});
