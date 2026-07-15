/**
 * Generates calibration.json — the proof the judge DISCRIMINATES. Runs the real
 * judge (claude -p) once over known cases and freezes the verdicts, so the
 * offline suite can replay them and assert the judge got each right when it ran
 * live. NOT part of the suite (it dials the model); re-run by hand to refresh:
 *   node packages/judge/src/__tests__/fixtures/generate-calibration.mjs
 */
import { writeFileSync } from 'node:fs';
import { cacheKey, claudeRunner, judge, MapCache } from '../../index.ts';

const rubric = {
	name: 'asked-disambiguating-question',
	version: 2,
	criterion:
		'Did the agent ask a question that would resolve a genuine ambiguity about the vehicle or the glass (year, trim, sensor/camera variant, OEM vs aftermarket) BEFORE giving any price? A generic greeting is not such a question; asking for the VIN or the year/make/model counts. Procedure: (1) If the excerpt contains no price at all, the "before a price" condition has not been reached — answer INCONCLUSIVE, because the excerpt cannot show whether a question would precede a price that has not happened. (2) If a price appears and a disambiguating question preceded it, PASS. (3) If a price appears with no disambiguating question before it, FAIL.',
};

// Known cases: the expected verdict is what a careful human would say.
const cases = [
	{
		id: 'good',
		expected: 'PASS',
		text: 'CALLER: I need a windshield quote.\nAGENT: Sure — what is the year, make, and model, and does it have a camera or sensor behind the mirror? That changes the glass.',
	},
	{
		id: 'bad',
		expected: 'FAIL',
		text: 'CALLER: I need a windshield quote for my car.\nAGENT: No problem, that will be $299 installed.',
	},
	{
		id: 'ambiguous',
		expected: 'INCONCLUSIVE',
		text: 'AGENT: Thanks for calling, one moment please.',
	},
];

const runner = claudeRunner('sonnet');
const cache = new MapCache();
const out = { rubric, runner: runner.id, cases: [], verdicts: {} };

for (const c of cases) {
	const input = { text: c.text, span: { turnIndex: 1, startMs: 0, endMs: 1000 } };
	const key = cacheKey(rubric, input, runner.id);
	const verdict = await judge(rubric, input, runner, cache);
	console.log(
		`${c.id.padEnd(10)} expected ${c.expected.padEnd(12)} got ${verdict.outcome.padEnd(12)} ${verdict.outcome === c.expected ? 'OK' : 'MISMATCH'}`,
	);
	out.cases.push({ ...c, key, input });
	out.verdicts[key] = {
		outcome: verdict.outcome,
		assertion: verdict.assertion,
		reasoning: verdict.reasoning,
		span: verdict.span,
		judgedBy: verdict.judgedBy,
		rubricVersion: verdict.rubricVersion,
	};
}

writeFileSync(
	new URL('./calibration.json', import.meta.url),
	`${JSON.stringify(out, null, '\t')}\n`,
);
console.log('\nwrote calibration.json');
