# Latency lab — three inbound/outbound paths, one number each

The bench measured its own first LLM-vs-LLM call at a **median 8.7s per turn**
(take c41db469) — a strictly sequential STT → LLM → TTS loop where nothing
overlaps and each stage can eat a cold start. This lab exists to replace that
one number with three, measured head to head, so the production path is picked
from data (the bench's own philosophy, turned on itself). See
[../../docs/latency.md](../../docs/latency.md) for the research the contenders
are built from.

## The metric

Every contender implements the same [`TurnPipeline`](contract.ts) and is timed
over the same [fixtures](fixtures.ts). The headline is **time-to-first-audio
from end-of-caller-speech** — the silence the far end actually hears. We also
record time-to-final so a fast-but-truncated path can't win by cutting the
reply short, and we keep the heard/replied text so quality is visible next to
speed. All times are ms from `markTurnEnd`.

## The three contenders

| Folder | Path | Stays on Modal? | Cost | Build effort |
|---|---|---|---|---|
| [`modal-selfhost/`](modal-selfhost/) | streaming Parakeet/Whisper + vLLM + Kokoro, all Modal, overlapped | yes | GPU keep-warm | highest |
| [`managed-deepgram-cartesia/`](managed-deepgram-cartesia/) | Deepgram Flux STT + LLM + Cartesia Sonic TTS | no | per-minute API | medium |
| [`s2s-realtime/`](s2s-realtime/) | one realtime S2S model IS the caller; transcript offline | no | per-minute API | lowest (new design) |

Each folder has its own README naming the exact env keys / Modal deploy it
needs, and an adapter implementing `TurnPipeline`.

## Running the comparison

```sh
# Each contender only runs if its prerequisites are met (keys / deployed
# endpoint); the harness SKIPS a contender it can't reach and says so, so a
# partial run still produces a partial table.
node --env-file=.env experiments/latency-lab/bench.ts
```

The harness renders each fixture's agent turns to 8kHz audio once (shared across
contenders for a fair fight), feeds them to each pipeline at real-time cadence,
and prints a table of first-audio / final-audio / first-text / final-text per
contender per turn, plus medians. Nothing here dials a phone — these measure the
speech pipeline in isolation, before any of it touches the live-call path.

## Two measurement modes — and the live one is the truth

1. **Offline pipeline bench** ([bench.ts](bench.ts)) — feed a fixture's audio to
   each `TurnPipeline` and time it in isolation. Fast to iterate, no phone, no
   Twilio jitter. Good for tuning a single contender's config.
2. **Live over the owned numbers** — the REAL measurement. Each contender, once
   wired behind the `provider:model` seam, drives an owned-loop call (the bench
   number to the simulator number, exactly the path that produced the 8.7s
   baseline), and [`scripts/analyze-takes.ts`](../../scripts/analyze-takes.ts)
   computes the real voice-to-voice latency distribution over N takes. This is
   the number that decides the winner — the offline bench can't see Twilio's
   own transit, and the whole point is the latency a real call has.

The winner is then wired behind the existing `provider:model` seam
([docs/models.md](../../docs/models.md)) and carried into the live driver. The
record/assert split and the dial gate are untouched by anything in this folder —
these numbers are the owned loop, never the real shop.

## Honest constraints

- **The self-host path needs a Modal deploy** (`CALLBENCH_WARM=1 modal deploy
  infra/modal/{stt,llm,tts}.py`) — a maintainer step with a keep-warm GPU bill.
- **The managed and S2S paths need API keys** (Deepgram, Cartesia, OpenAI
  Realtime / Gemini) in `.env` — a paid dependency.
- **S2S needs a transcript for grading**: the record is transcribed OFFLINE from
  the frozen audio, and forcing a verbatim probe line mid-conversation is a
  design point its adapter documents. This is the contender that buys the most
  speed and costs the most in bench-fit; the lab exists to weigh exactly that.
