# Increment 2 — Speech contracts

What this increment locked in. Later increments rely on these without
re-checking; changing one is a flag to raise, not a silent edit.

Frozen 2026-07-15. Evidence: the offline suite (`@callbench/transcript`,
`@callbench/stt`, `@callbench/tts`, `@callbench/turn`) and two live round-trips
against the Modal endpoints.

## Status: contracts frozen, pipeline proven offline, live exchange pending a dial

The plan's literal "done when" is a *live* two-turn loopback exchange over
Twilio. That needs a maintainer-approved dial and has not run. Everything it
depends on is built, tested, and proven end-to-end against the real endpoints
and the real wire format — the live exchange is the integration proof, and it
lands with the simulator (Increment 3), which is the thing that answers.

## The transcript — the center (`@callbench/transcript`)

`Turn`, `Confidence`, `Transcript`, `FrozenTranscript`. Five invariants,
enforced not trusted (contract tests pin each):

- **append-only** — `append` is the only mutator and throws after `freeze`;
  `turns` returns a copy.
- **verbatim** — a turn stores what was said, never a summary.
- **one clock, one layer** — `startMs`/`endMs` are the transport session's
  `atMs`; `append` rejects out-of-order and inverted spans.
- **hashed + frozen** — `freeze` canonicalizes and SHA-256s the turns
  (idempotent). `hashTurns` is the shared definition the freeze and the
  refuse-on-mismatch check both use, so they cannot drift.
- **refuse on mismatch** — `verifyFrozen` is the report's publish gate.

A `Confidence` is `{ avgLogprob, noSpeechProb, minWordProb }`, null for a turn
the bench spoke. It travels WITH the turn, alongside a `provider` tag.

## STT (`@callbench/stt`)

`SttProvider`: `transcribe(audio, mediaType) → SttResult`. Batch, offline over a
frozen recording (docs/models.md § latency split). `SttResult` carries spans
with per-span `Confidence` and a `provider` tag.

**The load-bearing decision:** a span's confidence is its **weakest word's**
probability, not an average — a single mangled word (a digit string, a name,
"A3" vs "S3") is exactly what INCONCLUSIVE must catch, and an average smooths it
away. Mutation-verified: min→average fails the suite.

Adapter: `ModalWhisperStt` → the Modal faster-whisper endpoint
(`/v1/audio/transcriptions`). Tested via `mapWhisperResponse`, a pure function
over a response captured from the live endpoint.

## TTS (`@callbench/tts`)

`TtsProvider`: `synthesize(text, voice?) → Utterance` (8kHz PCM + provider).
`toMulawFrames` frames it into 160-byte (20ms) transport frames, reusing the
transport's `encodePcm` — **the wire format lives in one place**, verified
byte-identical to ffmpeg's G.711. `toMulawFrames` refuses a wrong sample rate
rather than play garbled; the tail is padded to a whole frame with mulaw
silence. Scripted lines are pre-rendered before a call.

Adapter: `ModalKokoroTts` → the Modal Kokoro-82M endpoint (`/v1/audio/speech`),
returning raw PCM16LE at the transport's 8kHz. Kokoro is Apache-2.0.

## Turn-taking (`@callbench/turn`)

`EnergyTurnDetector`: local, in the live 20ms path, never crosses the network.
Energy VAD with a hangover — `speech-start` at onset, `turn-end` after trailing
silence. **Named limitation:** a silence timer can't tell "finished" from
"paused mid-sentence"; references.md's smart-turn (reads the waveform, including
the filler words that mark an unfinished turn) is the upgrade, behind the same
shape. Adequate for a scripted exchange; the improvised persona (Increment 6) is
where the smarter detector earns its keep.

## Proven, measured (2026-07-15)

Two live round-trips through the real endpoints:

- **STT:** real 8kHz telephony audio → correct transcript, confidence
  meaningful (a novel word scored 0.54 where real words scored 0.99).
- **TTS → wire → STT:** synthesized speech → 237 mulaw frames (the exact wire
  bytes) → decoded → STT read it back. Our voice is reliably intelligible
  (weakest word ~0.88).

**A finding, not a bug:** the mulaw round-trip degraded "2009 Audi **A3**" to
"**S3**". The 8kHz telephony channel is lossy enough to confuse them — which is
exactly the disambiguation case probes.md Family 1 exists to test, surfacing in
our own pipeline. The confidence signal stayed ~0.88, so a scenario asserts on
this, it is not something the bench silently corrects.

## What is deliberately NOT done here

- The **live two-turn Twilio exchange** — pending an approved loopback dial;
  lands with the simulator (Increment 3).
- **Streaming TTS/STT** — the endpoints are batch (offline STT, pre-rendered
  TTS), which is correct for these stages. Streaming is for the live persona
  (Increment 6) per the prefer-streaming principle.
- **A second STT/TTS provider** — the seams exist so that is additive.
