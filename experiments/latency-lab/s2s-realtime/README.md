# Contender: end-to-end Speech-to-Speech — the realtime model IS the caller

Fewest moving parts and the lowest raw latency (**~200–500ms to first audio**),
because one model does audio-in → audio-out with no STT/LLM/TTS seams. Closed
API, not Modal. The catch for a TEST BENCH is real and is why this contender is
weighed, not assumed: the transcript is ASR-of-audio (approximate), and forcing
a verbatim probe line takes deliberate control. Sources inline.

## The recipe (from research, 2026-07-16)

**Primary — OpenAI Realtime (`gpt-realtime` GA):** native μ-law, zero transcode
against Twilio.
```
session.audio.input.format  = { type: "audio/pcmu" }   // 8kHz μ-law, native
session.audio.output.format = { type: "audio/pcmu" }
session.output_modalities   = ["audio"]
session.audio.input.turn_detection = { type: "server_vad",
    threshold: 0.5, silence_duration_ms: 200 }          // ← the latency lever
session.audio.input.transcription = { model: "whisper-1" }  // for the record
```
- Wiring: Twilio `media` → `input_audio_buffer.append(payload)`; model audio →
  `response.output_audio.delta` → back into the Twilio socket. On
  `input_audio_buffer.speech_started`, send `conversation.item.truncate` + flush
  Twilio playback (barge-in). GA rejects the old flat `input_audio_format` keys —
  use the nested `audio` object.
  [Twilio sample](https://github.com/twilio-samples/speech-assistant-openai-realtime-api-node),
  [GA audio format](https://community.openai.com/t/gpt-realtime-2-ga-api-what-is-the-correct-audio-format-for-g711-ulaw-twilio-telephony/1380750).
- **`silence_duration_ms≈200`** is the single biggest perceived-latency win
  (default ~500); `server_vad` beats `semantic_vad` for latency (semantic adds a
  variable 2–8s max wait). [VAD guide](https://developers.openai.com/api/docs/guides/realtime-vad).

**Alternative — Gemini Live** (`gemini-2.0-flash-live`): NO native μ-law — must
resample 8k↔16k in and 24k→8k out both directions. Dual
`input/output_audio_transcription`, `automatic_activity_detection` VAD. ~380ms
median. [Gemini+Twilio](https://dev.to/googleai/add-telephony-to-a-gemini-live-agent-with-twilio-1elc).

## The two bench-fit problems this contender must solve

1. **A gradeable transcript.** Enable `input_audio_transcription` and capture
   `conversation.item.input_audio_transcription.completed` (caller) and
   `response.output_audio_transcript.done` (model) per item → a per-turn text
   transcript alongside the frozen audio. **It is ASR-of-audio, not ground
   truth** — the bench treats it as approximate, and can re-transcribe the
   frozen wire audio offline with a high-accuracy STT for the graded record.
2. **A verbatim probe.** `response.create` with `instructions` only STEERS —
   the model paraphrases. The reliable path: pause auto-response
   (`turn_detection.create_response=false`), inject the exact line via
   `conversation.item.create` (an assistant item with literal `text`) + drive
   its audio, then resume. [realtime-conversations](https://developers.openai.com/api/docs/guides/realtime-conversations).

## To run this contender
1. `.env`: `OPENAI_API_KEY` (or `GEMINI_API_KEY`).
2. `adapter.ts` implements `TurnPipeline`; the S2S session replaces the whole
   STT+LLM+TTS stack, and the harness reads its transcription events for the
   `heardText`/`repliedText` timing fields.

**Biggest win:** native `audio/pcmu` end-to-end + tightened `silence_duration_ms`.
**Biggest bench constraint:** the transcript is approximate and verbatim probe
control needs `conversation.item.create`, not `instructions` — the reason a
test bench does not adopt S2S blindly.
