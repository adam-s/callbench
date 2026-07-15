/**
 * Run-plan tests — the bounds and gates a live run must clear before it starts.
 * What's pinned, all offline:
 *   - caps must be REAL bounds: unbounded / nonsensical values are refused;
 *   - the RunBudget ENFORCES the caps — started() throws past a cap, so a runner
 *     that ignores canStart() still cannot exceed the bound;
 *   - concurrency defaults to 1;
 *   - the plan gates: consent (for a stranger's line), the plan's own call cap,
 *     the connotation pass, and an E.164 number — each refused when unmet;
 *   - the pre-flight assembles a plan and redacts the number, and places no call.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeCaps, RunBudget } from '../caps.ts';
import {
	preflight,
	type RunPlan,
	redactNumber,
	renderPreflight,
	validateRunPlan,
} from '../plan.ts';

describe('caps must be real bounds', () => {
	it('defaults concurrency to 1', () => {
		expect(normalizeCaps({ maxCalls: 3, maxWallClockMinutes: 10 }).maxConcurrency).toBe(1);
	});

	it.each([
		['Infinity calls', { maxCalls: Number.POSITIVE_INFINITY, maxWallClockMinutes: 10 }],
		['zero calls', { maxCalls: 0, maxWallClockMinutes: 10 }],
		['negative minutes', { maxCalls: 3, maxWallClockMinutes: -1 }],
		['NaN minutes', { maxCalls: 3, maxWallClockMinutes: Number.NaN }],
		['fractional calls', { maxCalls: 2.5, maxWallClockMinutes: 10 }],
	])('refuses %s', (_label, caps) => {
		expect(() =>
			normalizeCaps(caps as { maxCalls: number; maxWallClockMinutes: number }),
		).toThrow();
	});
});

describe('RunBudget enforces the caps at runtime', () => {
	it('refuses to start past the call cap — started() throws, not a soft no', () => {
		const t = 0;
		const budget = new RunBudget(normalizeCaps({ maxCalls: 2, maxWallClockMinutes: 60 }), () => t);
		budget.started();
		budget.ended();
		budget.started();
		budget.ended();
		expect(budget.callsStarted).toBe(2);
		expect(budget.canStart().ok).toBe(false);
		expect(() => budget.started()).toThrow(/call cap reached/);
	});

	it('refuses once the wall-clock cap elapses', () => {
		let t = 0;
		const budget = new RunBudget(normalizeCaps({ maxCalls: 100, maxWallClockMinutes: 5 }), () => t);
		budget.started();
		budget.ended();
		t = 5 * 60_000; // exactly at the cap
		expect(budget.canStart().ok).toBe(false);
		expect(() => budget.started()).toThrow(/wall-clock cap/);
	});

	it('refuses past the concurrency cap and frees a slot on ended()', () => {
		const budget = new RunBudget(
			normalizeCaps({ maxCalls: 10, maxWallClockMinutes: 60, maxConcurrency: 1 }),
			() => 0,
		);
		budget.started(); // one active
		expect(budget.canStart().ok).toBe(false);
		expect(() => budget.started()).toThrow(/concurrency cap/);
		budget.ended();
		expect(budget.canStart().ok).toBe(true);
	});
});

const GOOD_PLAN: RunPlan = {
	target: { kind: 'system-under-test', number: '+17205551234', label: 'Nexus auto glass' },
	scenarios: ['windshield-quote'],
	runsEach: 2,
	caps: { maxCalls: 3, maxWallClockMinutes: 15, maxConcurrency: 1 },
	consentSettled: true,
	connotationReviewed: ['windshield-quote'],
};

describe('the plan gates', () => {
	it('accepts a fully-cleared plan', () => {
		expect(() => validateRunPlan(GOOD_PLAN)).not.toThrow();
	});

	it('refuses a system-under-test run without consent settled', () => {
		expect(() => validateRunPlan({ ...GOOD_PLAN, consentSettled: false })).toThrow(/consent/);
	});

	it('refuses a plan that would exceed its own call cap', () => {
		// 1 scenario × 5 runs = 5 calls, cap 3.
		expect(() => validateRunPlan({ ...GOOD_PLAN, runsEach: 5 })).toThrow(/call cap/);
	});

	it('refuses a scenario whose outward text has not passed the connotation pass', () => {
		expect(() => validateRunPlan({ ...GOOD_PLAN, connotationReviewed: [] })).toThrow(
			/connotation pass/,
		);
	});

	it('refuses a non-E.164 target number', () => {
		expect(() =>
			validateRunPlan({ ...GOOD_PLAN, target: { ...GOOD_PLAN.target, number: '720-555-1234' } }),
		).toThrow(/E\.164/);
	});

	it('refuses an empty scenario list', () => {
		expect(() => validateRunPlan({ ...GOOD_PLAN, scenarios: [] })).toThrow(/no scenarios/);
	});
});

describe('the pre-flight prepares a run and places no call', () => {
	it('redacts the number and reports the planned calls against the cap', () => {
		const report = preflight(GOOD_PLAN);
		expect(report.ready).toBe(true);
		expect(report.plannedCalls).toBe(2);
		expect(report.target.numberRedacted).toBe('********1234');
		expect(report.target.numberRedacted).not.toContain('7205');
	});

	it('renders a report that ends by stating no call was placed', () => {
		const text = renderPreflight(preflight(GOOD_PLAN));
		expect(text).toMatch(/placed no call/);
		expect(text).toMatch(/A human dials/);
	});

	it('redactNumber keeps only the last four digits', () => {
		expect(redactNumber('+17205551234')).toBe('********1234');
	});
});

describe('STRUCTURAL: the pre-flight package builds no dial path', () => {
	// The pre-flight prepares a run and stops; it must contain no way to place a
	// call. This mirrors the app's dial-fence: a run planner that could itself
	// dial is exactly the thing the human-in-the-loop invariant forbids.
	const SRC = dirname(dirname(fileURLToPath(import.meta.url))); // packages/runplan/src
	const FORBIDDEN = [
		'twilio',
		'Calls.json',
		'@callbench/transport',
		'fetch(',
		'assertDialAllowed',
		'sendAudio',
		'Twiml',
	];
	it('no transport/network/dial primitive in any source file', () => {
		const offenders: string[] = [];
		const walk = (dir: string) => {
			for (const name of readdirSync(dir, { withFileTypes: true })) {
				if (name.name === '__tests__') continue;
				const p = join(dir, name.name);
				if (name.isDirectory()) walk(p);
				else if (/\.ts$/.test(name.name)) {
					const text = readFileSync(p, 'utf8');
					for (const token of FORBIDDEN) if (text.includes(token)) offenders.push(`${p}: ${token}`);
				}
			}
		};
		walk(SRC);
		expect(offenders).toEqual([]);
	});
});
