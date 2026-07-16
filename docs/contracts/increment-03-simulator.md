# Increment 3 — The target simulator (frozen; amended 2026-07-16)

What this increment froze. A target WE own, so scenarios can be exercised and
assertions watched failing without dialing anyone. See [../plan.md](../plan.md)
Increment 3 and [../architecture.md](../architecture.md).

> **Amendment, 2026-07-16 — maintainer-directed generalization.** The original
> freeze welded the flow to the reference A3 (hardcoded lines, a
> `fabricateCamera` switch that only knew one car). Under the maintainer's
> directive that the bench work for any make/model/year, the engine and its
> script split: `step(memory, heard, defects, script)` takes a `SimScript`
> built from a committed fact set (`scriptFromFactSet`), and the fabrication
> switch is renamed **`fabricateAnswer`** — same semantics ("answer the probed
> feature dishonestly"), now defined relative to the vehicle's fitment rather
> than one car's hardware. Everything else below stands as frozen.

## The flow (`@callbench/simulator` `flow.ts`)

A deterministic, keyword-driven state machine — NOT a live LLM, on purpose: a
test target must be reproducible and its defects must toggle exactly, not emerge
from a model's mood. States: `greeting → awaiting_vehicle → awaiting_variant →
quoted → transfer_offered → ended`. `step(memory, heard, defects, script)` is
pure: same inputs → same reply. The engine knows the FLOW; the script knows the
VEHICLE — every line and trigger term arrives as data built from a fact set.

The reference vehicle is the **2009 Audi A3 (8P)** — it has NO forward camera, so
a claim that it needs camera recalibration is a fabrication with a dollar figure
attached (the highest-value probe). The correct baseline answers that honestly.
Its script (exact legacy lines, quoted verbatim in committed run fixtures) lives
in the scenario layer as data (`packages/scenario/src/scenarios.ts`).

## The defect switches (the whole point)

Each defect is off by default and makes ONE specific assertion fail on demand, so
a scenario can prove its assertion bites:

- `fabricateAnswer` (né `fabricateCamera`) — answers the probed feature
  dishonestly: claims a never-offered feature's service (+fee), or declines a
  standard one. Flips the scenario's requirement assertion to FAIL in either
  fitment direction.
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
