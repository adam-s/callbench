# Contender: managed streaming APIs — Deepgram Flux + Cartesia Sonic

Least build effort, proven **~700ms–1.0s voice-to-voice** on managed cloud, and
both speak 8kHz mulaw natively so there is zero transcode against Twilio. A paid
per-minute dependency and a network hop off Modal. Sources inline.

## The recipe (from research, 2026-07-16)

**STT — Deepgram Flux** (turn-based conversational STT with built-in semantic
end-of-turn; replaces the old Nova + `endpointing` + `utterance_end_ms` stack):

```
wss://api.deepgram.com/v2/listen
  ?model=flux-general-en&encoding=mulaw&sample_rate=8000
  &eot_threshold=0.7&eager_eot_threshold=0.4
```
- Feed Twilio's mulaw frames straight in — **no transcode**. Deepgram recommends
  **80ms / 640-byte** chunks (Twilio's 20ms×4).
- **`eager_eot_threshold≈0.4`** is THE setting: on `EagerEndOfTurn` start the LLM
  immediately; `TurnResumed` cancels the draft; `EndOfTurn` (transcript
  guaranteed identical to the eager one) commits. Fires 150–250ms earlier than
  plain EoT, at 50–70% more LLM calls.
- Flux EoT is 200–600ms faster than pipeline VAD; sub-150ms semantic EoT.
  [flux/configuration](https://developers.deepgram.com/docs/flux/configuration),
  [voice-agent-eager-eot](https://developers.deepgram.com/docs/flux/voice-agent-eager-eot).

**TTS — Cartesia Sonic** (native telephony out):
```
wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-03-01
  model_id: sonic-3.5           (Turbo ~40ms TTFA; standard sub-90ms)
  output_format: { container: "raw", encoding: "pcm_mulaw", sample_rate: 8000 }
```
- Stream LLM text in as `continue:true` continuations sharing a `context_id`;
  `continue:false` on the last chunk. Keep `max_buffer_delay_ms` low.
  [Cartesia WS](https://docs.cartesia.ai/api-reference/tts/websocket).

**Connections:** keep BOTH sockets open persistently across turns — a per-turn
connect is 100–300ms of TLS you pay every turn. Pre-warm at call start, run
concurrently, pipe Flux eager-EoT → LLM stream → Cartesia continuation with no
intermediate buffering.

**Where the floor is:** a measured Pipecat/Modal/Twilio build (Deepgram + Groq
Llama-3.3-70B + Deepgram TTS) hit **1.048s** — STT TTFB 195ms, LLM TTFB 268ms,
TTS TTFB 23ms, turn detection 84ms, and **~480ms (46%) network/pipeline
overhead**. The dominant remaining terms are network + LLM TTFT + endpointing,
NOT STT/TTS. [fullstackml](https://www.fullstackml.dev/p/15-where-does-the-time-go-measuring).

## To run this contender
1. `.env`: `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, plus an LLM (the existing
   `claude:`/`openai:` runner, or Groq for lowest TTFT).
2. `adapter.ts` implements `TurnPipeline` over the two persistent sockets.

**Single most important setting: Flux `eager_eot_threshold≈0.4`** — it overlaps
LLM generation with the tail of speech, attacking endpointing wait and LLM TTFT
at once, worth more than any STT/TTS format tuning.
