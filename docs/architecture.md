# Architecture

The shape the increments build into. Written before the code, so it describes
intent; where the code disagrees with this file, the code is right and this file
is a bug.

## The one-sentence version

A scenario drives a call through a transport, every utterance in both directions
lands in a transcript with timings, and deterministic assertions read that
transcript to produce a report.

## The pipeline

```text
scenario ──► runner ──► transport ──► [ system under test ]
                │           │
                │           ├─ inbound audio ──► stt ──► turn
                │           └─ outbound audio ◄── tts ◄── turn
                ▼
            transcript (append-only, timestamped, hashed)
                │
                ▼
            assertions ──► report (PASS / FAIL / INCONCLUSIVE + spans)
```

Five seams, four of which are contracts:

- **transport** — places a call, streams audio both ways, reports call
  lifecycle. Twilio Media Streams first; SIP and browser-WebRTC are future
  adapters. See [drivers.md](drivers.md).
- **stt** — audio in, timestamped text out, with a confidence signal that the
  INCONCLUSIVE path depends on.
- **tts** — text in, audio out, in the transport's frame format.
- **scenario** — the turn machine: what to say, when to inject a probe, what to
  assert. Model-driven conversation is a strategy *inside* this seam, never
  underneath it.
- **assertions + report** — plain deterministic code over the frozen transcript.
  No model, no network, no clock of its own.

## Why these are contracts

Two reasons, both from [AGENTS.md](../AGENTS.md):

**The suite must never dial.** Every seam that touches the network sits behind
an interface, so the unit suite runs against recorded fixtures with no
credential and no call. A test that needs the network is misplaced by
construction — and a bench whose own tests are unreliable has no standing to
report someone else's flakiness.

**Providers churn.** Speech-to-text and synthesis are commodity slots. The core
never learns which adapter produced a turn; identity travels with the record as
an explicit provider tag. A stage typed for its first provider hides the
coupling until the second arrives.

## The transcript is the center

Everything else is replaceable around it. It is:

- **append-only** — turns accumulate, nothing is rewritten;
- **verbatim** — what was said, not a summary;
- **timestamped from one clock at one layer** — so a duration derived from two
  spans means something (see the measurement principle in
  [AGENTS.md](../AGENTS.md));
- **hashed and frozen at the end of the call** — a report cites the frozen
  artifact and refuses on a hash mismatch, so a figure can never drift from the
  call it describes;
- **the only input to assertions** — which is what makes a finding traceable to
  a span, and what makes the report re-derivable from the artifact.

## Where the human sits

Between "prepared" and "dialed", and nowhere else in the loop.

The runner assembles a call — scenario, target, caps — and stops. A human
starts it. This is not a confirmation prompt that a `--yes` flag can retire; it
is the invariant that keeps a test suite from being one bug away from flooding a
business line. Everything after the dial is automatic, and everything after the
call is deterministic.

The consequence for design: **there is no code path from a failed call to a new
call.** Retry, redial, and scheduled runs don't exist as features. A dropped
call is a reported outcome.

## Bounds

A run declares its caps — call count, wall-clock minutes, concurrency — in its
own config, and the runner enforces them in code. Defaults are conservative;
an unbounded default is a bug even if no run reaches the ceiling.

Concurrency deserves a specific note: the natural cap is 1. Two simultaneous
calls to a single-line front office is a load test nobody authorized.

## What lives where

```text
packages/shared/     core types + the DEBUG module; no I/O, no providers
packages/…           transport / stt / tts / scenario / transcript / assert,
                     added per increment — not scaffolded ahead of use
scripts/             bounded operator entry points (dial, report, probes)
docs/contracts/      what each increment froze
data/                gitignored — recordings, transcripts, reports
```

Packages arrive when an increment needs them. Empty packages are inventory, and
the lighter-thing rule says don't.
