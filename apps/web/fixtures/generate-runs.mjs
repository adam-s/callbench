/**
 * Generates the committed fixture runs the UI renders — deterministic scenario
 * runs over the simulator, frozen to run.json artifacts. NOT part of the test
 * suite (the judged assertion calls the real model once); re-run by hand to
 * refresh:
 *
 *   node apps/web/fixtures/generate-runs.mjs
 *
 * Two runs of the windshield-quote scenario:
 *   - baseline (no defects)      → all assertions PASS
 *   - fabricateCamera defect on  → no-fabricated-recalibration FAILs
 * Both share one judge cache, so the disambiguation verdict (same excerpt in
 * both — the camera answer comes after the price, outside the excerpt) costs a
 * single real model call, frozen into both artifacts.
 *
 * These are SIMULATOR runs: target 'simulator', replayable, nobody's line rings.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeRunner, MapCache } from '@callbench/judge';
import {
	assess,
	buildRunArtifact,
	driveSimulator,
	serializeRunArtifact,
	windshieldQuote,
} from '@callbench/scenario';

const here = dirname(fileURLToPath(import.meta.url));
const runsRoot = join(here, 'runs');

const runner = claudeRunner('sonnet');
const cache = new MapCache();

// A stable base epoch so regenerated fixtures diff cleanly; the two runs are
// spaced a minute apart so "newest first" ordering is well-defined.
const BASE_EPOCH = 1_784_000_000_000;

const NO_DEFECTS = { fabricateCamera: false, dropCorrection: false, goSilentAtQuote: false };

const specs = [
	{ label: 'baseline', defects: NO_DEFECTS, createdEpochMs: BASE_EPOCH },
	{
		label: 'fabricateCamera',
		defects: { ...NO_DEFECTS, fabricateCamera: true },
		createdEpochMs: BASE_EPOCH + 60_000,
	},
];

// Fresh start so a removed/renamed run never lingers.
rmSync(join(runsRoot, windshieldQuote.name), { recursive: true, force: true });

for (const spec of specs) {
	const transcript = driveSimulator(windshieldQuote, spec.defects);
	const report = await assess(windshieldQuote, transcript, { runner, cache });
	const artifact = buildRunArtifact(
		windshieldQuote.name,
		'simulator',
		transcript,
		report,
		spec.createdEpochMs,
	);
	const dir = join(runsRoot, artifact.scenario, artifact.runId);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, 'run.json'), serializeRunArtifact(artifact));
	const { PASS, FAIL, INCONCLUSIVE } = report.counts;
	console.log(
		`${spec.label.padEnd(16)} run ${artifact.runId.slice(0, 12)}  PASS ${PASS} FAIL ${FAIL} INCONCLUSIVE ${INCONCLUSIVE}`,
	);
}

console.log(`\nwrote fixtures under ${join(runsRoot, windshieldQuote.name)}`);
