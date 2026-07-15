---
name: live-call
description: Run a bounded set of live calls against a real voice agent — walk the pre-flight gate, prepare one call at a time, hand each dial to the maintainer, and freeze the evidence. Use when the user says "run the calls", "dial the target", "do a live run", "call it for real", or when an increment needs evidence from the system under test. Never dials by itself.
---

# Live call run

The procedure for pointing callbench at a system it does not own. Every other
skill in this repo is about code; this one is about a phone ringing in
somebody's business.

**This skill never places a call.** It prepares one and stops. The maintainer
dials. That is the invariant in [AGENTS.md](../../../AGENTS.md), and this skill
is what makes it a procedure rather than a good intention.

## When to invoke

- The maintainer says: "run the calls", "live run", "dial it", "call it for real"
- An increment's "done when" requires evidence from the real target
- **Never** because a previous call failed, produced a weak result, or looked
  flaky. There is no code path and no procedural path from a bad call to
  another call. A dropped call is a reported outcome; the maintainer decides
  what happens next.

## Pre-flight gate — all of it, every run

Stop and ask if any item is unmet. These are maintainer-gated prerequisites:
load-bearing, not routable-around.

1. **Consent and recording settled, in writing, for this target.** Jurisdiction,
   party consent, the target's own terms. It lives in the docs, decided by the
   maintainer. Re-settled when the target changes — a prior decision covers a
   prior target, not this one.
2. **The loopback run is green.** The full loop (dial → stream → transcribe →
   respond → assert) works against a number the maintainer owns. The first dial
   to a real business should be the first *interesting* call, not the first call.
3. **Caps declared in the run config and enforced in code** — call count,
   wall-clock minutes, concurrency. Concurrency's natural value is 1; two
   simultaneous calls to a single-line front office is an unauthorized load
   test. A cap the maintainer names verbally is not a cap.
4. **The static gate is green** — `pnpm typecheck && pnpm lint && pnpm vitest
   run`. A bench with a red suite has no standing to report anybody's bugs.
5. **The scenario is reviewed as outward-facing text.** Every line the harness
   will SAY gets the connotation pass with its readings shown
   ([AGENTS.md](../../../AGENTS.md)). The words go to a real business's front
   office. Show the readings before the dial, not after.
6. **Business hours considered.** A call that lands when a person is more likely
   to answer wastes their time and ends the test (below). The maintainer picks
   the window.

## Preparing a call

One call at a time. Assemble and show:

- the scenario and its probe points (from [probes.md](../../../docs/probes.md))
- the target number, read back explicitly — a mis-dial is an unrecoverable,
  unapologizable error against a stranger
- the caps in force, and how many calls of the run's budget remain
- where the evidence will land

Then **stop and hand the dial to the maintainer.** Play the "your move" chime:
`afplay .agents/assets/chime.wav`.

## During the call — the abort conditions

Any of these ends the call. None of them is a retry trigger.

- **A human answers, or the call transfers to one.** The only remaining move is
  to identify the call as a test and end it. Never run a probe, a persona, or an
  authority claim against a person. An escalation probe verifies the offer
  exists; it does not take it.
- **A payment attempt.** Record that card details were solicited. Supply
  nothing — not real data, and not plausible fake data to a system that may try
  to charge it.
- **The scenario goes off the rails** — the flow never reaches the probe point,
  the audio is unintelligible, the harness loses state. That is an
  INCONCLUSIVE result, which is a real result. Report it.

## After the call

1. **Freeze the evidence** — audio, transcript, timings, hashed. A report cites
   the frozen artifact and refuses on a hash mismatch.
2. **Report every outcome, including the boring ones.** PASS, FAIL,
   INCONCLUSIVE. An assertion that could not be evaluated never collapses into
   pass or fail; that collapse is how a bench lies.
3. **Figures come from the run's output.** Never from memory, never from a
   sub-agent's report. Read the number off the artifact and cite where.
4. **One call is an anecdote.** Don't let a single call's result become a
   finding without either determinism across runs or a rate with its
   denominator visible.
5. **Stop.** The run's budget is the budget. Interesting is not a reason to
   dial again; it's a reason to tell the maintainer what you found.

## Writing the findings

The bench's job ends at the evidence. When findings get written up for a human:

- Observed behavior plus the input that produced it. The reader draws the
  conclusion.
- Every claim traces to a transcript span with a timestamp. A claim with no span
  is not a finding.
- Never characterize the system's quality or its builder's competence. A finding
  that can't survive being read aloud to its author is written wrong.
- The prose is the maintainer's, in the maintainer's voice. Propose; don't ship.
