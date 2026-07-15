# Increment 7a — Live-run pre-flight (frozen)

What this increment froze. Everything a live run must clear BEFORE it starts,
enforced in code — and it stops short of the dial. See [../plan.md](../plan.md)
Increment 7 and the product invariant "a run is bounded before it starts."

## Caps and the runtime enforcer (`@callbench/runplan` `caps.ts`)

`RunCaps`: `maxCalls`, `maxWallClockMinutes`, `maxConcurrency`.
`normalizeCaps` REFUSES any cap that is not a positive finite number (Infinity,
NaN, 0, negative, fractional counts) and defaults `maxConcurrency` to 1.

`RunBudget` enforces all three at runtime: `started()` THROWS past a cap — a soft
"no" a caller could ignore is exactly the failure this avoids. The clock is
injected (the wall-clock cap is tested without real time). NOTE: no live runner
exists yet (the dialer is a later, maintainer-gated increment); when it lands it
MUST route every call start through `started()`. That wiring is the open seam.

## The run plan and its gates (`plan.ts`)

`RunPlan`: `target` (kind + E.164 number + label), `scenarios`, `runsEach`,
`caps`, `consentSettled`, `connotationReviewed`. `validateRunPlan` refuses unless:

- caps are real bounds (via `normalizeCaps`);
- `scenarios` is non-empty and `runsEach` is a positive integer;
- the number is E.164;
- for a `system-under-test` target, `consentSettled` is true (a stranger's line
  is never dialed without consent settled — a maintainer decision in the docs);
- the plan stays within its own call cap (`scenarios × runsEach ≤ maxCalls`);
- every scenario appears in `connotationReviewed` — the outward-text gate: a
  scenario's spoken lines must have passed the connotation pass
  ([../connotation/](../connotation/)) before they are said to a stranger.

`preflight(plan)` returns a report with the number REDACTED (last four digits);
its rendered form ends by stating no call was placed. `scripts/preflight.ts` is
the operator entry point — it reads the target and caps from env, prints the
plan, and STOPS. A structural test asserts the package imports no dial primitive.

Pinned: `packages/runplan/src/__tests__/runplan.test.ts` and the catalog's
Increment 7a entries (budget-stops-enforcing, caps-accept-unbounded,
connotation-gate-removed, consent-gate-removed, no-dial scan).
