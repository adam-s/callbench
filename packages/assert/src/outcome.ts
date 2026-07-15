/**
 * The three-state outcome — the point of the assertion layer, and a product
 * invariant (AGENTS.md). Every assertion resolves to exactly one of these, and
 * INCONCLUSIVE is a first-class result, never a soft fail or a swallowed error.
 *
 * The rule the whole design turns on: an assertion that COULD NOT be evaluated
 * — the flow never reached the probe point, the target went silent, the audio
 * was too poor to hear the relevant turn — reports INCONCLUSIVE. It never
 * resolves to PASS (which would claim the system did something right that we
 * never observed) and never to FAIL (which would accuse it of something we
 * never observed). Collapsing the third state into either is how a bench lies,
 * so it is enforced by construction here: an assertion returns a Result, and
 * the only way to build a Result is through the three constructors below.
 */

export type Outcome = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

/**
 * A span into the transcript that a result points at. A finding with no span is
 * not a finding (AGENTS.md), so PASS/FAIL results must carry one; INCONCLUSIVE
 * may not have one precisely because the point it would cite was never reached.
 */
export interface Span {
	/** Index of the turn in the frozen transcript. */
	readonly turnIndex: number;
	/** The turn's start/end on the session clock, copied so the report needn't
	 * re-open the transcript to place the finding in time. */
	readonly startMs: number;
	readonly endMs: number;
}

export interface Result {
	readonly outcome: Outcome;
	/** The assertion's stable name — the same string across runs, so a result
	 * can be tracked run over run. */
	readonly assertion: string;
	/** One line: what was observed and why it is this outcome. The report shows
	 * this verbatim; it is written as observed behavior, not a verdict. */
	readonly detail: string;
	/** The transcript span the result cites. Required for PASS/FAIL, absent for
	 * INCONCLUSIVE (the cited point was never reached). */
	readonly span: Span | null;
}

export function pass(assertion: string, span: Span, detail: string): Result {
	return { outcome: 'PASS', assertion, detail, span };
}

export function fail(assertion: string, span: Span, detail: string): Result {
	return { outcome: 'FAIL', assertion, detail, span };
}

/** INCONCLUSIVE carries no span by design — the point it would cite was never
 * reached. The detail says WHY it could not be evaluated, which is itself the
 * useful signal. */
export function inconclusive(assertion: string, detail: string): Result {
	return { outcome: 'INCONCLUSIVE', assertion, detail, span: null };
}
