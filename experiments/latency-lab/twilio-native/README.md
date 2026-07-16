# Contender: Twilio-native text (Real-Time Transcription + Media Streams)

We are already on Twilio, so its own real-time text costs zero extra
integration. The honest research verdict: **viable and confidence-bearing, but a
hop — not a speedup.** Twilio forks the audio to the same Google/Deepgram
engines you could call directly, adds buffering, and delivers over an HTTP
callback rather than a socket. Kept as a contender because it uniquely pairs
fast text WITH raw audio WITH a per-turn confidence signal, all Twilio-native.
Sources inline.

## The recipe (from research, 2026-07-16)

**Real-Time Transcription** (`<Start><Transcription>`), run on the SAME outbound
call as `<Stream>` (both fit the 4-audio-fork budget), so the bench keeps frozen
wire audio from Media Streams AND gets Twilio's text:
```
<Transcription
  track="inbound_track"              // the agent's speech
  transcriptionEngine="deepgram"     // or google (default)
  speechModel="nova-3"               // deepgram; or telephony/chirp for google
  partialResults="true"
  enableProviderData="true"          // word-level timing + confidence
  statusCallbackUrl="https://.../transcription" />
```
- Events POST to `statusCallbackUrl` (HTTP, **not** a held-open WebSocket):
  `TranscriptionData` = `{transcript, confidence}`, `Final` (partial vs final),
  `Track`, `Timestamp`, `SequenceId`. Partials carry `stability` (0–1); finals
  carry **`confidence`** — directly usable for the abstain floor.
  [Transcription verb](https://www.twilio.com/docs/voice/twiml/transcription),
  [RTT resource](https://www.twilio.com/docs/voice/api/realtime-transcription-resource).
- **$0.027/min** ([public-beta changelog](https://www.twilio.com/en-us/changelog/realtime-transcriptions-is-public-beta)).

**ConversationRelay** (`<Connect><ConversationRelay>`) — Twilio does STT+TTS,
you send LLM text over WebSocket, and `{"type":"text","token":"<literal>"}` is
spoken **verbatim** (perfect probe control). But: the incoming `prompt` message
carries **NO confidence**, and raw-audio capture on a CR leg is undocumented.
**Rejected for the bench** — it strips the confidence signal the abstain logic
needs and the record's raw audio. [ConversationRelay](https://www.twilio.com/docs/voice/twiml/connect/conversationrelay).

## The latency truth

Twilio RTT is the same Google/Deepgram engine plus a fork+callback hop. Direct
Twilio→Deepgram: audio-to-final ~200–350ms; Deepgram direct P50 337–509ms, min
184ms; Gladia-direct over Media Streams: partials 100–150ms, finals <300ms.
Managed RTT adds Twilio's buffering on top, so it is **not faster** than running
STT directly off the Media Streams frames we already capture.
[Deepgram #1006](https://github.com/orgs/deepgram/discussions/1006),
[Deepgram latency](https://developers.deepgram.com/docs/measuring-streaming-latency),
[Gladia](https://www.gladia.io/blog/live-transcription-made-simple-with-twilio-python-gladia).

## Verdict for this bench
- **Biggest advantage:** one managed callback yields text WITH per-turn
  confidence while Media Streams independently preserves the raw wire audio —
  record and grade paths stay separate, both Twilio-native, no second STT to
  operate.
- **Biggest disadvantage:** a hop, not a speedup, delivered over HTTP callbacks
  (round-trip erodes the win). If turn-taking latency is the hard constraint,
  run Deepgram Flux directly off the Media Streams frames (the
  [managed contender](../managed-deepgram-cartesia/)) instead.

Include it in the live measurement for the confidence signal and the zero-extra-
integration baseline; do not expect it to win on latency.
