/**
 * Shared, client-safe types and pure helpers. No node imports, no server-only
 * code — so both the server load functions and the Svelte components can import
 * from here. The server-only file system access lives in `$lib/server/runs.ts`;
 * this file is just the shapes that cross the load boundary and the pure
 * functions that render them.
 */

import type { Outcome, Result } from '@callbench/assert';
import type { RunTarget } from '@callbench/scenario';

export type { Outcome, RunTarget };

/** Counts of the three outcomes — the report's headline, carried on every run. */
export type Counts = Readonly<Record<Outcome, number>>;

/** A run reduced to what a list needs — no transcript, no verdicts. */
export interface RunSummary {
	readonly scenario: string;
	readonly runId: string;
	readonly target: RunTarget;
	readonly createdEpochMs: number;
	readonly counts: Counts;
}

/** A run that exists on disk but would not load — a drifted, mislabeled, or
 * corrupt artifact. It is surfaced, never dropped: history is append-only, and a
 * refused artifact is an intervention the operator must see, not a row to hide. */
export interface BrokenRun {
	readonly runId: string;
	readonly error: string;
}

/** Every run of a scenario: the ones that loaded, and the ones that refused. */
export interface RunListing {
	readonly ok: readonly RunSummary[];
	readonly broken: readonly BrokenRun[];
}

/** A scenario reduced to what the index needs. */
export interface ScenarioSummary {
	readonly scenario: string;
	readonly runCount: number;
	/** How many of those runs would not load — surfaced so a scenario whose
	 * evidence is corrupt is visibly flagged, not silently clean-looking. */
	readonly brokenCount: number;
	readonly latest: RunSummary | null;
	readonly cleanRate: number;
}

/**
 * The single outcome that best summarizes a set of counts, by severity:
 * FAIL beats INCONCLUSIVE beats PASS. A reader scanning a list should have the
 * most-alarming real state pulled to the top — but INCONCLUSIVE is never
 * collapsed into PASS, it ranks above it as its own state.
 */
export function worstOutcome(counts: Counts): Outcome {
	if (counts.FAIL > 0) return 'FAIL';
	if (counts.INCONCLUSIVE > 0) return 'INCONCLUSIVE';
	return 'PASS';
}

/** A short, stable label for a run — the first 12 hex of its id. */
export function shortRun(runId: string): string {
	return runId.slice(0, 12);
}

/** A result's span rendered as a compact location, or a note that it has none
 * (INCONCLUSIVE cites no span — that absence is itself information). */
export function whereOf(result: Pick<Result, 'span'>): string {
	return result.span
		? `turn ${result.span.turnIndex} · ${result.span.startMs}–${result.span.endMs}ms`
		: 'no span reached';
}
