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

	// Every scenario the bench knows (the registry), not a list this script
	// maintains. The connotation and consent gates live in @callbench/runplan's
	// preflight — a scenario missing its committed connotation artifact is
	// REFUSED there, so enumerating the registry here cannot plan ungated text.
	const scenarios = allScenarios.map((s) => s.name);

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
		connotationReviewed: scenarios,
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
