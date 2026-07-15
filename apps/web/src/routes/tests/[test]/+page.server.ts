import { error } from '@sveltejs/kit';
import { listRuns, loadRun } from '$lib/server/runs.ts';
import type { PageServerLoad } from './$types';

/**
 * One scenario: every run of it, and the per-assertion matrix across the runs
 * that loaded. Runs that REFUSE (drifted, mislabeled, corrupt) are surfaced as a
 * broken list rather than dropped — the intervention stays visible. The matrix
 * needs each ok run's full results/verdicts, so we re-load the artifact (cheap,
 * a handful of runs); every load re-verifies the hash and body, so a run that
 * loaded in the summary but drifted since surfaces here too.
 */
export const load: PageServerLoad = ({ params }) => {
	const { ok, broken } = listRuns(params.test);
	if (ok.length === 0 && broken.length === 0) {
		error(404, `no runs found for scenario "${params.test}"`);
	}
	const detailed = ok.map((r) => {
		const artifact = loadRun(params.test, r.runId);
		return {
			runId: artifact.runId,
			createdEpochMs: artifact.createdEpochMs,
			target: artifact.target,
			results: artifact.report.results,
			verdicts: artifact.report.verdicts,
			counts: artifact.report.counts,
		};
	});
	return { scenario: params.test, runs: detailed, broken };
};
