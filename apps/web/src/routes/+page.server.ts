import { listScenarios } from '$lib/server/runs.ts';
import type { PageServerLoad } from './$types';

/** The index reads every scenario that has a run on disk. Server-side: the
 * frozen artifacts never leave the server except as the rendered summary. */
export const load: PageServerLoad = () => {
	return { scenarios: listScenarios() };
};
