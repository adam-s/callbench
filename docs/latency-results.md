# Latency — what we did, and the grid to decide from

A working record of the latency investigation (2026-07-16): why we started, what
we measured, what we built, and the head-to-head grid the production speech path
gets chosen from. Read [latency.md](latency.md) for the deeper research; the
runnable comparison lives in
[experiments/latency-lab/](../experiments/latency-lab/).

**One rule this document keeps:** a number is either MEASURED (from a real call,
cited to its take) or PROJECTED (from research, cited to a source). They never
share a column without a label. A projected number presented as measured is the
invented-dashboard failure the brief warns against — the reader ships this stack
and would see through it instantly.

## What we did

1. **Ran the first full LLM-vs-LLM call over the owned two-number loop** — a
   persona-model caller against a shop-imitation model target, both improvising
   over real Twilio audio (take `c41db469`). It worked as a conversation, and it
   handed us the real number: **a median 8.7s per turn** (7.5–11.8s). That is
   the baseline everything below is measured against.
2. **Diagnosed the 8.7s** as a strictly SEQUENTIAL loop: caller finishes → POST
   the whole utterance to STT → await the full transcript → full LLM completion
   → synthesize the whole reply → send. Nothing overlaps, and every stage can
   also eat a serverless cold start.
3. **Ran five parallel research passes** (STT, LLM, TTS, pipeline architecture,
   then four contender-config passes) against primary sources — production
   voice-agent stacks, vendor docs, GitHub. Findings and citations in
   [latency.md](latency.md) and each contender's recipe README.
4. **Built the Modal-native fast path** (committed, gate-green): Whisper
   `large-v3` → `large-v3-turbo` (~2.7× faster, neutral WER); a streaming TTS
   route that flushes each Kokoro clause to the wire as it synthesizes; an
   env-gated keep-warm knob (`CALLBENCH_WARM=1`) across all three services.
5. **Stood up the latency lab** — four contenders behind one `TurnPipeline`
   contract, each with its exact low-latency config recorded, measured two ways:
   offline for iteration, then LIVE over the owned loop for the real number.

## The universal finding

Across every contender, the bottleneck is **not** STT or TTS compute. It is
**endpointing wait + LLM first-token + network hops**. The fix, everywhere, is
the same: stream every stage so they overlap, and use SPECULATIVE ENDPOINTING —
start generating on a provisional turn-end and cancel if the caller resumes.
Once overlapped, voice-to-voice ≈ endpointing + LLM-first-token + TTS-first-audio
(≈700ms–1s in production), NOT the sum of full stages (our 8.7s). Our `vad.ts`
already emits `turn-maybe-end` and re-attaches on resume — the exact substrate
Deepgram Flux's eager-EoT and OpenAI's server-VAD are built on. We are closer to
the fast regime than 8.7s suggests.

## The grid

### Measured (real calls, owned loop)

| What | Median voice-to-voice | Take | Notes |
|---|---|---|---|
| Sequential loop (STT→LLM→TTS, no overlap, cold-start-prone) | **8.7s** (7.5–11.8s) | `c41db469` | the baseline; batch faster-whisper + `claude -p` subprocess + whole-utterance Kokoro |
| Same loop, per-stage split | **8.9s** (7.9–10.6s) | `1784193757706` | 11-turn unscripted call; the split below |

#### Per-stage breakdown (measured, take `1784193757706`)

| Stage | Median | Range | Share |
|---|---|---|---|
| STT (audio→text) | 2.0s | 1.3–2.5s | ~23% |
| **LLM (reasoning)** | **4.7s** | 3.9–5.5s | **~53%** |
| TTS + transit (remainder) | ~2.2s | — | ~24% |

**The LLM leg dominates — more than 2× the STT.** The specific cause is measured,
not guessed: the persona and shop both run `claude -p` as a SUBPROCESS per turn,
which boots the whole Claude Code harness before a NON-streaming completion (one
turn spiked to 66s — a subprocess hang). Audio is not the bottleneck; the LLM
leg is. This is why the #1 change is a streaming in-process LLM runner, and why
the Modal co-location of stages is the SECOND lever, not the first — collapse the
4.7s LLM block before chasing the network hops.

### Projected (research, not yet dialed — each needs its prerequisite to become a measured number)

| Contender | Projected v2v | Source basis | Key config lever | Cost | Bench-fit | Prerequisite |
|---|---|---|---|---|---|---|
| **S2S realtime** (gpt-realtime / Gemini Live) | ~200–500ms | OpenAI/Twilio sample, GA docs | native `audio/pcmu`; `silence_duration_ms≈200` | per-min API | transcript is approximate; verbatim probe via `conversation.item.create` | `OPENAI_API_KEY` |
| **Managed** (Deepgram Flux + Cartesia Sonic) | ~700ms–1s | measured Pipecat/Modal build (1.048s) | **Flux `eager_eot_threshold≈0.4`** | per-min API | full: text+confidence, own the transcript | `DEEPGRAM_API_KEY` + `CARTESIA_API_KEY` |
| **Self-host on Modal** (Parakeet/vLLM/Kokoro) | ~1s warm | Modal's own measured stack | region co-location + Tunnels; clause LLM→TTS overlap | GPU keep-warm | full; on our infra | `CALLBENCH_WARM=1 modal deploy` |
| **Twilio-native** (RTT + Media Streams) | a hop, not a win | Deepgram-direct benchmarks | — (forks to same engines over HTTP callback) | $0.027/min | text+confidence+audio, but slower than direct Deepgram | Twilio config only |

### Component wins already banked (Modal fast path, committed)

| Change | From → to | Effect | Status |
|---|---|---|---|
| STT model | `large-v3` → `large-v3-turbo` | ~2.7× faster inference, neutral WER | committed, needs deploy |
| TTS | whole-utterance → clause-streamed to pacer | first-audio 1–3s → tens of ms | committed, needs deploy |
| Cold start | scale-to-zero → `CALLBENCH_WARM=1` keep-warm | removes 2–120s cold tail | committed, needs deploy |
| Turn-taking | single 900ms hangover → two-stage cancellable | mid-sentence pause re-attaches; the eager-EoT substrate | committed & live-proven |

## The one setting that matters most, per contender

- **Managed:** Flux `eager_eot_threshold≈0.4` — starts the LLM on the tail of
  the caller's speech; the single highest-value change in the whole study.
- **Self-host:** regional co-location + Modal Tunnels (kills the network-hop
  tax), then clause-level LLM→TTS overlap.
- **S2S:** native `audio/pcmu` end-to-end + tightened `silence_duration_ms`.
- **Twilio-native:** none worth the hop — run Deepgram directly instead.

## How the projected numbers become measured

Each contender, once its prerequisite is met, is wired behind the
`provider:model` seam ([models.md](models.md)) and drives an owned-loop call —
the same path that produced the 8.7s baseline. `scripts/analyze-takes.ts`
computes the real voice-to-voice distribution over N takes. Only then does a
projected row become a measured one. Nothing here dials the real shop; the
owned-loop numbers buy rehearsal fidelity (a caller fast enough that a real
agent doesn't re-prompt), which is the gate before the real call.

## Recommendation

Wire the **managed Deepgram Flux + Cartesia** contender first — least build,
proven sub-second, and its one lever (eager-EoT) is the highest-value single
change in the study — measure it live over the owned loop, and use that real
number to decide whether the self-host build or S2S is worth chasing. Do not let
this grid's projected column stand in for the measured one: the whole point of
the bench is that the number comes from the call.
