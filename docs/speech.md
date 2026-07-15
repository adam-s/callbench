# Speech — hearing and being heard

The speech-to-text and synthesis survey, recorded so the next agent doesn't
re-run it. Sibling to [drivers.md](drivers.md): that file is how a call gets
*placed*, this one is how it gets *heard*.

**Decided, and frozen (Increment 2):** STT is faster-whisper on Modal, TTS is
Kokoro-82M on Modal, both deployed — see the "What was chosen" section below,
[models.md](models.md) for the hosting decision, and
[contracts/increment-02-speech.md](contracts/increment-02-speech.md) for the
frozen contracts. The survey below is the record of how that decision was
reached, kept so the next agent doesn't re-run it; the vendor figures are
published claims as of 2026-07-15, a starting point, not findings.

## The constraint that decides this

**The audio is narrowband telephony, not podcast audio.** The transport hands us
roughly 8kHz mulaw off the wire (a label to confirm by capture, per
[drivers.md](drivers.md)), single channel, with whatever the carrier did to it.
That single fact outranks every leaderboard, because the leaderboards are mostly
run on wideband speech.

The corollary is a trap worth naming: **the general-purpose default is the wrong
default here.** A model that wins on clean 16kHz audio can lose badly on a phone
call, and the published average will not tell you.

## Speech-to-text

Published figures, not measured by us. Word error rate is the vendor's or the
benchmark's claim.

| Option | Claimed WER | Why it might fit |
|---|---|---|
| Deepgram Nova-3 (phonecall) | ~6.8% streaming, ~5.3% batch | Purpose-built on contact-center audio — the standard pick for telephony |
| Deepgram Flux | — | Conversational STT with **integrated end-of-turn detection**; claimed median EOT <300ms, saving 200–600ms against an STT+VAD pipeline |
| AssemblyAI Universal-3 Pro | ~5.6% | Highest claimed accuracy of the hosted options; cloud-only |
| Whisper large-v3 | ~7.4% | The obvious default. **Weakest of these on 8kHz telephony** — see below |
| Voxtral Transcribe 2 | ~5.9% | Open weights, native streaming, 13 languages |
| NVIDIA Canary-Qwen 2.5B | ~5.6% | Top of the open ASR leaderboard; wideband benchmark |

**First measurement on our own wire audio (2026-07-15,
`scripts/evals/eval-stt.py`):** on an 8.22s real capture with a speaker-authored
reference, local whisper scored tiny 29%, base/small/medium all 14% WER — and
all four models unanimously misheard one word the speaker corrected. Small
sample, real direction: consistent with the published claim that whisper is
weak on 8kHz telephony. Re-run on longer captures before treating the numbers
as more than a direction; the eval folder under `data/evals/` carries the
provenance. Audio preprocessing to improve transcription is explicitly deferred
(maintainer decision, 2026-07-15) — out of scope until the bench's core loop
exists.

Three things to carry forward:

- **Whisper is the weakest of these on telephony — and it is what we run, on
  purpose.** The published comparisons put Deepgram Nova-3, AssemblyAI, and
  Speechmatics ahead of it on 8kHz audio with noise and overlap. We run
  faster-whisper on Modal anyway as the *first* transcriber, because it works
  today with no signup and the seam makes it swappable: if measured telephony
  WER on real target calls proves too poor, a Deepgram/AssemblyAI adapter is
  additive, not a rewrite. "The right first model" beats "the best model we
  haven't integrated."
- **End-of-turn detection may matter more than word error rate.** Knowing when
  the far end stopped talking is what makes a reply possible, and a naive
  silence timer is how a bench talks over people. A provider that solves this in
  the same pass is doing the harder half. Flux is the current instance of that
  idea; the idea outlives the instance.
- **The leaderboard gap has compressed to where it rarely decides anything.**
  What separates providers in production is performance on *your* audio —
  accents, overlap, noise, digit strings. Probe on Increment 1's captured frames
  and pick from that, not from this table.

### One measurement warning

If a provider emits an end-of-turn or speech-final event, **that event is not a
latency endpoint.** It is the provider's clock, at the provider's layer, arriving
after their buffering. Subtracting it from our wall clock produces a confidently
wrong number — the measurement principle in [AGENTS.md](../AGENTS.md). Use such
events to drive turn-taking; measure with stamps we take ourselves, at one layer.

## Text-to-speech

**The bench's voice is an input to the system under test.** Whatever we
synthesize gets transcribed by *their* speech-to-text. A voice that their stack
mishears turns every scenario into a test of our synthesis, and a finding
produced that way is about us, not them. Naturalness matters less than being
reliably heard; the probe is whether the target's flow behaves the same for a
synthesized caller as for a human one.

The constraint that decides it: **synthesis must emit streaming, headerless
mulaw at 8000 natively** — the transport's frame format (measured,
[drivers.md](drivers.md)). A provider that only outputs WAV or 16kHz forces a
resampling stage, which adds latency and one more place to be wrong.

Survey (searched 2026-07-15; vendor TTFB claims, not measured by us):

| option | claimed TTFB | native mulaw@8k | note |
|---|---|---|---|
| Deepgram Aura-2 | ~90ms | yes (`encoding=mulaw`, `sample_rate=8000`, no container) | has a Twilio-specific integration doc |
| ElevenLabs Flash v2.5 | ~75ms | check output formats | latency leader claim |
| Inworld Realtime TTS-2 | — | yes (8kHz MULAW/ALAW, PSTN-native) | tops the AA Realtime TTS Arena per vendor |
| Cartesia Sonic | — | streaming-first | telephony-positioned |

Sub-200ms TTFB is the widely-cited target for natural turn-taking.

## What was chosen — self-hosted on Modal

**Decided (2026-07-15): both directions run self-hosted on Modal, not a SaaS
signup.** A hosted vendor (Deepgram, which ingests our exact `mulaw@8000`
headerless bytes, was the near contender) was considered and set aside — the
maintainer holds Modal budget, and one hosting story for every model beats a
per-provider account. See [models.md](models.md) for the decision and the
seam; [infra/modal/](../infra/modal/) for the deployed endpoints.

What actually runs, both proven end to end:

- **STT: faster-whisper on Modal** (`infra/modal/stt.py`), OpenAI
  `/v1/audio/transcriptions`, returning the confidence the abstain path needs.
  whisper is the weakest of the surveyed models on telephony, and it is the
  right *first* model because it works and the seam makes it swappable — a
  Deepgram/AssemblyAI adapter is additive if measured WER demands it.
- **TTS: Kokoro-82M on Modal** (`infra/modal/tts.py`), Apache-2.0, OpenAI
  `/v1/audio/speech`, native 8kHz mulaw after resample. Proven intelligible
  back through STT (~0.88).
- **Turn detection** stays local in the 20ms path (energy VAD now,
  [references.md](references.md)'s smart-turn as the upgrade) — never a network
  round trip.

The STT/TTS contracts keep providers swappable, so this is a starting point,
not a lock-in.

## Our own transcription of our own recordings

Distinct from the call pipeline and worth keeping distinct.

For transcribing a recording we already hold, `whisper.cpp` with a local model
works, costs nothing, and needs no network. It is what produced the warm-up
call's transcript. That job has different requirements: no latency budget, no
streaming, no turn-taking, and a human reads the output.

**A transcript produced this way is reference material, not evidence**, and its
audio is not fixture material — a recording captured through a convenient path
(a room mic, a speakerphone) sounds nothing like the wire and would make a
fixture that tests the convenience. See the fixture rule in
[AGENTS.md](../AGENTS.md).

## Sources

Published 2026-07-15; claims are the vendors' and the benchmarks', not ours.

- [Coval — Best STT providers 2026: independent benchmarks](https://www.coval.ai/blog/best-speech-to-text-providers-in-2026-independent-benchmarks-and-how-to-choose/)
- [Deepgram — AssemblyAI vs Deepgram](https://deepgram.com/learn/assemblyai-vs-deepgram)
- [AssemblyAI — Top APIs and models for real-time speech recognition](https://www.assemblyai.com/blog/best-api-models-for-real-time-speech-recognition-and-transcription)
- [Northflank — Best open source STT model in 2026](https://northflank.com/blog/best-open-source-speech-to-text-stt-model-in-2026-benchmarks)
