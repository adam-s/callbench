---
name: bench-author-scenario
description: Build a new bench scenario end to end — research a fact set, derive the assertions, script the scenario as pure data, clear the connotation gate, and rehearse it against the simulator until every assertion has been watched failing. Use when the user says "add a scenario", "test another car", "new vehicle", "new probe", or names a vehicle or service the bench has never called about. Places no call; dialing is bench-live-call (real target) or bench-live-campaign (owned loop).
---

# Author a scenario

Everything needed to point the bench at a vehicle or service it has never
called about. Read [docs/diagnosis.md](../../../docs/diagnosis.md) and
[docs/probes.md](../../../docs/probes.md) first — this skill is the procedure;
those are the reasoning.

A scenario is DATA all the way down: a fact set (JSON), a derived assertion
spec, a generated simulator script, optional persona and turn config, one
registry append. If a step wants engine code, the step is wrong. The
maintainer's fact-verification gate sits INSIDE this pipeline and is never
absorbed by it: research proceeds, authoring proceeds, accusation waits.

## 1. The fact set — researched, capped, refutable

One JSON per vehicle at `factsets/<year-make-model>.json`; schema and loader in
`packages/factset/src/factset.ts`. Two halves with opposite exposure:

- `catalog` / `namedBy` — what the trade's WORDS can mean. Shown to the model.
  Domain knowledge; copy from a sibling fact set.
- `fitment` / `confidence` / `provenance` / `source` / `limits` — what the CAR
  has. Never shown; read only by the verdict rule.

Research agents (or `scripts/find-fact.ts`) draft rows as
`researched`/`medium` — the cap is code: `loadFactSet` refuses
`researched`+`high` outright. Every row's `limits` names the primary source it
rests on AND what would refute it (see `factsets/2022-toyota-camry.json` for
the pattern). A row that cannot say how it would be disproven is not research;
it is an opinion with a URL.

A fact set with weak rows still ships: assertions abstain instead of accusing,
and INCONCLUSIVE is a true answer.

**GATE — the maintainer verifies facts before any row may accuse.** `mayAccuse`
(`packages/factset/src/factset.ts`) licenses a FAIL only for `never-offered`
at `verified`+`high` — a human read the primary sources and failed to refute
them — or for `declared` rows, which describe invented vehicles with no shop
to accuse. The 2026-07-16 takes proved the gate live in BOTH polarities: on
researched facts, the fabricated "yes" and the false decline both abstained.
Never promote a row yourself; hand the candidate and its sources to the
maintainer and keep building below the gate.

## 2. The scenario — pure data in the registry

`packages/scenario/src/scenarios.ts`, appended to `allScenarios`:

- **assertions** — derive with `requirementSpecFor(factSet, featureId,
  extraTerms)` (`packages/factset/src/spec.ts`) feeding `requirementAnswer`
  (`packages/assert/src/assertions.ts`); add order checks
  (`askedBeforeQuoting`, `correctionPropagated`). Prefer code; a judged rubric
  (`disambiguationRubricFor`, `packages/scenario/src/scenarios.ts`) owes its
  own calibration run before its verdicts count.
- **simScript** — `scriptFromFactSet(factSet, opts)`
  (`packages/simulator/src/flow.ts`): honest answers derive from fitment, the
  `fabricateAnswer` defect speaks the exact opposite — both polarities from one
  builder. Line overrides exist for frozen history; a new vehicle takes the
  templates.
- **persona** (optional) — goal, background facts, `maxFreeTurns`
  (`packages/scenario/src/persona.ts`). The model carries the conversation;
  the harness owns the probes and speaks them verbatim at their milestone.
- **turnConfig** (optional) — e.g. `confirmSilenceMs` when a line pauses
  mid-utterance (see `stt-year-teens`).

Caller-script design rules, learned the expensive way:

- Do not manufacture the ambiguity you then grade — a caller who hedges and
  then probes the hedge hands the agent contradictory evidence.
- Ask the disambiguating turn; one question collapses a class of ungradeable
  answers.
- One persona per call. A caller fluent in "camera recalibration" is not a
  caller who has never heard of a rain sensor. Two calls.

## 3. The connotation artifact — or a deliberate withholding

Every line the scenario would SAY on a live call gets the phrase→readings pass
([AGENTS.md](../../../AGENTS.md)) as a committed artifact at
`docs/connotation/<scenario-name>.md` — named exactly as the scenario, because
`scripts/preflight.ts` plans the reviewed INTERSECTION by filename and says
aloud what it excluded. Withholding the artifact is itself a decision: the
scenario is then simulator-only by construction (the adversarial variants ship
exactly this way, ungated on purpose until the maintainer reviews their
outward text). What is never valid is a live-facing scenario with a skipped
pass.

## 4. Rehearsal — watch every assertion fail

An assertion never observed failing is an assertion never observed. Before the
scenario is done, run it against the simulator with each relevant defect
switch (`Defects` in `packages/simulator/src/flow.ts`) and confirm the RIGHT
assertion fails or abstains:

- `fabricateAnswer` — the requirement assertion, in whichever polarity the
  fitment sets up;
- `dropCorrection` — `correctionPropagated`;
- `goSilentAtQuote` — the INCONCLUSIVE path.

Offline first (the unit suite drives `step` directly), then as live
owned-to-owned takes via `scripts/live-scenario.ts --defect …` — see
[bench-live-campaign](../bench-live-campaign/SKILL.md). If the scenario
carries a persona, rehearse `--persona` and check the probe fired at its
milestone, not into the goodbye (take baa62100 played the probe into dead
air; take 6df9b35a, probe anchored to the quote, landed it — milestones, not
conversation end).

## Done when

- Fact set committed; every row capped honestly; `limits` names source and
  refutation. No row accuses without the maintainer's verification.
- Scenario in the registry as data; zero engine edits.
- Connotation artifact committed, or its absence recorded as simulator-only.
- Every assertion watched failing under its defect switch.
- `pnpm typecheck && pnpm lint && pnpm vitest run` green.

Then the scenario may be dialed — by the maintainer's procedures in
[bench-live-call](../bench-live-call/SKILL.md) and
[bench-live-campaign](../bench-live-campaign/SKILL.md).
