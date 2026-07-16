/**
 * Pre-flight for a live run — the operator entry point for Increment 7a. It
 * assembles a bounded run plan from the environment, validates every gate (caps,
 * consent, the plan's own call cap, the connotation pass, an E.164 number), and
 * prints what a human needs to decide to dial. It PLACES NO CALL. The dial is a
 * separate, human, one-at-a-time act, walking the live-call checklist.
 *
 * Usage:  node --env-file=.env scripts/preflight.ts
 *
 * Env:
 *   CALLBENCH_TARGET_NUMBER   the system under test (E.164)
 *   CALLBENCH_MAX_CALLS       hard cap on calls (default 3)
 *   CALLBENCH_MAX_MINUTES     hard wall-clock cap (default 15)
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preflight, type RunPlan, renderPreflight } from '@callbench/runplan';
import { allScenarios } from '@callbench/scenario';

function intFromEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === '') return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
	return n;
}

function main(): void {
	const number = process.env.CALLBENCH_TARGET_NUMBER;
	if (!number) {
		console.error('CALLBENCH_TARGET_NUMBER is not set. Refusing to build a plan without a target.');
		process.exit(1);
	}

	// Plan the reviewed INTERSECTION of the registry, and say aloud what was
	// left out. The first wiring planned the whole registry and let runplan's
	// gate sort it out — but that gate refuses the ENTIRE plan when any
	// scenario lacks its connotation artifact (red-team, 07-16), so the one
	// gate-checked path to a real dial failed closed the moment a deliberately
	// unreviewed adversarial scenario entered the registry. The gate still
	// stands behind this filter: anything unreviewed that reaches the plan
	// anyway is refused there.
	const reviewed = new Set(
		readdirSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'connotation'))
			.filter((f) => f.endsWith('.md'))
			.map((f) => f.replace(/\.md$/, '')),
	);
	const scenarios = allScenarios.map((s) => s.name).filter((n) => reviewed.has(n));
	const excluded = allScenarios.map((s) => s.name).filter((n) => !reviewed.has(n));
	if (excluded.length > 0) {
		console.log(
			`excluded (no connotation artifact yet — simulator-only until reviewed): ${excluded.join(', ')}`,
		);
	}

	const plan: RunPlan = {
		target: { kind: 'system-under-test', number, label: 'system under test' },
		scenarios,
		runsEach: intFromEnv('CALLBENCH_RUNS_EACH', 1),
		caps: {
			maxCalls: intFromEnv('CALLBENCH_MAX_CALLS', 3),
			maxWallClockMinutes: intFromEnv('CALLBENCH_MAX_MINUTES', 15),
			maxConcurrency: 1,
		},
		// Consent for THIS target is settled by the maintainer and recorded in the
		// docs (Increment 7 / warm-up-call). Re-settled if the target changes.
		consentSettled: true,
		// From the COMMITTED artifacts (the `reviewed` set above), never from the
		// plan itself: an earlier wiring fed the gate the plan's own scenario
		// list, a check that could not fail.
		connotationReviewed: [...reviewed],
	};

	let report: ReturnType<typeof preflight>;
	try {
		report = preflight(plan);
	} catch (e) {
		console.error(`\nPRE-FLIGHT FAILED: ${e instanceof Error ? e.message : e}`);
		console.error('No plan is ready; fix the gate above before any dial.');
		process.exit(1);
	}

	console.log(renderPreflight(report));
}

main();
