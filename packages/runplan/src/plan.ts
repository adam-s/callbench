/**
 * The run plan — everything a live run needs decided BEFORE it starts, and the
 * pre-flight that assembles and checks it. The pre-flight's defining property:
 * it prepares a run and STOPS. It places no call. There is no dial in this
 * module or this package; the plan is data, and a human executes it, exactly as
 * the product invariant requires ("The bench prepares a call and stops; a human
 * starts it").
 *
 * Every gate a live run must clear is enforced here, structurally, so a plan that
 * skips one cannot be built:
 *   - CAPS are real bounds (normalizeCaps throws on anything unbounded).
 *   - CONSENT is settled for a system-under-test target (a stranger's line).
 *   - the run cannot exceed its OWN call cap (planned calls ≤ maxCalls).
 *   - the CONNOTATION pass has been done for every scenario whose words will be
 *     spoken on the live call — the outward-text gate (AGENTS.md), enforced by
 *     requiring each run scenario to appear in `connotationReviewed`.
 */

import type { RunTarget } from '@callbench/scenario';
import { normalizeCaps, type RunCaps } from './caps.ts';

export interface DialTarget {
	/** Which realm this number belongs to — the fence's tag. */
	readonly kind: RunTarget;
	/** The number to dial, E.164. Redacted at the log/report boundary. */
	readonly number: string;
	/** A human label for the target, e.g. the shop name or "loopback simulator". */
	readonly label: string;
}

export interface RunPlan {
	readonly target: DialTarget;
	/** Scenario names to run, in order. */
	readonly scenarios: readonly string[];
	/** How many times to run each scenario (a distribution needs more than one). */
	readonly runsEach: number;
	readonly caps: RunCaps;
	/** Consent is settled for this target. Required true for a system-under-test
	 * target; the grounds live in the docs, as the maintainer's decision. */
	readonly consentSettled: boolean;
	/** Scenarios whose outward text (the words spoken on the call) has passed the
	 * connotation pass — each has a committed readings artifact. Every scenario in
	 * `scenarios` must appear here, or the plan is refused. */
	readonly connotationReviewed: readonly string[];
}

/** Basic E.164 shape: a leading +, then 8–15 digits. Not a validity oracle — a
 * guard against an obviously malformed number reaching a dial config. */
function looksE164(n: string): boolean {
	return /^\+\d{8,15}$/.test(n);
}

/**
 * Validate a run plan, returning normalized caps. Throws on any gate not cleared;
 * a plan that returns from here is one a human may execute, dial by dial.
 */
export function validateRunPlan(plan: RunPlan): RunCaps {
	const caps = normalizeCaps(plan.caps);
	if (plan.scenarios.length === 0) {
		throw new Error('run plan has no scenarios; nothing to run.');
	}
	if (!Number.isInteger(plan.runsEach) || plan.runsEach <= 0) {
		throw new Error(
			`runsEach must be a positive whole number, got ${JSON.stringify(plan.runsEach)}.`,
		);
	}
	if (!looksE164(plan.target.number)) {
		throw new Error(
			`target number ${JSON.stringify(plan.target.number)} is not E.164 (+ then 8–15 digits).`,
		);
	}
	// Consent: a stranger's live line may not be dialed without it settled.
	if (plan.target.kind === 'system-under-test' && !plan.consentSettled) {
		throw new Error(
			'refusing a run against the system under test: recording/consent is not marked settled. ' +
				'This is a maintainer decision recorded in the docs, not an agent default.',
		);
	}
	// The run must not exceed its own call cap.
	const plannedCalls = plan.scenarios.length * plan.runsEach;
	if (plannedCalls > caps.maxCalls) {
		throw new Error(
			`this plan would place ${plannedCalls} calls (${plan.scenarios.length} scenarios × ` +
				`${plan.runsEach}) but the call cap is ${caps.maxCalls}. Raise the cap deliberately or ` +
				'run fewer.',
		);
	}
	// The connotation gate: every scenario's outward text must be reviewed.
	const reviewed = new Set(plan.connotationReviewed);
	const unreviewed = plan.scenarios.filter((s) => !reviewed.has(s));
	if (unreviewed.length > 0) {
		throw new Error(
			`refusing to plan a run whose outward text has not passed the connotation pass: ` +
				`${unreviewed.join(', ')}. Produce and show the phrase→readings before the words are ` +
				'spoken to a stranger.',
		);
	}
	return caps;
}

/** Redact a number for a log or report — the last four digits only, never the
 * whole number, because a report may be shared. */
export function redactNumber(n: string): string {
	return n.length <= 4 ? '****' : `${'*'.repeat(Math.max(0, n.length - 4))}${n.slice(-4)}`;
}

export interface PreflightReport {
	readonly target: { kind: RunTarget; label: string; numberRedacted: string };
	readonly scenarios: readonly string[];
	readonly runsEach: number;
	readonly plannedCalls: number;
	readonly caps: RunCaps;
	readonly consentSettled: boolean;
	/** True once every gate passed — the plan is ready for a human to execute. */
	readonly ready: boolean;
}

/**
 * Assemble a pre-flight report from a validated plan. Does NOT dial — it returns
 * what a human needs to decide to dial: the target (number redacted), the
 * scenarios, the planned call count against the cap, the caps, and consent. The
 * caller then walks the live-call checklist, dial by dial.
 */
export function preflight(plan: RunPlan): PreflightReport {
	const caps = validateRunPlan(plan);
	return {
		target: {
			kind: plan.target.kind,
			label: plan.target.label,
			numberRedacted: redactNumber(plan.target.number),
		},
		scenarios: [...plan.scenarios],
		runsEach: plan.runsEach,
		plannedCalls: plan.scenarios.length * plan.runsEach,
		caps,
		consentSettled: plan.consentSettled,
		ready: true,
	};
}

/** Render a pre-flight report as diffable text — ending in the STOP line, so it
 * is unmistakable that this prepared a run and placed no call. */
export function renderPreflight(report: PreflightReport): string {
	return [
		`PRE-FLIGHT — ${report.target.label} [${report.target.kind}] ${report.target.numberRedacted}`,
		`scenarios : ${report.scenarios.join(', ')}`,
		`calls     : ${report.plannedCalls} planned (${report.scenarios.length} × ${report.runsEach}) / cap ${report.caps.maxCalls}`,
		`caps      : ${report.caps.maxCalls} calls, ${report.caps.maxWallClockMinutes} min, concurrency ${report.caps.maxConcurrency}`,
		`consent   : ${report.consentSettled ? 'settled' : 'NOT settled'}`,
		`ready     : ${report.ready ? 'yes' : 'no'}`,
		'',
		'This prepared a run. It placed no call. A human dials, one call at a time,',
		'walking the live-call checklist. No unattended loop starts from here.',
	].join('\n');
}
