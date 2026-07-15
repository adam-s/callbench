# Plan

Work ships in numbered increments. Each takes the previous one's frozen output
as its only input, ends by passing the checkout gate (`pnpm typecheck && pnpm
lint && pnpm vitest run` green, plus a red-team pass), and writes what it froze
to `docs/contracts/increment-NN-*.md`.

Increments 0-2 and all of Increment 4 (assertion layer, judge, scenario runner)
are built over the simulator; the ✅/🟡 headings below carry status and frozen
contracts. The live exchange (a dial), the web
UI, the hybrid tester, and the live runs are ahead.

The goal the increments serve: a small set of scenarios, each run a handful of
times against a real voice agent, producing frozen reports a human turns into a
message — and a UI that makes each finding audible. Read [brief.md](brief.md)
for why, [probes.md](probes.md) for what a call looks for,
[architecture.md](architecture.md) for the shape, [ui.md](ui.md) for the surface.

**Read the order as a claim, not a schedule.** Two things drive it, and both are
about not lying:

- **The simulator comes before the assertions** (3 before 4) because an assertion
  can only be trusted once you have watched it fail. A target that might be
  correct cannot distinguish a working assertion from one that never runs.
- **The UI comes after the engine** (5, not 1) because it renders evidence, and
  evidence has to exist first. A dashboard of invented numbers is the one
  artifact this project's reader would see through instantly.

---

## Increment 0 — Scaffold ✅

The spine: `AGENTS.md`, `.agents/` (skills + references + chimes), Biome /
Vitest / TypeScript strict, pnpm workspace, `packages/shared` with the DEBUG
module and the core types, docs. Gate green from the first commit.

Frozen: [contracts/increment-00-scaffold.md](contracts/increment-00-scaffold.md).

## Increment 1 — Transport + loopback dry run ✅

**Done when** the harness places a call to a number the maintainer owns, streams
audio both ways, and writes a timestamped transcript — without a single call
reaching the shop.

- A number is already owned; the dial path is probed and works. See the probe
  findings in [drivers.md](drivers.md) for what was measured and what wasn't.
- Transport contract + the Twilio Media Streams adapter behind it.
- **The loopback needs a second number with a TwiML endpoint answering it, not a
  personal handset.** The dial probe established why: a cell screens an unknown
  caller to voicemail, and Twilio still reports the call `completed` — a loopback
  that answers nondeterministically, or not at all, teaches nothing.
  **Purchased 2026-07-15** with maintainer approval (`callbench-simulator` in
  the account; details in [drivers.md](drivers.md)) — the simulator (Increment
  3) answers it, which is how that increment folds back into this one.
- Requires a public tunnel so the provider can reach the local server for TwiML
  and the media WebSocket.
- **Probe first**: capture the real frame shape, encoding, and event sequence
  before writing a parser. The 8kHz-mulaw assumption in `drivers.md` is a label,
  not a fact.
- **Establish the timing baseline here.** A known-latency loopback is the only
  place to learn what the harness's own overhead costs, and every later latency
  figure is meaningless without it. Name the two endpoints and stamp both from
  one clock at one layer.

Frozen: [contracts/increment-01-transport.md](contracts/increment-01-transport.md) —
the contract, the measured frame format, the clock and its layer, and the
timing baseline (~180ms one-way, ~360ms round trip, replicated across two
runs).

## Increment 2 — Speech in, speech out 🟡 (contracts frozen; live exchange pending a dial)

**Done when** the loopback call holds a scripted two-turn exchange: the harness
speaks, hears the reply, and both land in the transcript with confidence
signals attached.

- STT and TTS contracts + one adapter each. **Settled: self-hosted on Modal** —
  faster-whisper (STT) and Kokoro-82M (TTS), both deployed; see
  [speech.md](speech.md) and [models.md](models.md).
- Turn model and the append-only transcript.
- Fixtures recorded from Increment 1's real audio, **committed** with the source
  they test, so the suite runs on a fresh clone with no network. Capture from the
  wire, never from a convenient path: room audio through a speakerphone is a
  different signal and a fixture built from it tests the wrong thing.
- **Turn-taking is the hard part, and it is in this increment or it ambushes the
  next one.** Knowing when the far end has stopped speaking is what makes a reply
  possible; a naive silence timer is how a bench talks over people.
- The confidence signal is load-bearing: it is what INCONCLUSIVE is built on
  later. A transcript that can't say "I didn't hear that" can't abstain.

Frozen: [contracts/increment-02-speech.md](contracts/increment-02-speech.md) —
the transcript center (hash+freeze), the STT/TTS/turn contracts, and the
TTS→wire→STT pipeline proven end to end. The live two-turn Twilio exchange is
pending an approved loopback dial and lands with the simulator (Increment 3).

## Increment 3 — The target simulator 🟡 (flow + defects built; live answering pending a dial)

**Done when** a voice agent we own answers a call and holds the shop's flow —
greets, asks for the vehicle, quotes, takes a correction, reads back — and the
harness can drive it end to end.

The practice target. It is early in the order for one reason: **it is the only
place an assertion can be proven to fire.** Point the bench at a working system
and everything passes, which is indistinguishable from assertions that never
run. The simulator can be made wrong on purpose.

- Behavior spec comes from the warm-up call's observations, not from invention.
- Deliberate-defect switches: fabricate a feature, drop a correction, go silent
  mid-turn, degrade the audio. Each one exists to make a specific assertion fail
  on demand.
- It replaces the trivial loopback endpoint from Increment 1 and becomes the
  target for everything up to Increment 6.

Freezes: the simulator's defect switches (each is a test's fixture).

## Increment 4 — Scenarios and the assertion layer 🟡 (assertion layer, judge, and scenario runner built over the simulator; live exchange pending a dial)

**Done when** a scenario drives the simulator and produces a report with
PASS / FAIL / INCONCLUSIVE results, each traced to a transcript span — and the
deliberate defects make the right assertions fail.

- Scenario definition: ordered turns, probe injection points, assertions.
- **Tests are authored in code** and run over the *frozen artifact*, never over a
  live call. Recording and asserting are separate programs
  ([architecture.md](architecture.md)); this is what lets an assertion be fixed
  and re-run at no cost to anyone's phone line.
- Assertions in plain deterministic code wherever the question can be expressed
  that way — which is most of [probes.md](probes.md). Prefer code.
- **The judge** for what code cannot express: a named, isolated stage scoring
  the irreducibly semantic assertions, its verdict recorded as judgment rather
  than fact and frozen against a content hash so replays stay deterministic and
  offline. It ships with a calibration set, because a judge that always returns
  PASS passes every suite it grades.
- Report writer: diffable, cites spans, refuses on hash mismatch.
- **The three-state outcome is the point of this increment.** Get INCONCLUSIVE
  working before anything real is dialed — a bench that can't abstain will lie
  under exactly the conditions where lying costs the most. The simulator's
  audio-degradation switch is how you prove abstention works.

Freezes: the scenario contract, the report format, the judge contract and its
cache key.

## Increment 5 — The web UI 🟡 (scaffold, routes, artifact contract, dial fence, and the audio centerpiece built; rich dataviz ahead)

**Done when** a QA engineer can open the app, see the tests, open a run, and
hear the moment a finding is about — with the audio, the waveform, and the
transcript in sync.

Built so far: the SvelteKit app (`apps/web`), all four path-based routes
rendering server-side from a frozen run artifact, the on-disk run-artifact
contract (`@callbench/scenario` `artifact.ts`) that REFUSES on a hash mismatch,
a mislabeled artifact, an unknown version, or a body/audio-reference drift, and
the dial fence — a `system-under-test` run is view-only and a structural test
asserts NO dial CAPABILITY (outbound network / media egress / telephony) exists
in the app at all. **The centerpiece works**: the ported Web Audio engine, a
server-side waveform (peaks computed from the frozen file — no client fetch, so
the fence stays airtight), a hash-verified audio-serving route, and
click-a-finding-to-hear-its-span (the deep link auto-plays the cited moment).
Simulator fixtures carry real speech synthesized locally (macOS `say`, tagged
`synthetic` so it is never mistaken for a capture), with transcript timings taken
from the real audio durations so waveform and spans align. The **turn ribbon**
(two-lane temporal view) and a **live level meter** (the AnalyserNode spectrum,
during playback — measuring nothing) are built and wired into the run page; the
assertion matrix (scenarios × runs, three states, a mixed row flagged) is on the
per-scenario page. The **fact ledger** and **latency strip** are deferred with
the live dials: on the simulator fixtures the inter-turn gaps are a fixed
synthetic constant and there is no correction to propagate, so both need
real-call variation (or a correction fixture) to show anything true rather than a
flat placeholder. The gate covers the app, including a jsdom project for the
audio engine (see the amendment in
[contracts/increment-00-scaffold.md](contracts/increment-00-scaffold.md)).

Built after the engine, deliberately: **a UI over a non-existent engine is a
facade, and the intended reader builds this stack for a living.** Rough real
evidence beats a polished dashboard of invented numbers. Every increment before
this one produces real artifacts for it to render.

- SvelteKit, path-based routes. Test list, run detail, deep links to a finding.
- Waveform, level meter, playhead, transcript synced to playback — a Web Audio
  pipeline over the frozen recording, measuring nothing
  ([architecture.md](architecture.md)).
- **Click a finding → hear its span.** This is the centerpiece: it turns a claim
  into something the reader can verify by ear, which is the whole argument for
  building a bench rather than forming an opinion.
- **The UI renders; it never dials.** Against the simulator, a run control is
  free and correct. Against the real target there is no such control — not
  behind a confirmation, not behind a flag. See the invariant in
  [AGENTS.md](../AGENTS.md).

See [ui.md](ui.md) for the routes and the surface. Freezes: the route shape, the
report-rendering contract.

## Increment 6 — The hybrid tester

**Done when** a model persona carries the conversation while the harness still
enforces its probe points.

- Realtime-model persona behind the scenario seam (see [drivers.md](drivers.md)).
- **Probe injection enforced by the harness, not requested in a prompt.** The
  failure this guards: a persona that improvises past a probe produces a call
  that looks successful and tests nothing.
- Model judgment stays a named, isolated stage; its output is recorded as
  judgment, never as fact.
- Exercised against the simulator, where an improvising persona is cheap to
  catch.

Freezes: the persona seam, the probe-enforcement mechanism.

## Increment 7 — First live run

**Done when** the maintainer has approved and dialed a bounded set of calls to
the real line, and the frozen reports exist.

Prerequisites, all maintainer-gated, none routable-around:

- **Recording and consent — settled by the maintainer, 2026-07-15.**
  **Determination: recording is permitted for bench calls to this target.**

  Recorded as the maintainer's decision, which is where this call belongs per
  [AGENTS.md](../AGENTS.md). The grounds, as given, are: the maintainer operates
  from Bolivia and determines no applicable recording restriction attaches
  there; the callee is an automated system rather than a person; and the call is
  one-party, with the maintainer a party to it and the target's jurisdiction
  (Colorado) a one-party state.

  These grounds are recorded as stated, not independently verified — no agent
  should cite them as researched legal fact or extend them past this target. The
  invariant that this is **re-settled when the target changes** stands: a
  different callee reopens the question rather than inheriting this answer.

  The earlier text here — "Colorado's one-party rule and Adam's status as a
  party to the call" as a *starting analysis* — is superseded by the above and
  must not be reused as an open question.

  One limit is unaffected because it never rested on consent: **if a human joins
  the call, the test ends** (invariant), and capture ends with it. The
  determination above covers an automated callee; a person on the line is the
  case it does not describe.
- Every earlier increment green against the simulator, **including proof that
  each scenario's assertions fail when the simulator is made to misbehave.** An
  assertion never observed failing is an assertion never observed.
- Caps declared in the run config: call count, minutes, concurrency (default 1).
  **Built (7a):** `@callbench/runplan` — `normalizeCaps` refuses any unbounded
  cap, `RunBudget` enforces all three at runtime (`started()` throws past a cap,
  so a runner that skips the check still cannot exceed it), and `preflight`
  assembles a plan only if consent is settled, the plan stays within its own call
  cap, and every scenario's outward text has passed the connotation pass
  ([connotation/windshield-quote.md](connotation/windshield-quote.md)). The
  operator entry point is `scripts/preflight.ts` — it prints the plan (number
  redacted) and STOPS; it places no call. The package imports no dial primitive.
- The `live-call` skill's checklist walked, dial by dial.

The scenarios come from [probes.md](probes.md). Start with the disambiguation
family — it's the cheapest call and the highest-signal finding.

## Increment 8 — The report a human sends

**Done when** the maintainer has what they need to write the message: findings
grouped, each with its span, its input, and its rate across runs.

The bench's job ends at the evidence. The prose is Adam's, in Adam's voice, and
gets the connotation pass in [AGENTS.md](../AGENTS.md) — the person who built
the system will read it.

---

## Standing rules for every increment

- **Read [references.md](references.md) before building the seam.** Most of what
  this project needs is solved in public — the turn-detector, the barge-in
  primitive, the whole evaluation architecture — and some of it by people who
  studied the problem longer than we will. Taking the solved thing is the
  default; re-deriving it is the choice that needs a reason.
- Probe before building. A silent empty result is a re-probe signal.
- Every fixed behavior gets a regression test; every frozen interface gets a
  contract test.
- Red-team at checkout: production code, then tests, then mutations. Extend the
  mutation catalog with 2–3 entries targeting whatever the increment locked
  down — it's a living artifact, not a snapshot.
- Figures in any record come from the run's output, never from memory.
- No package before its increment needs it.
