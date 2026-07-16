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

| Folder | Path | Expected v2v | Cost | Note |
|---|---|---|---|---|
| [`modal-selfhost/`](modal-selfhost/) | streaming Parakeet/Whisper + vLLM + Kokoro, all Modal, overlapped | ~1s warm | GPU keep-warm | on your infra, full control |
| [`managed-deepgram-cartesia/`](managed-deepgram-cartesia/) | Deepgram Flux STT + LLM + Cartesia Sonic TTS | ~700ms–1s | per-min API | Flux eager-EoT is the lever |
| [`s2s-realtime/`](s2s-realtime/) | one realtime model IS the caller; transcript offline | ~200–500ms | per-min API | fastest; approximate transcript |
| [`twilio-native/`](twilio-native/) | Twilio Real-Time Transcription + Media Streams | a hop, not a win | $0.027/min | text+confidence, but not faster than direct Deepgram |

Each folder has its own README naming the exact env keys / Modal deploy it
needs.

## Status (2026-07-16): decided from live measurement; the offline harness was never built

`contract.ts` and `fixtures.ts` are the SPEC for an offline pipeline bench
(`bench.ts`, one `adapter.ts` per contender) that was planned but not built —
no adapter or harness exists in these folders. The decision did not wait for
it: the self-host path was wired behind the `provider:model` seam and measured
LIVE over the owned two-number loop, exactly the path that produced the 8.7s
baseline, with [`scripts/analyze-takes.ts`](../../scripts/analyze-takes.ts)
computing the real voice-to-voice distribution over takes. Live is the truth
the offline bench could only approximate — it can't see Twilio's own transit.
The measured ladder and the verdict live in
[docs/latency-results.md](../../docs/latency-results.md); each contender's
README records its own honest assessment. The spec files stay as the starting
point if a head-to-head offline bench is ever wanted.

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
