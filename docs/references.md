# References — prior art, per concept

For every concept this project implements, the best example found and what to
take from it. Assembled 2026-07-15 from vendor docs, GitHub, and published
research.

**Read this before building any seam.** Most of what callbench needs has been
solved in public, some of it by research labs, some of it better than we would
have. The rule that follows from that: *look here first, and prefer taking the
solved thing over re-deriving it.*

**Rows are claims with dates, not facts.** Everything below is somebody else's
documentation or code, not something we measured. Where this file and a probe
disagree, the probe wins and this file is the bug — see the probe-before-building
rule in [AGENTS.md](../AGENTS.md).

---

## Transport — Twilio Media Streams

**Primary source:** [WebSocket messages reference](https://www.twilio.com/docs/voice/media-streams/websocket-messages)

The message schema, per Twilio's docs (to be confirmed against a capture; see
[drivers.md](drivers.md)):

| Event | Direction | Carries |
|---|---|---|
| `connected` | in | protocol, version. First message. |
| `start` | in | `streamSid`, `callSid`, `tracks`, `customParameters`, and **`mediaFormat`** |
| `media` | both | base64 payload, `track`, `chunk`, `timestamp` |
| `stop` | in | stream ended |
| `dtmf` | in | keypad digits (bidirectional streams only) |
| `mark` | both | playback checkpoint (bidirectional only) |
| `clear` | out | flush buffered audio |

`mediaFormat` is documented as `{encoding: "audio/x-mulaw", sampleRate: 8000,
channels: 1}` — which is where the 8kHz-mulaw claim in
[drivers.md](drivers.md) comes from. **It is documentation, not a measurement**,
and `scripts/probes/probe-media-stream.ts` exists to settle it against this account.

Three details that shape the design:

- **Outbound audio must be base64 mulaw at 8000, with no file-type header
  bytes.** Synthesis has to emit raw frames, not a WAV.
- **`mark` tells you when your audio finished playing.** That is the only honest
  signal that the bench has stopped talking; a local timer is a guess about
  someone else's buffer.
- **`clear` flushes buffered audio.** This is the barge-in primitive, provided.
  Do not build an interruption mechanism before using this one.

**Error 31920** = stream WebSocket handshake failure. Measured here: it is what
Twilio raises when it cannot reach the stream URL, and the call ends in ~1s.

**Worked examples**, in the order worth reading:

- [twilio-samples/speech-assistant-openai-realtime-api-node](https://github.com/twilio-samples/speech-assistant-openai-realtime-api-node)
  — the canonical Node one. Closest to our stack.
- [twilio/media-streams](https://github.com/twilio/media-streams) — Twilio's own
  quick-starts across languages.
- [twilio-labs/call-gpt](https://github.com/twilio-labs/call-gpt) — a fuller
  toolkit; useful for how it structures the media loop.
- [Pipecat's Twilio integration](https://docs.pipecat.ai/pipecat/telephony/twilio-websockets)
  — the production-grade version.

## Local development tunnel

Twilio must reach the local WebSocket server, so a tunnel is required for every
increment before deployment. Both ngrok and Cloudflare Tunnel are the documented
options.

**Measured here, 2026-07-15 — a cloudflared quick tunnel prints its public URL
before the edge will route to it.** Observed once at ~24s of HTTP 530, and once
never resolving in DNS within 24s. Dialing on the printed URL cost a real call:
Twilio's handshake hit the un-routed hostname, raised 31920, and the call died at
1 second. `scripts/probes/probe-media-stream.ts` therefore verifies the tunnel carries a
WebSocket *before* it spends a ring on a phone.

Known trouble, worth reading before blaming your own code:
[livekit/agents#3379](https://github.com/livekit/agents/issues/3379) — "WebSocket
connects but silently drops all media packets with ngrok." Closed *not planned*,
no root cause identified. The lesson is not the fix; it is that this layer fails
in ways that look like your bug.

## Turn detection and barge-in

**The find:** [pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn)
— open-source semantic VAD, BSD-2, weights on Hugging Face
([v2](https://huggingface.co/pipecat-ai/smart-turn-v2),
[v3](https://huggingface.co/pipecat-ai/smart-turn-v3)).

Why it matters more than its size suggests: **it reads the raw waveform, not the
transcript**, and it is explicitly trained on filler words — "um", "hmm" — that
transcription models discard. Those fillers are precisely the signal that a
speaker has *not* finished. A turn detector built on transcripts cannot see them,
which is why silence-timer turn-taking talks over people. v2 is 360MB with ~12ms
inference; it outputs one probability, ≥0.5 meaning the utterance is complete.

Alternative, if the STT provider bundles it: Deepgram Flux claims integrated
end-of-turn with median <300ms ([speech.md](speech.md)).

Barge-in itself is Twilio's `clear` message plus `mark` for tracking — see the
transport section. Pipecat's [speech input & turn detection
docs](https://docs.pipecat.ai/pipecat/learn/speech-input) are the best writeup of
how the pieces fit.

**Measurement caution:** a turn-detector's or provider's event is *their* clock at
*their* layer. Use it to decide when to speak; never subtract it from our wall
clock and call the result latency ([AGENTS.md](../AGENTS.md)).

## Voice-agent testing — the closest prior art

**[ServiceNow/eva](https://github.com/ServiceNow/eva)** — "EVA-Bench: A New
End-to-end Framework for Evaluating Voice Agents", paper at
[arXiv 2605.13841](https://arxiv.org/pdf/2605.13841).

This is the same problem, solved by a research lab, and it independently arrives
at most of our architecture. Read the paper before Increment 3.

What it does, and what it confirms:

| EVA | Our name for it |
|---|---|
| Bot-to-bot audio, no human listeners, no text replays | The hybrid tester driving a real call |
| **Tool Executor** — deterministic, reproducible tool responses | The **simulator** |
| **Validators** — automated checks that the conversation was complete before scoring | The **INCONCLUSIVE** gate |
| Metrics engine over audio + transcript + tool logs | Assertions over the frozen artifact |
| LLM judges, plural | The **judge** stage |

Two things EVA has that we don't, and should consider:

- **An audio judge, not only a transcript judge.** EVA judges audio directly
  (Gemini) alongside text metrics (GPT-5.2) and faithfulness (Claude). Dead air,
  talkover, and tone are audible and *not* in a transcript — our Family 3 dead-air
  probe is currently a waveform inspection, and an audio judge is the general
  form of it.
- **Two scoring axes: EVA-A (accuracy — task completion, speech fidelity,
  faithfulness) and EVA-X (experience — turn-taking, conciseness, progression,
  latency).** Cleaner than one flat list, and it maps onto
  [probes.md](probes.md)'s families.

Its scenario dimensions — Single-Intent, Multi-Intent, **Adversarial** — line up
with our probe families, and the adversarial axis is our Family 4.

**Others worth knowing:**

- [saharmor/voice-lab](https://github.com/saharmor/voice-lab) — agents ×
  personas × scenarios as a matrix.
- [future-agi/simulate-sdk](https://github.com/future-agi/simulate-sdk) —
  persona-driven scenarios, hands transcripts + audio to a scoring pillar.
  Same record/assert split we drew.
- [langwatch/scenario](https://github.com/langwatch/scenario) — agentic testing
  with custom assertions and judging at any point in a conversation; the
  closest thing to our `describe()/it()` intent.
- Commercial category, for knowing why we build rather than buy: Hamming, Coval,
  Cekura. Hamming's [QA framework](https://hamming.ai/resources/guide-to-ai-voice-agents-quality-assurance)
  publishes useful targets — P95 latency <800ms, >95% intent accuracy, >90%
  interruption recovery.

## The LLM judge

**Best conceptual writeup:** [Braintrust — what is an LLM-as-a-judge, and when to
use deterministic evals instead](https://www.braintrust.dev/articles/what-is-llm-as-a-judge).
The title is the lesson: prefer code, reach for a judge only where the question
is irreducibly semantic. Also
[Patronus — LLM as a judge](https://www.patronus.ai/llm-testing/llm-as-a-judge).

**The standard determinism advice does not work here, and that is load-bearing.**
Every source says the same thing: pin `temperature = 0`, `top_p = 1` for
reproducible judging. Our judge model exposes none of those — they are removed
and return a 400 ([speech.md](speech.md) is the STT sibling; the API constraint
is in [architecture.md](architecture.md)). Published caveats note that judges are
non-deterministic anyway, and that paraphrasing or reordering flips verdicts.

So freezing the verdict is not our optimization; it is the only mechanism
available. Which the caching literature independently endorses:
[semantic caching guidance](https://www.truefoundry.com/blog/semantic-caching-llm-gateway)
says to hash **model name, temperature, prior messages, system prompt, and tenant
id exactly** — a near-exact description of the cache key in
[architecture.md](architecture.md), arrived at separately.

Related research: [Reference-Guided Verdict — LLMs-as-Judges for free-form
QA](https://arxiv.org/pdf/2408.09235) (giving the judge a reference answer, which
is what a rubric does).

## Speech

Provider survey, benchmarks, and the 8kHz-telephony finding live in
[speech.md](speech.md) rather than here.

## Web Audio and the visualization

**Best example is in this repo's own neighborhood:** `~/Projects/separate` —
Svelte 5 + Web Audio, by the maintainer. One `AudioContext` and one
`AnalyserNode` reused across clips, a single rAF loop driving a reactive playhead
so visuals cannot drift apart, a wall-clock fallback for when audio never starts,
an exclusive-audio bus, and `playRegion(start, end)` — which is the
click-a-finding-hear-the-span gesture, already written. See [ui.md](ui.md).

Take the engine; don't rewrite it. The gaps are that it has no router and renders
fixed clips rather than a growing artifact directory.

---

## What to read before which increment

| Increment | Read first |
|---|---|
| 1 — transport | Twilio WebSocket messages reference; twilio-samples Node example |
| 2 — speech | [speech.md](speech.md); smart-turn; Pipecat speech-input docs |
| 3 — simulator | EVA paper (its Tool Executor and Validators) |
| 4 — assertions + judge | Braintrust judge article; EVA's two axes; semantic-caching guidance |
| 5 — web | `~/Projects/separate`; [ui.md](ui.md) |
| 6 — hybrid tester | EVA's user-simulator design |
