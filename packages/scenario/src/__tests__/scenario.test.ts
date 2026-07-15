/**
 * Scenario runner tests — all offline. The runner joins the record phase (drive
 * the simulator) and the assert phase (code + judged assertions) into one
 * report, and these pin what that join must guarantee:
 *
 *   - a scenario drives the simulator to a frozen transcript, and a simulator
 *     defect flips the matching CODE assertion from PASS to FAIL — the same
 *     proof the assert package makes, now through the scenario surface;
 *   - a JUDGED assertion is scored through the judge seam, its verdict kept
 *     separate with full provenance (judgment, not fact), and counted alongside
 *     code results;
 *   - a judged assertion whose material is absent abstains WITHOUT touching the
 *     model (structural INCONCLUSIVE) — proven with a runner that throws if
 *     called;
 *   - the report refuses on a hash mismatch;
 *   - a scenario with judged assertions but no judge context throws rather than
 *     silently skipping the checks.
 *
 * The judge is driven here by a SCRIPTED runner, not the network. That is
 * deliberate: this suite tests the runner's plumbing and merge, while the judge
 * package separately proves the model actually discriminates (its calibration
 * set). Neither suite touches the network.
 */

import type { Runner } from '@callbench/judge';
import { MapCache } from '@callbench/judge';
import { NO_DEFECTS } from '@callbench/simulator';
import { describe, expect, it } from 'vitest';
// The judge's frozen calibration — the record of exactly what rubric was judged
// when the verdicts were generated. Imported here to pin the production rubric
// against it (see the drift test below).
import calibration from '../../../judge/src/__tests__/fixtures/calibration.json' with {
	type: 'json',
};
import { assess, driveSimulator, renderScenarioReport, type Scenario } from '../scenario.ts';
import { DISAMBIGUATION_RUBRIC, windshieldQuote } from '../scenarios.ts';

/** A runner that decides from the prompt text — offline, deterministic. It reads
 * the excerpt the judge was handed and returns PASS if a vehicle question
 * precedes the price, FAIL otherwise. It tests plumbing, not the real model. */
const scriptedRunner: Runner = {
	id: 'scripted:test',
	run: (prompt: string) => {
		const askedVehicle = /year, make, and model|what.?s the year/i.test(prompt);
		const verdict = askedVehicle ? 'PASS' : 'FAIL';
		return Promise.resolve(
			JSON.stringify({ verdict, reasoning: 'scripted from the excerpt for the plumbing test' }),
		);
	},
};

/** A runner that always returns the model's own INCONCLUSIVE — for the case
 * where material IS present but the model judges it insufficient (distinct from
 * the harness's structural abstention). */
const inconclusiveRunner: Runner = {
	id: 'scripted:test',
	run: () =>
		Promise.resolve(
			JSON.stringify({ verdict: 'INCONCLUSIVE', reasoning: 'the model could not tell' }),
		),
};

/** A runner that must never be reached: calling it means the harness consulted
 * the model when it should have abstained structurally. */
const forbiddenRunner: Runner = {
	id: 'scripted:test',
	run: () => {
		throw new Error('the model was consulted when the harness should have abstained');
	},
};

function judgeCtx(runner: Runner) {
	return { runner, cache: new MapCache() };
}

describe('the disambiguation rubric is pinned to the calibrated one — drift would leak to the network', () => {
	// The judge freezes a verdict keyed to a hash of the rubric's criterion, name,
	// and VERSION (judge cacheKey). If the production DISAMBIGUATION_RUBRIC drifts
	// from the rubric the calibration was generated under, every committed verdict
	// becomes unreachable — a production offline run would miss the cache and reach
	// the model, the one thing the freeze exists to prevent, with a green suite.
	// This pins the production constant to the frozen record so drift fails here.
	it('deep-equals the rubric embedded in the frozen calibration', () => {
		expect(DISAMBIGUATION_RUBRIC).toEqual(calibration.rubric);
	});
});

describe('driveSimulator — record phase', () => {
	it('plays the caller turns into the simulator and freezes a valid transcript', () => {
		const t = driveSimulator(windshieldQuote);
		expect(t.turns.length).toBeGreaterThan(0);
		expect(t.turns[0]!.speaker).toBe('bench');
		expect(t.turns.some((x) => x.speaker === 'target')).toBe(true);
		// The record verifies against its own hash.
		expect(t.hash).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('assess — code assertions through the scenario surface', () => {
	it('all PASS on the correct baseline simulator', async () => {
		const t = driveSimulator(windshieldQuote);
		const report = await assess(windshieldQuote, t, judgeCtx(scriptedRunner));
		expect(report.counts.FAIL).toBe(0);
		expect(report.results.every((r) => r.outcome === 'PASS')).toBe(true);
	});

	it('the fabricateCamera defect flips no-fabricated-recalibration to FAIL', async () => {
		const t = driveSimulator(windshieldQuote, { ...NO_DEFECTS, fabricateCamera: true });
		const report = await assess(windshieldQuote, t, judgeCtx(scriptedRunner));
		const fab = report.results.find((r) => r.assertion === 'no-fabricated-recalibration');
		expect(fab?.outcome).toBe('FAIL');
		expect(report.counts.FAIL).toBe(1);
	});
});

describe('assess — judged assertions kept as judgment, counted with the rest', () => {
	it('scores the disambiguation rubric through the judge and records it separately', async () => {
		const t = driveSimulator(windshieldQuote);
		const report = await assess(windshieldQuote, t, judgeCtx(scriptedRunner));
		expect(report.verdicts).toHaveLength(1);
		const v = report.verdicts[0]!;
		expect(v.outcome).toBe('PASS'); // the simulator asks for the vehicle before quoting
		// Provenance a Result would not carry — this is judgment, not fact.
		expect(v.judgedBy).toBe('scripted:test');
		expect(v.rubricVersion).toBe(2);
		expect(v.span).not.toBeNull();
		// The verdict's PASS lands in the counts alongside the passing code
		// results — the merge counts BOTH seams. Count passing code results
		// explicitly rather than lean on results.length (which would agree only
		// while every code result happens to PASS).
		const codePass = report.results.filter((r) => r.outcome === 'PASS').length;
		expect(report.counts.PASS).toBe(codePass + 1);
	});

	it('a model-produced INCONCLUSIVE flows through with a null span and lands in the counts', async () => {
		// Distinct from structural abstention: the material is present (a price
		// turn exists), the model consults it and answers INCONCLUSIVE itself.
		const t = driveSimulator(windshieldQuote);
		const report = await assess(windshieldQuote, t, judgeCtx(inconclusiveRunner));
		const v = report.verdicts[0]!;
		expect(v.outcome).toBe('INCONCLUSIVE');
		expect(v.judgedBy).toBe('scripted:test'); // the MODEL abstained, not the harness
		expect(v.span).toBeNull(); // an INCONCLUSIVE cites no span, judge or code alike
		const codeInconclusive = report.results.filter((r) => r.outcome === 'INCONCLUSIVE').length;
		expect(report.counts.INCONCLUSIVE).toBe(codeInconclusive + 1);
	});

	it('a cache hit replays the verdict offline (cached:true), not a fresh call', async () => {
		const t = driveSimulator(windshieldQuote);
		const ctx = judgeCtx(scriptedRunner);
		const first = await assess(windshieldQuote, t, ctx); // seeds the cache
		expect(first.verdicts[0]!.cached).toBe(false);
		// Same transcript, same shared cache: the second assess replays.
		const second = await assess(windshieldQuote, t, ctx);
		expect(second.verdicts[0]!.cached).toBe(true);
	});
});

describe('structural abstention — the model is never consulted when material is absent', () => {
	// A scenario that never elicits a price: the disambiguation excerpt is absent,
	// so the judged assertion must abstain WITHOUT reaching the runner.
	const noPrice: Scenario = {
		...windshieldQuote,
		caller: ['Hi, are you open today?'],
	};

	it('abstains to INCONCLUSIVE with a harness tag and no span, forbidding the model', async () => {
		const t = driveSimulator(noPrice);
		const report = await assess(noPrice, t, judgeCtx(forbiddenRunner));
		const v = report.verdicts[0]!;
		expect(v.outcome).toBe('INCONCLUSIVE');
		expect(v.span).toBeNull();
		expect(v.judgedBy).toBe('harness'); // the harness abstained, not a model
		// The abstained verdict is counted, not dropped: the headline INCONCLUSIVE
		// count is exactly the code abstentions plus this one. A merge that skips
		// INCONCLUSIVE verdicts would hide a finding and this catches it.
		const codeInconclusive = report.results.filter((r) => r.outcome === 'INCONCLUSIVE').length;
		expect(report.counts.INCONCLUSIVE).toBe(codeInconclusive + 1);
	});

	it('abstains WITHOUT consulting the model when the price turn was heard below the clarity floor', async () => {
		// The excerpt IS present but the price turn's STT confidence is under the
		// floor — feeding it to the judge would launder an unreliable transcription
		// into a confident verdict. The extractor must abstain structurally, so the
		// forbidden runner is never reached. Offline, this only bites because we
		// override the (otherwise perfect) heard confidence.
		const muffled = driveSimulator(windshieldQuote, NO_DEFECTS, {
			heardConfidence: { score: 0.1, raw: { minWordProb: 0.1 } },
		});
		const report = await assess(windshieldQuote, muffled, judgeCtx(forbiddenRunner));
		const v = report.verdicts[0]!;
		expect(v.outcome).toBe('INCONCLUSIVE');
		expect(v.judgedBy).toBe('harness');
		expect(v.reasoning).toMatch(/clarity floor/);
	});
});

describe('the gates', () => {
	it('refuses to assess a transcript whose hash does not match its turns', async () => {
		const t = driveSimulator(windshieldQuote);
		const drifted = { ...t, turns: t.turns.slice(1) }; // drop a turn, keep the hash
		await expect(assess(windshieldQuote, drifted, judgeCtx(scriptedRunner))).rejects.toThrow(
			/refusing to assess/,
		);
	});

	it('throws when a scenario has judged assertions but no judge context', async () => {
		const t = driveSimulator(windshieldQuote);
		await expect(assess(windshieldQuote, t)).rejects.toThrow(/no judge context/);
	});

	it('renders a diffable report with counts, code results, and judged verdicts', async () => {
		const t = driveSimulator(windshieldQuote);
		const report = await assess(windshieldQuote, t, judgeCtx(scriptedRunner));
		const text = renderScenarioReport(report);
		expect(text).toContain('scenario windshield-quote');
		expect(text).toContain('judged by scripted:test');
	});
});
