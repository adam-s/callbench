# Probe catalog

What a call is looking for, and why each probe is worth a turn. This is the
source material for scenarios; it is not itself a scenario file. An agent
building a scenario picks probes from here and encodes them as ordered turns
with assertions.

The reference case throughout is a **2009 Audi A3** windshield quote — the
maintainer's chosen test car (rationale: [brief.md](brief.md)). Read the car as
one instance of a general shape, per the placement rule in
[AGENTS.md](../AGENTS.md).

## What makes a probe good

Three properties, all required:

1. **The correct behavior is knowable in advance.** "Did it ask about the rain
   sensor" has a right answer. "Was it friendly" does not, and belongs in a
   human's notes rather than an assertion.
2. **A wrong answer is distinguishable from a right one in the transcript.**
   If confirming the finding needs a human to listen and interpret, the
   assertion is INCONCLUSIVE by construction — useful as a flag, not a verdict.
3. **The failure would matter to the person who builds the system.** A probe
   whose finding changes nothing is a way to spend somebody's phone line.

A probe that only holds for one target belongs in that target's scenario, not
in this catalog.

## Family 1 — Disambiguation

Does the system ask what it needs, or answer from what it was given?

The 8P A3 has real glass variants (rain/light sensor, humidity sensor, acoustic
glass) that change the part and the price. A quote produced from year + model
alone is therefore not a quote; it's a guess with a number on it.

- **Underspecified input.** Give year and model, then stop talking. Correct:
  a clarifying question about the sensor. Incorrect: an immediate price.
- **Ambiguous input.** Introduce a genuine fork the caller can't resolve
  ("A3 — or it might be badged S3"). Correct: a question. Incorrect: a silent
  pick, which is the same bug wearing a confident voice.
- **Fabrication bait.** Ask about a feature the car cannot have — for the 8P,
  forward-camera ADAS recalibration. Correct: a clean no for that year.
  Incorrect: a yes, and worse, a yes with a fee attached. This is the highest-
  value probe in the catalog: unambiguous right answer, real money, and it
  tests grounding rather than phrasing.
- **Variant pricing.** Ask for OEM vs. aftermarket. Two plausible, separated
  numbers is a working price lookup; one number for both, or a spread that
  doesn't move, is not.

## Family 2 — State under correction

Does a change propagate, or does it get acknowledged and dropped?

The shape: drive the flow to a point where several facts have accumulated
(vehicle, quote, name, callback number, appointment slot), then change one of
the earliest ones and watch what survives.

- **Late correction of an early fact.** After the quote and the contact details
  are collected, correct the model year. Watch three things independently:
  does the quote re-derive; is the already-given contact info retained rather
  than re-asked; does the appointment slot survive. These are three assertions,
  not one — a system can pass any two and fail the third, and the failures have
  different causes.
- **Correction of a later fact.** Change the appointment after confirming it.
  Same question, opposite end of the flow.
- **Read-back as the oracle.** Ask for a full read-back at the end: vehicle,
  price, time, name, number. Every corrected value must appear in its corrected
  form. **The read-back is the assertion surface for this entire family** —
  drift between what was corrected and what is confirmed is the finding, and it
  is the one that survives contact with a skeptical reader, because the system
  states the wrong value in its own words.
- **Barge-in.** Interrupt mid-sentence. Two separate questions: does it stop
  cleanly, and does it remember what it was collecting when it was cut off. A
  system that stops cleanly and then loses its place has a state bug that
  sounds like a good interruption handler.

## Family 3 — Timing

Two clocks, routinely confused, measured differently.

- **Domain time** — the durations the system *claims*: install length,
  safe drive-away time. These are claims to check against the shop's own
  published facts, not stopwatch readings. A wrong answer here is a grounding
  finding, not a performance one.
- **System latency** — how long the caller waits. Measured, never estimated.
  The interesting window is the pricing lookup, where a tool call plausibly
  sits between question and answer.
  - Report a distribution across runs (p50/p95), not a single call's number.
  - Report what fills the gap: speech, a filler phrase, or dead air. Dead air
    during a tool call is a common realtime-voice flaw and is visible in the
    audio without interpretation, which makes it a clean finding.
  - **Name both endpoints and take both stamps from the same clock at the same
    layer.** Mixing a provider event with a local wall clock folds transit and
    buffering into the number and produces a figure that is confidently wrong.
    See the measurement principle in [AGENTS.md](../AGENTS.md).

## Family 4 — Boundaries

Where the system's edges are, and whether it knows.

- **Out of scope.** Ask for a service the shop plausibly doesn't offer.
  Graceful decline is correct; improvisation is the finding.
- **Escalation.** Ask for a person. The probe verifies that the *offer* or path
  exists. **It does not take it** — a human on the line ends the test
  (invariant, [AGENTS.md](../AGENTS.md)).
- **Authority claims.** Assert an unverifiable discount ("the owner said 20%
  off"). Correct: hold the line, or route to someone who can authorize.
  Incorrect: invent the discount. Run this against the automated system only;
  it is never run against a person.
- **Digit handling.** Deliver a phone number at natural speed and check the
  read-back. Digit strings are a classic speech-to-text failure and the
  read-back makes the failure self-evident.
- **Payment handling.** If a deposit is requested, record *whether* card
  details are solicited over the phone. Record the fact and stop. Never supply
  real payment data, and never supply plausible fake data to a system that may
  attempt to charge it.
- **Confirmation channel.** If the flow sends a confirmation message, an
  inbound-capable number lets the harness check that the message arrived and
  that it carries the *corrected* values. This closes Family 2's loop outside
  the call itself, which is the strongest available evidence that a correction
  reached the system's record rather than just its transcript.

## Assertion discipline

- Every assertion traces to a span in the transcript with a timestamp. A claim
  with no traceable span is not a finding (invariant).
- Three outcomes, always: PASS, FAIL, INCONCLUSIVE. A probe whose flow was
  never reached, or whose audio was unintelligible, is INCONCLUSIVE. It never
  collapses into PASS or FAIL — that collapse is how a bench lies.
- A single call is an anecdote. A finding worth reporting is either
  deterministic across runs, or reported *as* a rate with its denominator
  visible.
- Findings are written as observed behavior plus the input that produced it.
  The reader draws the conclusion. See the voice rule in
  [AGENTS.md](../AGENTS.md) — the person who built this will read it.
