# Increment 3 — The target simulator (frozen)

What this increment froze. A target WE own, so scenarios can be exercised and
assertions watched failing without dialing anyone. See [../plan.md](../plan.md)
Increment 3 and [../architecture.md](../architecture.md).

## The flow (`@callbench/simulator` `flow.ts`)

A deterministic, keyword-driven state machine — NOT a live LLM, on purpose: a
test target must be reproducible and its defects must toggle exactly, not emerge
from a model's mood. States: `greeting → awaiting_vehicle → awaiting_adas →
quoted → transfer_offered → ended`. `step(memory, heard, defects)` is pure:
same inputs → same reply.

The reference vehicle is the **2009 Audi A3 (8P)** — it has NO forward camera, so
a claim that it needs camera recalibration is a fabrication with a dollar figure
attached (the highest-value probe). The correct baseline answers that honestly.

## The defect switches (the whole point)

Each defect is off by default and makes ONE specific assertion fail on demand, so
a scenario can prove its assertion bites:

- `fabricateCamera` — claims the A3 needs a recalibration (+fee). Flips
  `no-fabricated-recalibration` to FAIL.
- `dropCorrection` — acknowledges a late year correction but neither updates nor
  re-quotes. The Family-2 "acknowledged and dropped" bug.
- `goSilentAtQuote` — reaches the quote step and says nothing (a null reply):
  real dead air at the probe point, which drives the INCONCLUSIVE path.

A `null` reply is deliberate silence, recorded as the ABSENCE of a target turn,
never a fabricated one.

Pinned: `packages/simulator/src/__tests__/flow.test.ts`, and — the real proof —
the assertion tests that toggle each defect and watch the matching assertion flip
(`packages/assert/.../assertions.test.ts`). The catalog's Increment 3 entry
mutates a defect switch off and requires the dependent assertions to fail.
