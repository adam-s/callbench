# UI — the surface a QA engineer touches

The shape of the web app. Written before the code, so it describes intent; where
the code disagrees, the code is right and this file is a bug.

Built at Increment 5, after the engine — see [plan.md](plan.md) for why that
order is a claim rather than a schedule.

## What it is

**An evidence viewer.** Tests are authored in code; this renders what running
them produced. Its job is to take a claim about somebody's system and make it
something a reader can check by ear in ten seconds.

The centerpiece is one gesture:

> **Click a finding → land on the transcript span → hear that moment.**

Everything else is supporting cast. That gesture is the entire argument for
building a bench instead of forming an opinion: it turns "the quote came back
without asking about the sensor" from a critique into evidence, with a
timestamp, from a scenario the reader can re-run.

## Where the work happens

**Everything runs server-side.** Node places the call, owns the media loop,
drives speech-to-text and synthesis, runs the scenario, and evaluates the
assertions. The browser renders and triggers; it never holds a call.

## The play button, and the fence around it

There **is** a play button. It is fenced by target, and the fence is the whole
design:

| Target | Play button | Why |
|---|---|---|
| The simulator | **Yes.** Run it, re-run it, batch it. | It's our agent on both ends. Nobody's line rings. |
| The system under test | **No control exists.** | The invariant in [AGENTS.md](../AGENTS.md) |

For the real target the UI *prepares* a call — scenario, number read back, caps,
budget remaining — and stops. A human dials, exactly as the runner does.

Note what the fence is not: it is not a confirmation dialog, a flag, or a role
check. A dialog in front of a dial path is still a dial path. The path must not
exist. This is the single highest-severity thing to get wrong in the UI, because
a list of tests with Run buttons next to them is precisely where the temptation
arrives wearing good intentions.

The simulator is what makes this livable rather than a compromise. Interactive,
live, hit-play-and-watch is fully available — against a target we own.

## What it is not

- **Not a source of numbers.** Nothing measured in the browser reaches a report.
  See the two pipelines below.
- **Not authoring.** Tests are code. The UI does not edit them.

## Routes

Path-based, no query strings for identity — a run is a place, and a link to a
finding should survive being pasted into a message.

```text
/                             test list — every scenario, last result, pass rate,
                              play (simulator only)
/tests/[test]                 one scenario: what it does, its probes, and every
                              run of it — the assertion matrix lives here
/tests/[test]/[run]           one run: turn ribbon, transcript, audio, waveform,
                              findings
/tests/[test]/[run]/[finding] deep link — seeks to the span and plays it
```

Runs nest under their test because that is how they're read: you arrive at a
scenario and ask "how has this gone?" A flat `/runs/[run]` would make the
comparison across runs — the assertion matrix, the latency distribution — a
thing you assemble by hand.

`[run]` is the frozen artifact's own identifier, so a URL names a specific piece
of evidence and keeps naming it. `[finding]` addresses an assertion within that
run, which is what makes the centerpiece gesture linkable.

Rendering is server-side from the frozen artifact on disk. The route reads the
file; if the hash doesn't match, **the route refuses rather than rendering with a
warning.** A report that renders anyway is how a figure drifts from the call it
claims to describe.

## The visualization

Waveform, level meter, playhead, and transcript scrolling in lockstep with
playback. Findings mark their spans on the waveform, so the shape of the call and
the claims about it are the same picture.

### Why not just copy a CI page

A CI run is a list of steps that each pass or fail. **A call is a conversation
over time between two parties**, and the interesting findings are *temporal and
relational*: who spoke when, what filled a gap, whether a fact survived a
correction, how a result varies across runs. A step list can't show any of that.

Take from CI what CI is good at — a scannable list, an obvious status, a
permalink to a specific run. Then draw the things a step list cannot.

### The catalog, ranked by how much it earns its pixels

**1. Turn ribbon — two lanes over time.** Bench turns on one lane, agent turns on
the other, blocks laid out on a real time axis. One glance shows the rhythm of
the call: who talked, how long the gaps were, where the two overlap. Overlap is
literal talkover, which makes barge-in behavior ([probes.md](probes.md), Family
2) something you *see* rather than infer. This is the highest-value view in the
list and has no CI analogue.

**2. Assertion matrix — scenarios × runs, three states.** A grid, PASS / FAIL /
**INCONCLUSIVE** as three distinct colors, never two-plus-a-shade. A CI matrix
that happens to answer the discipline rule in [probes.md](probes.md): a finding
is either deterministic across runs or reported as a rate with its denominator
visible. **A mixed row is the finding** — it's flakiness in the system under
test, rendered. INCONCLUSIVE needs a color that reads as its own outcome, not as
a degraded pass; the render is where the third state gets quietly collapsed.

**3. Fact ledger — values over turns.** For each fact the flow accumulates
(vehicle, quote, name, callback, slot), a lane showing its value at each turn and
where it changed. A correction that propagates redraws downstream; a correction
that gets acknowledged and dropped shows as a value that *doesn't* move. That is
Family 2's entire question, made visible in one picture — and it's the finding
that survives a skeptical reader, because the system states the wrong value in
its own words.

**4. Latency strip — distribution, never a single number.** One row per probe
point, one dot per run, p50/p95 marked. [probes.md](probes.md) explicitly
requires a distribution rather than one call's figure, and a strip plot makes a
single outlier visibly a single outlier. Only from server-side stamps.

**5. Dead-air overlay.** Flat stretches during a lookup, drawn on the waveform.
A real finding class (Family 3), and it needs no interpretation — which is what
makes it clean. The gap is either there or it isn't.

**6. Live meter + spectrum,** during a simulator run. The one genuinely live
view; the payoff of the play button.

**7. Run diff.** Two runs side by side, transcripts aligned, divergences marked.
What "deterministic across runs" looks like when it isn't.

Colors carry meaning in three places — the three-state outcome, the two speakers,
and the pass/fail history. Pick those deliberately and reuse them everywhere;
they are the app's vocabulary.

### The two pipelines, and why they must not be confused

**Server-side, during a call** — narrowband frames off the wire, through
speech-to-text, and synthesized audio back. This is the pipeline under
measurement. Every timing figure in a report comes from here, stamped at one
layer.

**Client-side, during replay** — an `AudioContext` and an `AnalyserNode` over the
frozen recording drive the meter and the waveform. **This pipeline measures
nothing.** It renders evidence already captured. A level drawn here is a property
of the file, not of the call; a duration read off the playhead is a property of
the decoder. Neither may become a number in a report. An `AnalyserNode` sits
several buffers from the wire, and the measurement principle in
[AGENTS.md](../AGENTS.md) is exactly about not folding those buffers into a
figure.

**WebRTC belongs to the first pipeline, not the second.** A browser-side
transport (a WebRTC client injecting synthesized audio and capturing the far end)
is a *second implementation of the transport contract*, sitting beside Twilio
Media Streams — which is what the one-interface rule buys: additive, not a fork.
It is not the default path; see [drivers.md](drivers.md) for why. It does not
make the replay viewer a live client.

The same components serve live and replay, and that is deliberate rather than
clever: an `AnalyserNode` doesn't care whether its source is an `<audio>` element
or a `MediaStream`. Build the visuals against replay, where the data already
exists; a live view swaps the source and changes nothing downstream.

## Prior art in this repo's neighborhood

`~/Projects/separate` is the maintainer's own Svelte 5 + Web Audio work and
already solves most of this: one `AudioContext` and one `AnalyserNode` reused
across clips, a single rAF loop driving a reactive playhead so visuals cannot
drift apart, a wall-clock fallback for when audio never starts, and an
exclusive-audio bus. Its `playRegion(start, end)` is the centerpiece gesture,
already built.

Take that engine rather than rewriting it. Two differences to expect: it is
Svelte + Vite with no router (callbench needs real routes), and it renders one
essay's fixed clips rather than an artifact directory that grows.

## Stack

SvelteKit. Svelte 5 runes, matching the prior art so the audio engine ports
rather than gets rewritten.

The gate covers this as of Increment 5. `pnpm typecheck` ends with
`pnpm --filter @callbench/web check` (svelte-kit sync + svelte-check), and the
Vitest glob includes `apps/web/src/**/*.test.ts`. That widening amended a frozen
contract ([contracts/increment-00-scaffold.md](contracts/increment-00-scaffold.md));
the amendment is recorded there under the checkout gate rather than made
silently. The server-side run logic (`$lib/server/runs.ts`) is plain Node and
tests under the node environment; component/DOM tests, when the audio engine
arrives, get their own jsdom project.
