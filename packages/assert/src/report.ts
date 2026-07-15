/**
 * The report — the deterministic summary a human reads. Two invariants:
 *
 *   - **Refuse on hash mismatch.** The report is a function of the FROZEN
 *     artifact; before it renders anything, it re-verifies the transcript
 *     against its own hash. A drifted artifact refuses the report rather than
 *     publishing a figure that no longer describes the call it claims to
 *     (AGENTS.md). This is why `buildReport` can throw — a refusal is louder
 *     than a footnote.
 *   - **Every finding cites its span.** A PASS/FAIL result carries a transcript
 *     span; the report shows it, so a reader can trace the finding to what was
 *     said and when. A claim with no traceable span is not a finding.
 *
 * The output is diffable: stable ordering, the counts first, so two runs of the
 * same scenario diff cleanly and a change in outcome is visible at a glance.
 */

import { type FrozenTranscript, verifyFrozen } from '@callbench/transcript';
import type { Outcome, Result } from './outcome.ts';

export interface Report {
	readonly hash: string;
	readonly counts: Readonly<Record<Outcome, number>>;
	readonly results: readonly Result[];
}

/**
 * Build a report from a frozen transcript and its assertion results. Throws if
 * the transcript's hash no longer matches its turns — a drifted record does not
 * get a report.
 */
export function buildReport(transcript: FrozenTranscript, results: readonly Result[]): Report {
	if (!verifyFrozen(transcript)) {
		throw new Error(
			`refusing to build a report: the transcript hash does not match its turns. ` +
				'The record drifted from what was frozen; a figure from it would be a lie.',
		);
	}
	const counts: Record<Outcome, number> = { PASS: 0, FAIL: 0, INCONCLUSIVE: 0 };
	for (const r of results) counts[r.outcome]++;
	return { hash: transcript.hash, counts, results: [...results] };
}

/** Render a report as diffable text. Counts first (the headline), then one line
 * per result with its outcome, name, span, and detail. */
export function renderReport(report: Report): string {
	const { counts } = report;
	const lines: string[] = [
		`transcript ${report.hash.slice(0, 16)}`,
		`PASS ${counts.PASS}  FAIL ${counts.FAIL}  INCONCLUSIVE ${counts.INCONCLUSIVE}`,
		'',
	];
	for (const r of report.results) {
		const where = r.span
			? `@turn ${r.span.turnIndex} [${r.span.startMs}-${r.span.endMs}ms]`
			: '(no span reached)';
		lines.push(`${r.outcome.padEnd(12)} ${r.assertion}  ${where}`);
		lines.push(`             ${r.detail}`);
	}
	return lines.join('\n');
}
