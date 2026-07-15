import { listScenarios } from '$lib/server/runs.ts';
import type { LayoutServerLoad } from './$types';

/** The rail lists every scenario with evidence on disk, on every page — the
 * app is small enough that the whole map fits in the chrome. */
export const load: LayoutServerLoad = () => {
	return { railScenarios: listScenarios().map((s) => s.scenario) };
};
