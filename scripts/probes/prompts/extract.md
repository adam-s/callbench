# Extraction prompt v1 — one target turn to a typed record

<!--
VERSIONING: bump the version in the header line below on ANY edit to the text
the model sees. The version is part of the extraction cache key, exactly as
Rubric.version is part of the judge's (packages/judge/src/judge.ts). An edit
without a bump replays stale extractions against new wording, silently.

FACT-BLIND BY CONSTRUCTION. This prompt must never state which features the
vehicle has. Reference-answer anchoring is measured, not folklore: a reference
shifts a judge's scores toward itself (arXiv 2506.22316), and framing a review
with a prior moved detection 16-93pp in the nearest analogue (arXiv 2603.18740).
The model is asked what the speaker SAID. Deterministic code decides whether it
was true. See docs/diagnosis.md.

The vehicle IS named below, because "yours" and "the 2010s and up" cannot be
resolved without it. KNOWN RESIDUAL LEAK: a model may carry its own beliefs
about a 2009 A3's equipment. That is not removable while coreference needs the
referent, and it is mitigated only by the task being descriptive — the model is
never asked whether a claim is true. Probe for it; do not assume it is absent.

EVERY FACT THE MODEL NEEDS IS IN THIS TEXT, not implied by a field name. The
"structured output degrades reasoning" finding was confounded by mismatched
prompts; with matched prompts, structured generation matches or beats free-form
(arXiv 2408.02442 and dottxt's rebuttal). The condition is that the prose
carries the definitions. A field named `subject: camera | rain-sensor` teaches
nothing on its own.
-->

**version: 3**

<!--
v2 → v3: TEMPLATED. The prompt no longer names a vehicle, a service, or a fixed
subject list — those arrive as <<PLACEHOLDERS>> filled per conversation from a
fact set. What made this necessary: v2 hardcoded "2009 Audi A3" and a
camera|rain-sensor enum, so it could not be run against any other vehicle, and
"does this generalize" was unanswerable rather than merely unanswered.

The subject catalog lists what the trade words CAN refer to on a vehicle of this
kind. It never says what THIS vehicle has — fitment stays in code. Listing a
feature is not disclosing that it is fitted, which is what makes the catalog safe
to show and the fitment table not.

Worked examples were genericised off the camera/glass domain. An example whose
conclusion is the answer to the class of turn under test is a leak (see the
review's finding on v1's scope example).

TWO SPEC DECISIONS MADE HERE, both flagged for the maintainer rather than
silently taken:
  - `fee` when `subject` is `unnamed` → `null`. Both held-out generators hit this
    hole independently; one recorded the amount anyway, arguing "a fee exists,
    its subject doesn't" is more informative. Both readings are defensible. This
    prompt takes `null` because the field is DEFINED as the fee for the named
    subject, and if nothing is named there is no such fee. Any held-out row
    following the other convention is a spec disagreement, not a model failure.
  - Counterfactual, third-party, and bundled fees → `null`. v2 said none of this;
    the generators found all three.

The version label is now for humans only: the cache key hashes the prompt TEXT,
so an unbumped edit can no longer replay stale records. Bumping is bookkeeping,
not a correctness mechanism.
-->


<!--
v1 → v2, from the v1 run (29/37 verdicts, 5 false accusations). Every change
below names a CLASS of error, never a case. "Handle the word 'without'" would
be round four of the keyword mistake wearing a prompt; the fixes are:

  1. SUBJECT WAS INFERRED, NOT REPORTED. 5 of 7 misses were the model resolving
     an unnamed recalibration to `camera` — the caller's topic — by anaphora.
     It never once said `unnamed`. Twice this accused a shop whose $80 and $250
     could honestly have been the rain sensor. The escape hatch was listed but
     not instructed, and the literature predicted exactly this: a "none of the
     above" class gets absorbed into the nearest label (references.md, closed-set
     section). So `unnamed` is now the stated default and leads the list.
  2. SCOPE WAS DEFINED ONLY FOR STATEMENTS. v1 said "whose car the turn's
     STATEMENT is about", then asked for it on questions — so "Does YOUR car
     have the camera?" scored `unspecified` and the whole asking-is-ungrounded
     rule became unreachable. Same act scored differently across two cases,
     which is the tell that a definition is not load-bearing.
  3. A REASON READ AS A CONDITION. "Without a forward camera there's nothing to
     recalibrate" was read as an open hypothetical and FAILed a correct answer.
     v1 taught open-vs-closed conditionals and never taught reason-vs-hypothesis.
  4. PRICE CUES REMOVED. v1's background said camera calibration is "often
     several hundred dollars" and the rain sensor "cheaper" — a discriminator
     the model was told not to guess from, handed to it anyway. Not needed for
     the task. (The v1 run shows it used anaphora, not price — but leaving a
     shortcut in place because it went unused this time is not a reason.)
  5. ENUM ORDER. `camera` no longer leads the subject list; the model's job is
     to report, and a first-listed option is a thumb on the scale.
-->


You are reading one turn from a recorded phone call and reporting what the
speaker said. You are not deciding whether it was true, helpful, or correct.
Report the language; something else checks the facts.

## The call

A caller phoned a shop for <<SERVICE>>. The caller has said their vehicle is a
**<<VEHICLE>>** and has given no other detail about it — no VIN, no trim, no
options, nothing about what equipment it has.

The caller then asked: **"<<CALLER_QUESTION>>"**

Below is the shop's reply. Report what it said about that question.

## Background you need to read it

In this trade, the words <<OVERLOADED_TERMS>> are used for more than one thing.
These are the pieces of hardware they can refer to on a vehicle like this one:

<<SUBJECT_CATALOG>>

**These are different pieces of hardware, and the same words cover all of them.**
A shop may mean any of them, and often will not say which. **The price is not a
clue — do not infer the hardware from the amount.**

**This list says what these words CAN refer to. It does not say what this vehicle
has.** Some of these may not exist on this car at all; others may be optional and
fitted or not. You are not being told, and you do not need to know — your job is
to report which one the speaker named, not which one the car has.

## What to report

Return **only** a JSON object, no prose around it, with exactly these fields:

### `subject`
Which hardware **the turn itself names**.

**Report what the speaker said. Do not work out what they probably meant.** This
is the field most likely to be gotten wrong, and it is wrong in one specific
direction: filling it in from context rather than from the words.

- `"unnamed"` — **the default.** The work is discussed, but this turn does not
  say which hardware. Use it whenever you would have to reason to decide.
<<SUBJECT_ENUM>>
- `"other-service"` — the turn is about a different service entirely (it
  misheard, or answered about something unrelated). Use this rather than forcing
  the turn into one of the named subjects above.
- `"none"` — the turn does not engage the topic at all.

**The caller asked about one specific piece of hardware. That does not make every
later mention of the work a reference to it.** A shop answering may be talking
about a different part, about its own policy, or about something you have no way
to identify. A sentence like "you'll need it done, that's $220" names no
hardware — it is `unnamed`, however obvious the answer feels from what was asked.
Resolving it would be a guess dressed as a reading.

An answer of `unnamed` costs almost nothing: something downstream handles it. A
wrong named subject becomes a written accusation against a real business. **When
the words do not settle it, `unnamed` is the correct answer, not a failure to
decide.**

### `speechAct`
What the speaker **did** — about the caller's car, which is what was asked.
- `"asserts"` — stated the work applies to the caller's car.
- `"denies"` — stated it does not. A hedged denial ("I don't think so") is still
  `denies`.
- `"asks"` — asked the caller a question (typically whether the car has some
  piece of equipment).
- `"defers"` — said they do not know yet and named what would settle it (check a
  tech, run the VIN, look it up). Deferring is not denying and not asserting.
- `"other"` — none of these. An acknowledgment that answers nothing ("let me
  check on that for you") is `other`, not `defers`: it names no way to settle it.

**A turn can state a rule and still be a denial.** When the speaker names a class
that needs the work, then places the caller's car OUTSIDE that class — by pricing
it without the work, by naming it as an exception, by contrasting it with the
class — they have **denied** it for this car. There is no "no" in the sentence
and it does not need one:

> "Only the ones with the bracket need it done. Yours is $265."

The class rule is scenery. The answer is *your car doesn't need it, here's your
price* — `denies`, `not-required`. Reading that as `asserts` because the sentence
contains "need" reports a shop as claiming the very thing it ruled out.

**Ask what the caller now believes about their own car.** If they would hang up
thinking *"I need it"* → `asserts`. Thinking *"I don't"* → `denies`. Still not
knowing → `asks`, `defers`, or a `conditional` polarity. Grammar is not the test;
what the turn leaves the caller believing is.

### `scope`
**Whose car the turn is about.** This applies to every speech act, not only
statements: a question has a scope exactly as a statement does. "Does **your
car** have the camera?" is about this car.

- `"this-car"` — the caller's <<VEHICLE_SHORT>>. Includes "yours", "your car",
  "that one", "that model year", and any question asked about it.
- `"other-vehicles"` — cars other than the caller's, **where the turn never
  settles the caller's car either way**.
- `"the-shop"` — the shop's own practice or capability, not any car. "We don't do
  calibrations here."
- `"unspecified"` — the turn gives you nothing to place it. Use this when a turn
  engages the topic without referring to any car — not as a shrug when the
  reference is merely indirect.

**This is the field most often gotten wrong, and here is the test.** Many turns
mention other cars *on the way to* answering about this one:

> "Only the ones with the bracket need it done. Yours is $265."

That mentions a class, but it **lands** on the caller's car — it prices it,
outside that class. So it is `scope: "this-car"`, and its answer is `denies`.

**Ask: does the turn end up telling the caller something about their own car?**

- **Yes** → `"this-car"`, however much of the turn was about other cars.
- **No — it talks about other cars and stops** → `"other-vehicles"`.

A class rule is not the answer. What the turn does with the caller's car is.

### `polarity`
- `"required"` — the recalibration applies / is needed.
- `"not-required"` — it does not.
- `"conditional"` — stated **under a condition the turn leaves open**. "If it has
  the camera, that's another $220" — the speaker does not say whether it does.
- `"unstated"` — no position taken (asks, defers, or off-topic).

**`conditional` means the turn leaves the caller not knowing.** Two things look
conditional and are not:

**A condition the turn closes.** "If yours had the camera you'd add $220. **It
doesn't.**" raises a hypothetical and settles it. The caller knows the answer:
`not-required`. The closing clause is often short, comes last, and refers back
with a pronoun — read to the end of the turn before deciding.

**A reason given for an answer.** "Without the bracket there's nothing to set;
it's $265 for the part." has no hypothetical in it. The speaker is saying *why*:
this car has no bracket, so nothing needs doing. That is `not-required`, not
`conditional` — a clause explaining an answer is not a condition on it.

**The test: after this turn, does the caller know whether they owe the money?**
If yes, the polarity is `required` or `not-required` — whatever they know. If the
turn genuinely leaves it hanging on something unresolved, `conditional`.

### `fee`
The amount the shop would charge **this caller**, **on top of the job they phoned
about**, for work on the hardware named in `subject`. A number, or `null`.

**Understand the relationship, and most of these decide themselves.** The caller
rang about a main job and has been quoted for it. They then asked whether
something EXTRA is needed. `fee` is the size of that extra — never the main job.

So when a turn quotes one number and that number is what the caller came for,
`fee` is `null`, no matter how the sentence is arranged:

> "Only the ones with the bracket need it done. **Yours is $265.**"

$265 is the price of the job they rang about. It is not a fee for the extra work —
it is what they pay *because there is no extra work*. Recording it as the fee
reports the shop as charging for the thing it just ruled out.

**Ask: is this number ON TOP of what they were already paying?** If no, `null`.

That question also answers the rest, which are the same test in other clothes:

- a price for **other cars** — not this caller's, `null`
- a price a **third party** would charge — not the shop's fee, `null`
- a **bundled** "everything in" total — names no separate extra, `null`
- a **counterfactual** ("you'd have paid $220, but you don't") — never applies,
  `null`
- **"no extra cost" / "free of charge"** — the absence of a fee, `null`
- `subject` is **`unnamed`** — an amount is only *this work's* fee if you know
  which work it is, and you do not, `null`

`fee` is for the case where the shop says the caller owes something more than the
quote, for the named hardware, on this car. If in doubt, `null`.

## Rules

- **Report the turn in front of you.** Do not infer what the shop probably meant,
  what a good shop would say, or what is likely true of the car.
- **When a field is genuinely undetermined, say so** (`unnamed`, `unspecified`,
  `unstated`). Guessing is worse than abstaining here: a wrong guess becomes a
  written accusation against a real business, and abstaining only costs a
  finding.
- Return the JSON object and nothing else.

## The turn

<<TURN>>
