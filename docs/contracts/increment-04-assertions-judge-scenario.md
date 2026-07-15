# Increment 4 — Assertions, the judge, and the scenario runner (frozen)

What this increment froze, and where each is pinned by a contract/regression
test. Built against the simulator; no live dial. See
[../plan.md](../plan.md) Increment 4 and [../architecture.md](../architecture.md).

## The three-state outcome (`@callbench/assert`)

`Outcome = 'PASS' | 'FAIL' | 'INCONCLUSIVE'`. A `Result` is built ONLY through
`pass()` / `fail()` / `inconclusive()` — the single construction site that makes
collapsing the third state impossible by accident. INCONCLUSIVE carries a null
span (the point it would cite was never reached); PASS/FAIL carry a span.
Pinned: `packages/assert/src/__tests__/assertions.test.ts`, and the mutation
catalog's "three-state collapse" entry (both `inconclusive → PASS` and `→ FAIL`
must fail the suite).

## The assertion contract (`@callbench/assert`)

An `Assertion` is `(FrozenTranscript) => Result` — it reads the frozen artifact
and nothing else, never a live call. `CLARITY_FLOOR = 0.4`: an assertion whose
target turn was heard below it abstains (INCONCLUSIVE) rather than trust the
transcription. Each concrete assertion is watched failing on the matching
simulator defect (that is the whole reason the simulator exists).

## The judge (`@callbench/judge`)

- **Runner seam.** `provider:model` selector; `claude:<model>` → `claude -p`
  (`{result, is_error}` wrapper). `resolveRunner` throws on an unknown provider.
- **Determinism by freezing, not sampling.** The verdict is computed once and
  keyed by `cacheKey(rubric, input, runnerId)` — a sha256 over the rubric's
  criterion + name + **version**, the judged text, and the runner id. Drop any
  component and a stale verdict replays for changed input; pinned by the
  cache-key tests and the catalog's "cache key drops a component" mutation.
- **Recorded as judgment, not fact.** A `Verdict` carries `outcome`, `reasoning`,
  `span`, `judgedBy`, `rubricVersion`, `cached`. INCONCLUSIVE gets a null span.
- **A cache miss under test is the finding**, never a fallback — the suite seeds
  the cache from a committed calibration set (frozen from one real `claude -p`
  run) and a forbidden runner throws if reached.
- **Calibration** proves the judge discriminates all three states; regenerated
  by hand (`generate-calibration.mjs`), not in the suite.

## The scenario runner (`@callbench/scenario`)

- **Record.** `driveSimulator(scenario, defects?)` plays a scenario's caller
  turns into the simulator and freezes a transcript — the offline stand-in for a
  live call, producing the same `FrozenTranscript` a live driver will.
- **Assert.** `assess(scenario, transcript, judgeCtx?)` runs code assertions AND
  judged assertions into one `ScenarioReport`. Refuses on a hash mismatch. Code
  `Result`s and judge `Verdict`s stay in SEPARATE arrays — a verdict's provenance
  (judgedBy/rubricVersion/cached) must not be flattened into a Result.
- **Structural abstention.** A judged assertion whose excerpt is absent, or heard
  below the clarity floor, abstains to INCONCLUSIVE tagged `judgedBy: harness`,
  never consulting the model.
- **Rubric pinning.** The scenario's `DISAMBIGUATION_RUBRIC` deep-equals the
  judge's calibrated rubric (a test), so a drift can't silently miss the cache
  and reach the network.

Pinned: `packages/scenario/src/__tests__/scenario.test.ts`,
`packages/judge/src/__tests__/judge.test.ts`, and the catalog's Increment 4 /
judge / scenario-runner entries.
