---
name: author-scenario
description: Set up a new test — pick a vehicle and a probe, build its fact set, write the caller script, wire the assertions, and clear the gates, in the order that stops you building on sand. Use when the user says "add a scenario", "test another car", "make it work on a Ford truck", "set up a new test", or names a vehicle the bench has never called about. Places no call and researches no fact by itself.
---

# Author a scenario

Everything needed to point the bench at a vehicle it has never called about.
This existed only as scattered knowledge until someone asked "what does it take
to test a Ford truck?" and the answer turned out to be seven files across four
packages, written down nowhere.

**Read [docs/diagnosis.md](../../../docs/diagnosis.md) first.** It defines what
the bench grades and why the facts stay out of the model's context. This skill is
the procedure; that file is the reasoning, and the procedure will look arbitrary
without it.

**This skill places no call.** It prepares a scenario. Dialing is
[live-call](../live-call/SKILL.md), and it is the maintainer's.

## What you are building, and in what order

The order is the point. Each step is cheap to do and expensive to redo once
something is built on it.

```
1. the probe      what question, and why it has an answer      probes.md
2. the fact set   what the words mean; what the car has        factset-<vehicle>.json
3. the caller     what gets said, in order                     scenarios.ts
4. the assertions what gets graded                             assert / judge
5. the gates      connotation, consent, caps                   AGENTS.md / runplan
```

## 1. The probe — and the question that kills bad ones

Pick from a family in [docs/probes.md](../../../docs/probes.md). Then ask the
question that decides whether the probe is worth building:

> **Is there a fact of the matter, and can we get it?**

- **"Did it ask before quoting?"** — no fact needed. The transcript answers it.
  Build it for any vehicle, today.
- **"Did it invent work this truck cannot need?"** — needs a `never-offered`
  fact, verified. Most vehicles do not have one and cannot cheaply get one.
- **"Why is it making that noise?"** — **no fact exists.** The shop is guessing
  too. Not gradeable. Do not build it.

Most probes need no facts at all. Reach for the fitment-dependent one only when
the fact is already in hand, and read step 2's ceiling before assuming it will
be.

## 2. The fact set

One JSON file per vehicle (`scripts/probes/fixtures/factset-<vehicle>.json`).
Two halves that behave completely differently:

- **The catalog** (`label`, `catalog`, `namedBy`) — what the trade's words can
  refer to. **This is domain knowledge, not vehicle knowledge.** "Recalibration"
  covers a camera or a rain sensor on any car ever built. Copy it from a sibling
  fact set; do not re-derive it per vehicle.
- **The fitment** (`fitment`, `confidence`, `provenance`, `source`) — what *this*
  vehicle has. This is the part that costs.

**The model sees the catalog and never the fitment.** `promptValues()` in
`scripts/probes/factset.ts` is where that is enforced, mechanically rather than
by discipline.

### Getting the fitment

Run `node scripts/find-fact.ts --vehicle "<year make model>" --feature "<feature>"`.
It searches, returns a structured candidate with sources, records what it
searched to disprove itself, and flags whether its case rests on silence. It caps
at `medium` — by construction, in code, not by asking a model nicely.

**To reach `verified`, a human reads it.** That is the whole rule: *do not accuse
a business on a fact no person ever looked at.* It is a five-minute glance at the
candidate's sources, not a research project.

### The ceiling, so you do not go looking for a door that is not there

`never-offered` is a **universal negative** — no trim, no market, no model year.
Catalogs record presence; **nothing records absence**. Verified this repeatedly
(see the "Vehicle fitment data" section of
[docs/references.md](../../../docs/references.md)): NHTSA vPIC returns blank ADAS
for most makes and says outright that a blank means nothing; NAGS is paywalled;
OEM catalogs are behind WAFs. One method worked — an OEM whose glass part numbers
split on the camera bracket — and it is **manufacturer-specific**: Audi's catalog
marks it, Honda's does not, because Honda bolts the camera to a universal
bracket. A method with no positive control for that make proves nothing.

**Expect not to get it.** That is not a failure — it is why `provenance` exists.

### Shipping without the fitment

**A fact set with no fitment row still works.** The fabrication probe returns
INCONCLUSIVE — *we could not evaluate this* — which is exactly true, and every
other probe runs. That is the honest way to test a vehicle nobody has
researched, and it is better than a guessed row, which is how the bench would
come to accuse someone on nothing.

## 3. The caller script

Ordered turns in `packages/scenario/src/scenarios.ts`; mark probe injections so
the harness enforces them rather than trusting a persona to remember.

**The scenario is the instrument.** Three rounds of classifier work went into the
*reader* on this project when the *instrument* was under-specified — the probe
returned an answer nobody could grade and the fix was one caller turn. Before
writing a cleverer assertion, ask whether a better question would make the answer
classify itself.

Three failures to design out:

- **Do not manufacture the ambiguity you then grade.** A caller line that hedges
  ("no driver assistance *that I know of*") and then asks about that feature
  hands the agent contradictory evidence and fails it for seeking repair. A
  finding built on a caller's own contradiction is indefensible to its subject.
- **Ask the disambiguating turn.** If a trade word covers two parts, make the
  caller ask which: *"recalibrate what, sorry?"* One turn collapses a whole class
  of ungradeable answers.
- **One persona per call.** A caller fluent enough to say "camera recalibration"
  is not a caller who does not know what a rain sensor is, and an agent pitches
  its register to the caller it hears. Mixing them weakens both probes. Two
  calls.

## 4. The assertions

Code where the question can be expressed in code; the judge where it cannot.
Prefer code every time it suffices.

- **One assertion answers one question.** If yours needs a fourth state, it is
  two assertions. The three-state contract is frozen and a fourth state either
  breaks it or gets flattened at the boundary, which is the collapse the
  invariant exists to prevent.
- **PASS does not mean "answered correctly."** It means *this assertion found
  nothing against it*. An agent that lands the right answer by echoing the
  caller's guess passes; the record cannot see grounding.
- **Abstain over accuse, always.** Abstaining costs a finding the judged seam
  still sees. Guessing prints an accusation at a real business.

## 5. The gates

- **Connotation pass** — every outward line (what the caller SAYS, and every
  finding string) gets the phrase→readings pass in
  [AGENTS.md](../../../AGENTS.md), producing a committed artifact under
  `docs/connotation/`. Not optional and not a formality: it is a GATE with a
  visible artifact, and it is the one that gets skipped under task pressure.
- **Consent** — settled by the maintainer, recorded in the docs, and **re-settled
  when the target changes**. A new vehicle at the same shop is the same target; a
  new shop is not.
- **Caps** — `runplan` enforces call count, wall-clock, and concurrency.
- **The static gate** — `pnpm typecheck && pnpm lint && pnpm vitest run`.

## Done when

- The probe has a fact of the matter, or does not need one.
- The fact set exists; every `never-offered` row that can FAIL is `verified` by a
  human, and every row that is not says so.
- The caller script does not manufacture what it grades.
- Assertions abstain where the record cannot decide.
- The connotation artifact is committed; consent is settled; caps are declared.
- The gate is green.

Then hand the dial to the maintainer. It was never yours.
