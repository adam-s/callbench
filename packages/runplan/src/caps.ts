/**
 * Run caps — the hard bounds a run declares before it starts, and the enforcer
 * that holds them at runtime. This is a product invariant (AGENTS.md): "A run is
 * bounded before it starts — a hard cap on call count, wall-clock minutes, and
 * concurrency, declared in the run's own config and enforced in code. An
 * unbounded default is a bug even if no run ever hits the ceiling."
 *
 * The naive version stores caps and trusts the caller to respect them. That
 * fails the same way every soft limit fails: the one code path that forgets to
 * check is the one that floods a stranger's line. So the enforcement lives in a
 * stateful `RunBudget` whose `started()` THROWS past a cap — a soft "no" a caller
 * can ignore is exactly the failure this avoids.
 *
 * NOTE: no live runner is built yet (the dialer is a later, maintainer-gated
 * increment). Today this enforcer is exercised only by its tests and reached via
 * the pre-flight's plan-time validation. When the dialer lands, it MUST route
 * every call start through `started()` — that wiring is the seam to get right,
 * and it does not exist yet.
 */

export interface RunCaps {
	/** Hard cap on total calls the run may place. */
	readonly maxCalls: number;
	/** Hard cap on wall-clock minutes from the run's start. */
	readonly maxWallClockMinutes: number;
	/** Hard cap on simultaneous calls. Default 1 — one call at a time is the
	 * product's posture, so a run must opt UP deliberately. */
	readonly maxConcurrency: number;
}

/** A positive, finite number — the only kind a cap may be. `Infinity`, `NaN`, 0,
 * and negatives are all "unbounded or nonsensical", which is the bug this
 * rejects. */
function assertPositiveFinite(name: string, value: number): void {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw new Error(
			`run cap "${name}" must be a positive finite number, got ${JSON.stringify(value)}. ` +
				'An unbounded run is a bug even if it never reaches the ceiling.',
		);
	}
}

/** Validate caps, filling the concurrency default (1) if absent. Throws on any
 * unbounded or nonsensical value — a run cannot start without real bounds. */
export function normalizeCaps(caps: {
	maxCalls: number;
	maxWallClockMinutes: number;
	maxConcurrency?: number;
}): RunCaps {
	const maxConcurrency = caps.maxConcurrency ?? 1;
	assertPositiveFinite('maxCalls', caps.maxCalls);
	assertPositiveFinite('maxWallClockMinutes', caps.maxWallClockMinutes);
	assertPositiveFinite('maxConcurrency', maxConcurrency);
	if (!Number.isInteger(caps.maxCalls)) throw new Error('maxCalls must be a whole number of calls');
	if (!Number.isInteger(maxConcurrency)) throw new Error('maxConcurrency must be a whole number');
	return { maxCalls: caps.maxCalls, maxWallClockMinutes: caps.maxWallClockMinutes, maxConcurrency };
}

export interface StartDecision {
	readonly ok: boolean;
	/** Why a call may NOT start, when ok is false — surfaced, never swallowed. */
	readonly reason?: string;
}

/**
 * The stateful cap enforcer. A runner asks `canStart()` and, if it dials, calls
 * `started()` / `ended()` around the call. `started()` THROWS past a cap rather
 * than returning a soft "no", so a runner that ignores `canStart()` still cannot
 * exceed the bound — the enforcement does not depend on the caller's discipline.
 *
 * The clock is injected so the wall-clock cap is testable without real time.
 */
export class RunBudget {
	readonly #caps: RunCaps;
	readonly #now: () => number;
	readonly #startedAtMs: number;
	#callsStarted = 0;
	#active = 0;

	constructor(caps: RunCaps, now: () => number) {
		this.#caps = caps;
		this.#now = now;
		this.#startedAtMs = now();
	}

	get callsStarted(): number {
		return this.#callsStarted;
	}
	get active(): number {
		return this.#active;
	}

	private elapsedMinutes(): number {
		return (this.#now() - this.#startedAtMs) / 60_000;
	}

	/** May a new call start right now? Checks all three caps. */
	canStart(): StartDecision {
		if (this.#callsStarted >= this.#caps.maxCalls) {
			return { ok: false, reason: `call cap reached (${this.#caps.maxCalls} calls)` };
		}
		if (this.elapsedMinutes() >= this.#caps.maxWallClockMinutes) {
			return {
				ok: false,
				reason: `wall-clock cap reached (${this.#caps.maxWallClockMinutes} min)`,
			};
		}
		if (this.#active >= this.#caps.maxConcurrency) {
			return { ok: false, reason: `concurrency cap reached (${this.#caps.maxConcurrency})` };
		}
		return { ok: true };
	}

	/** Record a call starting. THROWS if a cap forbids it — the hard enforcement.
	 * A runner cannot start a call without going through here. */
	started(): void {
		const decision = this.canStart();
		if (!decision.ok) {
			throw new Error(`refusing to start a call: ${decision.reason}`);
		}
		this.#callsStarted++;
		this.#active++;
	}

	/** Record a call ending — frees a concurrency slot. Never goes negative. */
	ended(): void {
		this.#active = Math.max(0, this.#active - 1);
	}
}
