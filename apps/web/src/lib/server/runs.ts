/**
 * Server-side run store — the ONLY way the UI reaches evidence. It reads frozen
 * run artifacts off disk and hands the verified objects to the routes; nothing
 * here (or anywhere in the app) records, grades, or dials. This module lives
 * under `$lib/server`, so SvelteKit refuses to ship it to the browser — the
 * capture/interpretation split is enforced by the bundler, not by discipline.
 *
 * Layout on disk:  <runsDir>/<scenario>/<runId>/run.json
 * Every load goes through the scenario package's `readRunArtifact`, which
 * re-hashes the transcript and REFUSES on a mismatch — a drifted file is never
 * rendered as evidence.
 *
 * THE FENCE. A run carries a `target`. A run against the simulator may be
 * replayed and re-run (nobody's line rings); a run against the system under test
 * may only be VIEWED. `canReplay` reads that tag — but the load-bearing
 * guarantee is structural: this app builds NO path that places a call. There is
 * no dial endpoint, no Twilio import, no "run" action. The play control the UI
 * offers replays a frozen recording in the browser; it never reaches a phone.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
	parseRunArtifact,
	RUN_FILENAME,
	type RunArtifact,
	type RunTarget,
} from '@callbench/scenario';
// Relative, not `$lib/*`: this module is imported both by the SvelteKit routes
// (where `$lib` resolves) and by the unit test under plain Vitest (where it does
// not). A relative path resolves in both.
import type { BrokenRun, RunListing, RunSummary, ScenarioSummary } from '../types.ts';

/**
 * Where run artifacts live. Production sets CALLBENCH_RUNS_DIR to the data
 * directory the runner writes to (git-ignored). Unset, it falls back to the
 * committed fixture runs under the app — resolved from the working directory,
 * not from `import.meta.url`, because the bundled server relocates this module
 * and an import-relative path would point into the build output. The dev server
 * and the built server both run from the app directory, so cwd is the stable
 * anchor; the tests bypass this entirely by passing an explicit dir.
 */
function defaultRunsDir(): string {
	const envDir = process.env.CALLBENCH_RUNS_DIR;
	if (envDir) return resolve(envDir);
	return resolve(process.cwd(), 'fixtures/runs');
}

function summarize(artifact: RunArtifact): RunSummary {
	return {
		scenario: artifact.scenario,
		runId: artifact.runId,
		target: artifact.target,
		createdEpochMs: artifact.createdEpochMs,
		counts: artifact.report.counts,
	};
}

function isDir(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function childDirs(path: string): string[] {
	try {
		return readdirSync(path)
			.filter((name) => isDir(join(path, name)))
			.sort();
	} catch {
		return [];
	}
}

/** A path segment (scenario or run id) is used to build a filesystem path, so it
 * must be a single, literal name — no separators, no traversal. A URL segment
 * carrying `/`, `\`, or `..` is rejected before it ever reaches `readFileSync`,
 * closing the arbitrary-path read a decoded `../../…` param would otherwise open. */
function assertSafeSegment(kind: string, value: string): void {
	if (
		value.length === 0 ||
		/[/\\]/.test(value) ||
		value === '.' ||
		value === '..' ||
		value.includes('..')
	) {
		throw new Error(`invalid ${kind} "${value}": not a single path segment`);
	}
}

/** Load and verify one run. Throws (refuses) on a missing file, an unsafe path
 * segment, an unknown version, a hash/body mismatch, or a mislabel — the caller
 * turns that into a 404/500, never a rendered-with-warning page. */
export function loadRun(scenario: string, runId: string, runsDir = defaultRunsDir()): RunArtifact {
	assertSafeSegment('scenario', scenario);
	assertSafeSegment('run id', runId);
	// Belt and suspenders: resolve the file and confirm it stays within runsDir,
	// so even a segment that slipped the check above cannot read outside the tree.
	const root = resolve(runsDir);
	const file = resolve(root, scenario, runId, RUN_FILENAME);
	if (file !== join(root, scenario, runId, RUN_FILENAME)) {
		throw new Error(`refusing to read outside the runs directory for ${scenario}/${runId}`);
	}
	const artifact = parseRunArtifact(readFileSync(file, 'utf8'));
	// Defend the path→identity link: a file whose folder names disagree with its
	// own fields is mislabeled, and a mislabeled artifact is not this run.
	if (artifact.scenario !== scenario || artifact.runId !== runId) {
		throw new Error(
			`run artifact at ${scenario}/${runId} disagrees with its own fields ` +
				`(${artifact.scenario}/${artifact.runId.slice(0, 12)}); refusing to serve a mislabeled run.`,
		);
	}
	return artifact;
}

/**
 * Every run of one scenario, split into the ones that loaded (newest first) and
 * the ones that REFUSED. A corrupt run is surfaced as `broken`, never dropped:
 * nothing else in the UI links to a run that is not in this list, so omitting it
 * would erase evidence silently — against the append-only and
 * surface-interventions invariants. The run's own page still refuses loudly when
 * opened; this makes the intervention discoverable in the first place.
 */
export function listRuns(scenario: string, runsDir = defaultRunsDir()): RunListing {
	const scenarioDir = join(runsDir, scenario);
	const ok: RunSummary[] = [];
	const broken: BrokenRun[] = [];
	for (const runId of childDirs(scenarioDir)) {
		try {
			ok.push(summarize(loadRun(scenario, runId, runsDir)));
		} catch (e) {
			broken.push({ runId, error: e instanceof Error ? e.message : String(e) });
		}
	}
	ok.sort((a, b) => b.createdEpochMs - a.createdEpochMs);
	broken.sort((a, b) => a.runId.localeCompare(b.runId));
	return { ok, broken };
}

/** Every scenario that has at least one run directory on disk — including one
 * whose runs ALL refuse, which is flagged (brokenCount) rather than vanishing. */
export function listScenarios(runsDir = defaultRunsDir()): ScenarioSummary[] {
	return childDirs(runsDir)
		.map((scenario) => {
			const { ok, broken } = listRuns(scenario, runsDir);
			const total = ok.length + broken.length;
			const clean = ok.filter((r) => r.counts.FAIL === 0 && r.counts.INCONCLUSIVE === 0).length;
			return {
				scenario,
				runCount: total,
				brokenCount: broken.length,
				latest: ok[0] ?? null,
				cleanRate: total === 0 ? 0 : clean / total,
			};
		})
		.filter((s) => s.runCount > 0);
}

/**
 * THE FENCE, as a predicate. Only a simulator run may be replayed or re-run —
 * and even then "replay" means playing a frozen recording in the browser, never
 * reaching a phone. A system-under-test run is view-only. This is what the UI
 * consults before offering any active control.
 */
export function canReplay(target: RunTarget): boolean {
	return target === 'simulator';
}
