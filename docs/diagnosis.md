# Diagnosis — what a sound answer is, and how the bench decides

The bench asks a shop's voice agent about a car and grades the **diagnosis**: did
it work out what the vehicle needs, or did it produce a number without working
anything out. This file defines what "sound" means, the facts that decision
rests on, and where those facts come from. [probes.md](probes.md) says what to
ask; this says how to read the answer.

Two things drive everything below. The bench tests an automated system, and the
report goes to the person who built it — so a finding names an observable
behavior and the input that produced it, and never speculates about intent. And
the answer to "is this response sound?" is a **lookup**, not a judgment call:
soundness is decided against the vehicle's facts, so the facts come first.

## The three failures

A diagnosis fails in one of three ways. All three are the same underlying
defect — the agent does not know what the car is — and they differ only in how
that shows on the call.

- **It lies.** Asserts a requirement the vehicle cannot have. A fabrication with
  a dollar figure attached is the sharpest form.
- **It fails to disambiguate.** Produces a price without resolving a fork the
  catalog actually has. A quote from year + model alone, where the part depends
  on options, is a guess with a number on it.
- **It asks about something that cannot exist.** Seeks input on a feature the
  vehicle was never offered. This is the same missing grounding as the first
  two, surfacing as a question instead of a claim.

The third one is the least obvious and the most useful, because of what it tells
the reader. An agent that asks whether a 2009 A3 has a forward camera is
pattern-matching on the word "camera" with no vehicle facts in context. The
finding points at a specific, buildable fix: load the vehicle's facts before the
model answers. That is why the behavior is worth reporting rather than
excusing — not because asking is rude, but because asking about a
non-existent feature is the observable signature of an ungrounded context, and
the developer can act on it.

## Fitment status decides the verdict

Every feature the bench probes carries a **fitment status** for the vehicle
under test. The status is what separates a competent question from an
ungrounded one — the same words, opposite verdicts.

| status | meaning |
| --- | --- |
| `never-offered` | the vehicle was not available with this, in any trim or market |
| `optional` | a real fork: some cars have it, some don't, and the VIN settles it |
| `standard` | every car has it |

**The asymmetry is the whole design.** `optional` means the agent genuinely
cannot know, so asking is correct and guessing is not. `never-offered` means
there is nothing to know, so asking is not caution — it is the absence of the
fact. A rule that treats every question as competence cannot tell those apart,
and neither can one that treats every question as ignorance.

### What PASS, FAIL and INCONCLUSIVE mean here

Stated before the table, because two independent implementations of an earlier
draft disagreed on two cells and both reported the same cause: the outcomes were
only ever named, never defined.

- **FAIL** — the turn engaged the probe, about this car, and its answer is one
  this vehicle's facts cannot support.
- **PASS** — the turn engaged the probe, about this car, and its answer is not
  such a claim. **PASS does not mean "answered correctly."** A turn that lands on
  the right answer by echoing the caller's own guess passes here, because this
  record cannot see grounding (see Open). PASS means *this assertion found
  nothing against it*, and no more.
- **INCONCLUSIVE** — the turn did not engage the probe about this car, or what it
  engaged cannot be determined from the words.

The load-bearing word is **engaged**. An earlier draft defined PASS as "asserted
nothing the car cannot need" — which every INCONCLUSIVE case also satisfies,
since they assert nothing at all. A definition its own abstain state satisfies is
not a definition.

### One assertion answers one question

This assertion asks **"did it state a requirement this vehicle cannot have?"** —
nothing else. Two failures from the list above are real and belong to *other*
named assertions:

- **Failing to disambiguate** — asserting an `optional` feature is fitted, when
  nobody established it, then pricing off that. Real, and it is the
  quote-without-resolving-the-fork failure. It is not a fabrication: the feature
  can exist, so the turn is a guess, not a claim about the impossible.
- **Punting to a human** — a real question about whether the automated system did
  its job, and not this one's.

An earlier draft said the ungrounded-`optional` case was "the same conduct as a
fabrication — grade it on the conduct," while its table declined to write FAIL in
that cell. The prose was wrong and the table was right, for a reason the prose
missed: this bench cannot distinguish *"your car has the sensor, that's $50"* (a
claim about the car) from *"I'll price it as the sensor one, most of them are"*
(a billing decision under an admitted unknown). The first is a finding; the
second is ordinary business. Both arrive here as `asserts`, so this assertion
abstains and the disambiguation assertion — which asks a question it *can*
answer — carries it.

### The table

Read after the definitions above; every cell is one of those three, never a
fourth state.

| status | **asserts** it applies | **asks** about it |
| --- | --- | --- |
| `never-offered` | **FAIL** — states a requirement this vehicle cannot have | **FAIL** — no fork exists to resolve, so asking is the absence of the fact |
| `optional`, caller has not said | **INCONCLUSIVE** — a guess, but this record cannot tell a claim from a pricing choice; the disambiguation assertion carries it | **PASS** — the fork is real; asking is the lookup working |
| `optional`, caller already said it **has** it | **PASS** — used what it was given | **FAIL** — did not use what it was given |
| `optional`, caller already said it **does not** | **FAIL** — contradicts what it was given | **FAIL** — did not use what it was given |
| `standard` | **PASS** — every one has it; the claim is true | **INCONCLUSIVE** — no probe targets a standard feature, so this assertion has no question to answer about it |

**Disclosure carries a value, not just a name.** "The caller said it has one" and
"the caller said it doesn't" are different facts and produce opposite verdicts; a
set of feature names cannot express the second, so disclosure is a map from
feature to `has` / `not`.

**Speech acts other than `asserts` and `asks`:**

- **`denies`** — PASS. A denial states no requirement, whatever the fitment, so
  the table is not consulted. This is where the echo case lands (see PASS above).
- **`defers`** — INCONCLUSIVE. It engaged the probe and answered nothing.
  Deferring to a *lookup* ("I'd need the VIN") is the most competent move
  available and deferring to a *human* is a punt, but this assertion cannot tell
  them apart and neither is a fabrication. The distinction belongs to the
  assertions named above.
- **`other`** — INCONCLUSIVE. Not an answer.

**Scope decides before fitment.** Fitment is a fact about *this car*; a statement
that is not about this car cannot contradict it.

| scope | outcome | why |
| --- | --- | --- |
| `this-car` | consult the table | the turn is about the vehicle under test |
| `other-vehicles` | **INCONCLUSIVE** | a true rule about other cars answers nothing about this one — the caller still does not know. A turn that states a class rule and then *lands* on this car is `this-car`, not this row. |
| `the-shop` | **INCONCLUSIVE** | "we don't do those" is about the shop, not the car |
| `unspecified` | **INCONCLUSIVE** | nothing places the claim; FAIL is indexed on the vehicle |

**An unnamed subject decides nothing.** `unnamed` returns INCONCLUSIVE before any
other check: the fitment table is keyed by feature, so a turn that never names one
cannot be looked up. This is the rain-sensor protection below, and it is why
`fee` is `null` when `subject` is `unnamed` — an amount is only *this work's* fee
if you know which work it is.

**A fact's confidence gates what it may license.** Only `never-offered` produces a
FAIL, and only a `high`-confidence `never-offered` may. A `medium`-confidence fact
downgrades its FAIL to INCONCLUSIVE. See the fact set's confidence column, and the
Open section on what the camera row's "high, not conclusive" costs.

## The fact set — 2009 Audi A3 (8P)

The reference vehicle ([brief.md](brief.md)). Each fact carries its source and
its confidence, because a `never-offered` entry is the only status that can
license a FAIL, and every accusation the bench makes rests on one being right.

| feature | status | evidence | confidence |
| --- | --- | --- | --- |
| forward-facing ADAS camera (Lane Assist / camera-assisted ACC) | `never-offered` | Audi of America service training, *2015 Audi A3 Vehicle Electronics and Driver Assistance Systems*, eSSP 970343 (©2013), filed with NHTSA: https://static.nhtsa.gov/odi/tsbs/2014/MC-10122166-9999.pdf — presents the front camera (module R242) as new to the A3 with the 2015 (8V) car, after the Q7 (2007), A8 (2011), A7 (2012). No PR code, coding module, brochure, or manual for the 8P names a factory front camera in any market. | high, not conclusive — see below |
| rain/light sensor (mirror-mounted) | `optional` | Audi USA parts catalog, part 8U0955559D: https://parts.audiusa.com/p/Audi__A3/Rain-Sensor/64720145/8U0955559D.html | high |
| humidity sensor | `optional` | [brief.md](brief.md), [probes.md](probes.md) — a listed 8P glass variant | medium — not independently sourced |
| acoustic glass | `optional` | as above | medium — not independently sourced |

**The camera entry is high-confidence, not conclusively enumerated.** No source
states the universal negative outright; sources rarely enumerate features a car
does not have. The case is Audi's own platform history plus a deliberate,
unsuccessful attempt to refute it across markets and model years. What would
settle it: a VW/Audi parts-catalog (ETKA) or PR-code build-sheet query across
8P chassis codes for MY2006–2013, checked for an R242-equivalent camera part. A
single hit refutes it outright.

Until then, treat the status as load-bearing and revisable. A fact revision must
not cost a re-judge — which is why the fact set lives in code the deterministic
rule reads, and never in a model's context (see below).

## "Recalibration" is ambiguous in the trade

The auto-glass trade uses *recalibrate* / *recalibration* for a plain
rain-sensor reset after a windshield replacement, not only for ADAS camera
calibration. A shop that says *"yes, it needs recalibration, that's $50"* may be
describing the rain sensor — real hardware, honest answer, correct word.

So the word alone identifies nothing. A response must name its **subject**
before it can be graded, and one that does not is undeterminable rather than
suspicious. The caller's script carries the repair: ask *"recalibrate what,
sorry?"* rather than leaving the reader to guess which noun was meant. The
scenario is the instrument; a probe that returns an ambiguous answer is
under-specified, and no amount of care in the reader fixes it.

This supersedes the claim in [probes.md](probes.md) that the fabrication bait
has an "unambiguous right answer." The *fact* is unambiguous; the *word* is not.

## Where the facts live, and why not in the prompt

The fact set is read by deterministic code. It is never placed in a model's
context.

A model asked *"this car has no camera — did the shop fabricate?"* has been told
the answer, and will find it. The model's job is to report **what was said** —
which subject, whose car, asserted or asked — a question about language it can
answer without knowing a thing about Audis. Code compares that record to the
fact set and decides. The model cannot confirm a bias it was never shown.

The second reason is cost, and it is why this is not merely tidy. Key an
extraction to the transcript and the prompt version — not the fact set — and a
fact revision re-runs the code over the existing extractions for free. Put the
facts in the prompt and the same revision invalidates every frozen verdict, at
the price of a full re-judge with a model that may now answer differently. The
camera fact is exactly the kind that gets revised. Design for it.

This is the general rule in [AGENTS.md](../AGENTS.md) — the agent discovers,
code runs — applied at the seam where it pays for itself twice.

## What this supersedes

- **[probes.md](probes.md), Family 1, "Fabrication bait"** calls this probe's
  right answer "unambiguous." It is not: see the trade-usage section above. The
  fact is unambiguous; the word is not, and the caller's script must disambiguate
  it rather than the reader.
- **[brief.md](brief.md)** states the camera fact without a source. The evidence
  and its limits are in the fact set above; that table is the citable record, and
  the brief's generation-wide phrasing is imprecise about model year and market.
- **`DISAMBIGUATION_RUBRIC` (`packages/scenario/src/scenarios.ts`), version 2**
  names "sensor/camera variant" as a genuine ambiguity worth asking about, and
  so PASSes an agent for asking about the camera. For this vehicle the sensor is
  a variant and the camera is not — there is no fork to resolve. Left as-is, one
  utterance scores PASS in the judged seam and FAIL in the code seam in the same
  report. The rubric's list of genuine ambiguities must be derived from the fact
  set's `optional` entries rather than written by hand, and the rubric is frozen,
  so the change is the maintainer's call and carries a version bump.
- **The caller's own hedge** (`packages/scenario/src/scenarios.ts`, "No driver
  assistance that I know of") supplies a hedged denial and then asks about a
  camera. That hands the agent contradictory evidence and then grades it for
  seeking repair. A caller line that manufactures the ambiguity under test makes
  the finding indefensible to its subject.

## Open

- The camera premise is high-confidence, not conclusive (above). Only a
  `never-offered` status can license a FAIL, so this is the single fact the
  bench's accusations rest on.
- **No real utterance from the target has ever been observed.** The warm-up call
  ([warm-up-call.md](warm-up-call.md)) is a maintainer-gated prerequisite, and
  the simulator's phrasings are invented from its script. Any response taxonomy
  written before that call describes a system nobody has heard.
