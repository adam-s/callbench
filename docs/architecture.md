# Architecture

The shape the increments build into. Written before the code, so it describes
intent; where the code disagrees with this file, the code is right and this file
is a bug.

## The one-sentence version

A scenario drives a call through a transport, every utterance in both directions
lands in a frozen transcript with timings, and assertions read that frozen
artifact — never the live call — to produce a report.

## Two phases, and the seam between them is a file

This is the load-bearing split. **Recording and asserting are separate
programs.**

```text
─── RECORD (network, human-gated, once per call) ────────────────────────
scenario ──► runner ──► transport ──► [ target: real, or the simulator ]
                │           │
                │           ├─ inbound audio ──► stt ──► turn
                │           └─ outbound audio ◄── tts ◄── turn
                ▼
            transcript + audio + timings, hashed and frozen
                │
════════════════╪══════ the artifact is the seam ════════════════════════
                ▼
─── ASSERT (offline, deterministic, re-runnable forever) ────────────────
            assertions ─┬─ code ────────► PASS / FAIL / INCONCLUSIVE
                        └─ judge (cached) ─┘        + spans
                │
                ▼
            report ──► web UI (renders; never dials)
```

Why the split is not a style choice:

- **A call costs somebody's phone line; an assertion costs nothing.** Iterating
  on assertions must never re-dial. One recording backs a thousand assert runs.
- **It is what lets the suite run offline.** Assertions read a file. No
  transport, no credential, no network — the rule in
  [AGENTS.md](../AGENTS.md) holds by construction rather than by discipline.
- **It makes a finding re-derivable.** The report is a pure function of the
  frozen artifact plus the assertion code. Change the code, re-derive; the
  evidence does not move.

## The seams

- **transport** — places a call, streams audio both ways, reports call
  lifecycle. Twilio Media Streams first; SIP and browser-WebRTC are further
  adapters behind the same contract. See [drivers.md](drivers.md).
- **stt** — audio in, timestamped text out, with a confidence signal that the
  INCONCLUSIVE path depends on. See [speech.md](speech.md).
- **tts** — text in, audio out, in the transport's frame format.
- **scenario** — the turn machine: what to say, when to inject a probe, what to
  assert. Model-driven conversation is a strategy *inside* this seam, never
  underneath it.
- **judge** — a named, isolated stage that scores the assertions plain code
  cannot express. Described below; it is not plumbing.
- **assertions + report** — read the frozen artifact and nothing else. No
  transport, no clock of their own.
- **simulator** — a target we own, so scenarios can be exercised without dialing
  anyone. Described below.
- **web** — renders frozen reports. A viewer, never a second way to dial.

## The judge, and why it is fenced

Most of [probes.md](probes.md) is checkable in plain code: did a price appear
before any question was asked, does the read-back contain the corrected year,
what did the latency measure. **Prefer code every time.** It is free,
deterministic, and reviewable.

Some assertions are irreducibly semantic — "did it ask a *disambiguating*
question" has a thousand valid phrasings and no regex. That is where a model
judge earns its place, under three constraints:

1. **Named and isolated.** One stage, one contract. Nothing downstream learns a
   verdict came from a model rather than from code — except the record, which
   says so explicitly.
2. **Recorded as judgment, not fact.** A verdict carries its rubric, the span it
   read, and its reasoning, so a human can overrule it. This is the rule in
   [AGENTS.md](../AGENTS.md), and the report format is what enforces it.
3. **Frozen at first evaluation.** A verdict is cached against a content hash of
   what it judged. Re-running the suite replays the cache — deterministic and
   offline. A cache miss is the only thing that reaches the network, and it never
   happens under test.

That third point is not a convenience. **Sampling controls cannot deliver
determinism here** — the judge model exposes no temperature or seed, and even
where such knobs exist they never guaranteed identical output. Determinism comes
from freezing the verdict, not from asking the model to be repeatable.

A judge that always returns PASS passes every suite it grades. It therefore
carries a calibration set — known-good and known-bad artifacts with known
verdicts — and that set is a test, not a document.

## The simulator

A voice agent we own, standing in for the target: it greets, quotes, takes a
correction, reads back. It exists for two reasons, and the second is the real
one.

The obvious reason is volume — it can be called a thousand times for pennies,
so scenarios get exercised without a stranger's line ringing.

The load-bearing reason is that **assertions cannot be validated against a system
that might be correct.** Point the bench at a working target and everything
passes; you have learned nothing, because you cannot distinguish "the target is
good" from "the assertions never fire." The simulator can be made wrong on
purpose — fabricate a feature, drop a correction, go silent mid-turn — which is
the only way to prove an assertion bites before it grades someone real. The same
argument covers INCONCLUSIVE: abstention is only known to work if you can inject
audio bad enough to trigger it.

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

**No surface is exempt, and a UI is where this gets tested.** A test bench with a
list of tests wants a Run button next to each one; against the simulator that
button is free and correct, and against the real target it is the invariant
failing with a nice interface on top. The rule is not "ask before dialing" —
a confirmation dialog is still a dial path, and a dial path is what must not
exist. The UI prepares and stops, exactly as the runner does.

## Bounds

A run declares its caps — call count, wall-clock minutes, concurrency — in its
own config, and the runner enforces them in code. Defaults are conservative;
an unbounded default is a bug even if no run reaches the ceiling.

Concurrency deserves a specific note: the natural cap is 1. Two simultaneous
calls to a single-line front office is a load test nobody authorized.

## The two audio pipelines

Audio moves through this system twice, in two different runtimes, and they are
not the same pipeline. Conflating them is how a latency number goes wrong.

**Server-side — the call pipeline.** Narrowband frames off the wire (the
transport's format; see [drivers.md](drivers.md)), into speech-to-text, and
synthesized audio back out. This is the pipeline under measurement. Everything
that claims a timing figure lives here, stamped from one clock at one layer.

**Client-side — the Web Audio pipeline.** In the browser, an `AudioContext` and
an `AnalyserNode` over the frozen recording drive the waveform, the meter, and
the playhead. **This pipeline measures nothing.** It is a rendering of evidence
already captured. A dB reading drawn here is a property of the artifact, not of
the call, and no figure in a report may be derived from it.

**WebRTC** sits in the first pipeline, not the second: a browser-side transport
adapter (a WebRTC client injecting synthesized audio and capturing the far end)
is a *second implementation of the transport contract*, alongside Twilio Media
Streams — the one-interface rule is exactly what makes that additive rather than
a fork. It is not the default path and does not replace the server pipeline; see
[drivers.md](drivers.md) for why, and [ui.md](ui.md) for the client side.

The reason to keep these straight is the measurement principle in
[AGENTS.md](../AGENTS.md): two stamps from two layers silently fold in transit
and buffering. A browser's `AnalyserNode` is several buffers away from the wire.

## What lives where

```text
packages/shared/     core types + the DEBUG module; no I/O, no providers
packages/…           transport / stt / tts / scenario / transcript / assert /
                     judge / simulator, added per increment — not scaffolded
                     ahead of use
apps/web/            SvelteKit — renders frozen reports. See ui.md.
scripts/             bounded operator entry points (dial, report, probes)
docs/contracts/      what each increment froze
data/                gitignored — raw capture: recordings, transcripts, reports
```

**Fixtures are committed; `data/` is not.** `data/` is gitignored raw capture and
does not exist on a fresh clone, so no test may read it. Test fixtures live
alongside the source they test and travel with the repo. A suite that goes green
only because `data/` happens to be present is green on one machine.

Packages arrive when an increment needs them. Empty packages are inventory, and
the lighter-thing rule says don't.
