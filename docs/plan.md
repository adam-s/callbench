# Plan

Work ships in numbered increments. Each takes the previous one's frozen output
as its only input, ends by passing the checkout gate (`pnpm typecheck && pnpm
lint && pnpm vitest run` green, plus a red-team pass), and writes what it froze
to `docs/contracts/increment-NN-*.md`.

Increment 0 is done: this scaffold. Everything below is unbuilt.

The goal the increments serve: a small set of scenarios, each run a handful of
times against a real voice agent, producing one frozen report a human turns into
a message. Read [brief.md](brief.md) for why, [probes.md](probes.md) for what a
call looks for, [architecture.md](architecture.md) for the shape.

---

## Increment 0 — Scaffold ✅

The spine: `AGENTS.md`, `.agents/` (skills + references + chimes), Biome /
Vitest / TypeScript strict, pnpm workspace, `packages/shared` with the DEBUG
module and the core types, docs. Gate green from the first commit.

Frozen: [contracts/increment-00-scaffold.md](contracts/increment-00-scaffold.md).

## Increment 1 — Transport + loopback dry run

**Done when** the harness places a call to a number the maintainer owns, streams
audio both ways, and writes a timestamped transcript — without a single call
reaching the shop.

- Buy a number (see the account facts in [drivers.md](drivers.md)).
- Transport contract + the Twilio Media Streams adapter behind it.
- A trivial answering endpoint on the maintainer's own number to call into.
- **Probe first**: capture the real frame shape, encoding, and event sequence
  before writing a parser. The 8kHz-mulaw assumption in `drivers.md` is a label,
  not a fact.
- **Establish the timing baseline here.** A known-latency loopback is the only
  place to learn what the harness's own overhead costs, and every later latency
  figure is meaningless without it. Name the two endpoints and stamp both from
  one clock at one layer.

Freezes: the transport contract, the frame format, the clock and its layer.

## Increment 2 — Speech in, speech out

**Done when** the loopback call holds a scripted two-turn exchange: the harness
speaks, hears the reply, and both land in the transcript with confidence
signals attached.

- STT and TTS contracts + one adapter each.
- Turn model and the append-only transcript.
- Fixtures recorded from Increment 1's real audio, so the suite tests this
  without the network.
- The confidence signal is load-bearing: it is what INCONCLUSIVE is built on
  later. A transcript that can't say "I didn't hear that" can't abstain.

Freezes: STT/TTS contracts, the turn shape, the transcript format and its hash.

## Increment 3 — Scenarios and the assertion layer

**Done when** a scenario file drives the loopback exchange and produces a report
with PASS / FAIL / INCONCLUSIVE results, each traced to a transcript span.

- Scenario definition: ordered turns, probe injection points, assertions.
- Assertions as plain deterministic code over the frozen transcript.
- Report writer: diffable, cites spans, refuses on hash mismatch.
- **The three-state outcome is the point of this increment.** Get INCONCLUSIVE
  working before anything real is dialed — a bench that can't abstain will lie
  under exactly the conditions where lying costs the most.

Freezes: the scenario contract, the report format.

## Increment 4 — The hybrid tester

**Done when** a model persona carries the conversation while the harness still
enforces its probe points.

- Realtime-model persona behind the scenario seam (see [drivers.md](drivers.md)).
- **Probe injection enforced by the harness, not requested in a prompt.** The
  failure this guards: a persona that improvises past a probe produces a call
  that looks successful and tests nothing.
- Model judgment stays a named, isolated stage; its output is recorded as
  judgment, never as fact.

Freezes: the persona seam, the probe-enforcement mechanism.

## Increment 5 — First live run

**Done when** the maintainer has approved and dialed a bounded set of calls to
the real line, and the frozen reports exist.

Prerequisites, all maintainer-gated, none routable-around:

- **Recording and consent settled and written down** — jurisdiction, party
  consent, the target's own terms. Colorado's one-party rule and Adam's status
  as a party to the call is the *starting* analysis, not the finding; the
  maintainer decides and records it before the first dial.
- Every earlier increment green against the loopback.
- Caps declared in the run config: call count, minutes, concurrency (default 1).
- The `live-call` skill's checklist walked, dial by dial.

The scenarios come from [probes.md](probes.md). Start with the disambiguation
family — it's the cheapest call and the highest-signal finding.

## Increment 6 — The report a human sends

**Done when** the maintainer has what they need to write the message: findings
grouped, each with its span, its input, and its rate across runs.

The bench's job ends at the evidence. The prose is Adam's, in Adam's voice, and
gets the connotation pass in [AGENTS.md](../AGENTS.md) — the person who built
the system will read it.

---

## Standing rules for every increment

- Probe before building. A silent empty result is a re-probe signal.
- Every fixed behavior gets a regression test; every frozen interface gets a
  contract test.
- Red-team at checkout: production code, then tests, then mutations. Extend the
  mutation catalog with 2–3 entries targeting whatever the increment locked
  down — it's a living artifact, not a snapshot.
- Figures in any record come from the run's output, never from memory.
- No package before its increment needs it.
