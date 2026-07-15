# callbench

A test bench for voice agents reached over the phone.

The bench places a call into a system it does not own, talks to it, and produces
a deterministic, diffable record of what happened — transcript, timings, and
assertion results. Every finding traces to a span you can play back and hear.

The system under test is somebody's live business line. That single fact drives
most of the design.

## Why this exists

"The quote came back without asking about the rain sensor" is an opinion.

The same claim with the audio, the transcript span, the timestamp, and a
re-runnable scenario that reproduces it is evidence. This repo is the machinery
that turns the first into the second — and some findings only exist under
repetition, because latency distribution and whether a correction survives to the
confirmation are properties of many calls, not one.

See [docs/brief.md](docs/brief.md) for where the project came from.

## How it works

Two phases, joined by a frozen artifact. The split is the load-bearing idea.

```text
─── RECORD (network, human-gated, once per call) ───
scenario → runner → transport → [ target ]
                        ↓
        transcript + audio + timings, hashed and frozen
                        ↓
─── ASSERT (offline, deterministic, re-runnable) ───
        assertions → PASS / FAIL / INCONCLUSIVE + spans
                        ↓
                 report → web UI
```

A call costs somebody's phone line; an assertion costs nothing. Recording once
and asserting a thousand times is what lets the evaluation be fixed, argued with,
and re-run without a stranger's phone ringing again.

[docs/architecture.md](docs/architecture.md) has the full shape.

## The rules that aren't negotiable

These are invariants, not preferences. Breaking one is a regression regardless of
what else improves — the full set is in [AGENTS.md](AGENTS.md).

- **Every dial to a system we don't own is human-approved, one call at a time.**
  No retry-on-failure, no scheduled run, no loop. The bench prepares a call and
  stops; a human starts it. No surface is exempt — a confirmation dialog in front
  of a dial path is still a dial path.
- **A human on the line ends the test.** The bench tests an automated system. If
  a person answers or the call transfers, the only remaining move is to identify
  the call as a test and end it.
- **Give-up is a first-class outcome.** PASS, FAIL, **INCONCLUSIVE**. An
  assertion that could not be evaluated never collapses into pass or fail — that
  collapse is how a bench lies.
- **A transcript is evidence, not a summary.** Stored verbatim with timings. A
  claim with no traceable span is not a finding.
- **A finding will be read by the person who built the system.** Describe the
  observed behavior and the input that produced it; let the reader draw the
  conclusion.

## Layout

```text
AGENTS.md            principles and policy for coding agents (start here)
docs/                brief, architecture, plan, probes, drivers, speech, ui,
                     models, warm-up-call
docs/references.md   prior art per concept — read before building a seam
docs/connotation/    connotation-pass artifacts for scenarios' outward text
docs/contracts/      what each increment froze
.agents/             skills and references (.claude/skills symlinks here)
packages/            shared, transport, transcript, stt, tts, turn, simulator,
                     assert, judge, scenario, runplan
apps/web/            the SvelteKit evidence viewer (server-side; renders artifacts)
infra/modal/         self-hosted models (STT, TTS, LLM) + manage.sh; see models.md
scripts/probes/      one-shot empirical discovery against a live surface
scripts/evals/       model/provider comparisons over captured data
scripts/preflight.ts live-run pre-flight — prints the bounded plan, places no call
scripts/lib/         shared script plumbing (the dial guard, the tunnel helper)
data/                gitignored — raw capture. No test may read it.
```

## Status

Built and gate-green, all against the deterministic simulator (no live dial yet):
**Increment 0** (scaffold), **1** (transport + loopback, timing baseline),
**2** (speech in/out — contracts frozen, pipeline proven), **3** (the target
simulator's flow + defect switches), **4** (the assertion layer + three-state
outcome, the judge, and the scenario runner), **5** (the web UI — routes, the
on-disk run-artifact contract, the dial fence, the audio centerpiece
"click a finding → hear its span", and temporal dataviz), and **7a** (the
live-run pre-flight: bounded caps enforced in code, consent + connotation gates,
a plan that stops before the dial). Models run self-hosted on Modal
([docs/models.md](docs/models.md)); the live speech path needs Modal STT/TTS
configured (a maintainer step).

Ahead, all requiring a live dial the maintainer starts, one call at a time: the
live loopback proof and first live scenario (closing Increments 2–4 against real
audio), the hybrid persona (Increment 6), and the first live run against the real
shop (Increment 7b). See [docs/plan.md](docs/plan.md) for the increments and,
more usefully, for why they're in that order.

Two ordering claims worth knowing up front:

- **The simulator comes before the assertions.** An assertion can only be trusted
  once you've watched it fail, and a target that might be behaving correctly
  cannot distinguish a working assertion from one that never runs.
- **The UI comes after the engine.** It renders evidence, and evidence has to
  exist first.

## Working on this

Read [AGENTS.md](AGENTS.md) first — it is the canonical instruction set, and it
holds principles rather than recipes. Project specifics live in `docs/`, in the
per-increment contracts, and in the code.

The gate, green before any checkout:

```sh
pnpm typecheck && pnpm lint && pnpm vitest run
```

The suite never touches the network and never needs a credential. Every seam that
would is a contract precisely so that holds — a test that dials, or wants a
token, is misplaced by construction.
