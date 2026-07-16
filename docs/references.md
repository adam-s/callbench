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

**Outbound pacing — two failure modes, and a correction to the error number,
found re-reading Twilio's error docs verbatim and cross-checking three
production implementations (2026-07-15):**

- **[Error 31930](https://www.twilio.com/docs/api/errors/31930) is the wrong
  number for outbound overflow — it is the INBOUND direction.** Verbatim:
  "Twilio raises this warning when a Media Stream is sending call audio *to
  your WebSocket server* and the WebSocket upstream becomes congested." That
  is Twilio → bench (caller audio arriving), gated by the bench's own receive
  handling and network path, not by how the bench paces its own `media` sends.
  The previous entry here cited 31930 for outbound congestion; that was wrong,
  corrected in place rather than left standing (AGENTS.md: a superseded claim
  gets banners or removal, not a second entry beside it).
- **[Error 31931](https://www.twilio.com/docs/api/errors/31931) — Stream
  Media Discarded — is the real outbound trigger.** Verbatim: "Twilio sends
  this warning once per Stream when audio sent to a bidirectional Media
  Stream is discarded because the downstream buffer has overflowed. Twilio
  buffers outbound `media` messages and plays them in the order received. If
  buffered audio grows beyond **10 minutes**, Twilio stops accepting more
  audio for that Stream." Its three documented causes: sending `media` faster
  than playback, more than 10 minutes buffered, or queueing without ever
  tracking playback via `mark`. Twilio's own four remediations, verbatim:
  pace outbound `media` so the buffer can drain; send a `mark` after each
  `media` and wait for it before sending more; send `clear` to interrupt
  queued audio; use a unidirectional Stream if you never need to send audio
  at all.
- **The 10-minute bound reframes the size question.** [Media Streams -
  WebSocket
  Messages](https://www.twilio.com/docs/voice/media-streams/websocket-messages)
  states outbound `media` payload "can be of any size" and that messages are
  simply "buffered and played in the order received" — there is no documented
  per-message size cap, and 31931 fires on *sustained* over-real-time sending
  or a 10-minute backlog, not on one large message. A single scripted
  utterance (seconds, not minutes) sent as one `media` message is far short of
  that ceiling by duration alone. The risk 31931 actually describes is a
  session that keeps sending faster than real time across many turns without
  ever pacing or waiting on `mark` — cumulative, not single-shot. Whether one
  huge WebSocket text frame (a multi-second utterance base64'd into one JSON
  message, as `sendAudio` does today per session.ts:289) has some other
  ingestion cost — fragmentation, parse latency, a delay before Twilio starts
  playback — is not documented either way and stays an **open question for a
  probe**, not an assumption.
- **[twilio/media-streams#72](https://github.com/twilio/media-streams/issues/72)**
  — the opposite failure, a 400 "Audio Timeout Error: Long duration elapsed
  without audio. Audio should be sent close to real time," raised when a
  service pauses mid-stream. Re-checked: the thread as fetched has no
  maintainer reply or resolution — the only evidence is the error string
  itself, which is corroborating, not additional detail. Treat it as
  confirmation the error exists, not a source for its exact threshold.
- Together 31931 and #72 still bound outbound pacing from both sides: don't
  sustain faster-than-real-time sending, don't stall. `mark` (above) remains
  the only honest completion signal regardless of pacing shape.

**What real Twilio Media Streams implementations actually do — and they
disagree, found reading source rather than docs (2026-07-15):**

Three production codebases, three different answers to "does anything pace
outbound `media` messages onto the wire":

- **No pacer at all.**
  [twilio-samples/speech-assistant-openai-realtime-api-node](https://github.com/twilio-samples/speech-assistant-openai-realtime-api-node)
  (`index.js`, the `response.output_audio.delta` handler) forwards every
  OpenAI Realtime audio delta straight to `connection.send()` the instant it
  arrives — no buffering, no timer, no chunk-size logic. It works because the
  upstream (OpenAI's realtime audio stream) already emits deltas at roughly
  generation pace, and Twilio's own buffering absorbs the rest.
  [vocodedev/vocode-core](https://github.com/vocodedev/vocode-core)'s
  `TwilioOutputDevice` (`vocode/streaming/output_device/twilio_output_device.py`)
  is the same shape: `_send_twilio_messages()` is a bare `while True: await
  queue.get(); await ws.send_text(...)` loop with no sleep. Pacing, in both,
  is inherited from whatever produced the chunk — an LLM or a streaming TTS
  emitting audio incrementally — not asserted by the transport.
- **An explicit drift-correcting pacer.** Pipecat's generic WebSocket output
  transport — not Twilio-specific, shared by
  `src/pipecat/transports/websocket/{fastapi,server,client}.py` — buffers
  outgoing PCM into fixed chunks (`audio_out_10ms_chunks`, default 4 → 40ms,
  `base_output.py:135`) and paces them with `_write_audio_sleep()`
  (`fastapi.py:588-597`): it tracks an absolute `_next_send_time` on
  `time.monotonic()`, sleeps `max(0, next_send_time - now)`, and advances the
  target by a fixed `_send_interval` rather than re-arming a relative sleep
  each iteration — the classic drift-correction shape (accumulating error
  from per-iteration overhead cannot compound, because the target line is
  absolute, not relative-to-last-fire). The comment at `fastapi.py:428-432`
  states the reason plainly: `write_audio_frame()` "is called quickly, as
  soon as we get audio (e.g. from the TTS)... since this is just a network
  connection we would be sending it too quickly. Instead, we want to block to
  emulate an audio device." `_send_interval = (audio_chunk_size /
  sample_rate) / 2` — **half** the chunk's real-time duration, i.e. the pacer
  deliberately runs at 2x real time, biasing toward keeping Twilio's buffer
  topped up (avoiding #72's stall) over strict real-time matching, which
  31931's 10-minute cushion makes cheap.
- **The disagreement is not a coin flip for this project — it tracks a
  structural fact already decided here.** twilio-samples and vocode can skip
  pacing because their audio source is itself a live, incrementally-generating
  stream (a realtime LLM, a streaming TTS) that naturally rate-limits how fast
  chunks become available. `packages/tts/src/tts.ts` synthesizes the whole
  utterance **before** the call and hands `sendAudio` a complete batch of
  bytes with no natural pacing at all — structurally the same shape pipecat's
  comment describes ("called quickly, as soon as we get audio"), not the
  twilio-samples/vocode shape. That argues for adopting pipecat's pattern (an
  explicit, absolute-target drift-correcting pacer inside the adapter) over
  the no-pacer approach, on architectural grounds already fixed by the
  batch-synthesis decision — not something a probe needs to re-decide. What a
  probe *should* still settle: the right chunk size and target rate for this
  codebase's frame size (160B/20ms, fixed by `frames.ts`/`tts.ts`, not
  pipecat's 40ms default) and whether 1x or 2x real time is warranted here
  given callbench's calls are short (a scripted two-turn exchange, not an
  open-ended session) — pipecat's 2x choice is tuned for long-running agent
  calls where #72-style stalls under real generation jitter are the bigger
  risk; that tradeoff may not transfer as-is.
- **Twilio's own node quickstarts don't help here.** The `node/` directory of
  [twilio/media-streams](https://github.com/twilio/media-streams) (`basic`,
  `connect-basic`, `realtime-transcriptions`, `keyword-detection`,
  `dialogflow-integration`, `amazon-transcribe-integration`) is entirely
  inbound-consumption quickstarts; none sends outbound `media`, so none
  demonstrates pacing either way.

**Timer accuracy for a ~20ms cadence in Node, found via the Web Audio timing
literature and pipecat's concrete implementation (2026-07-15):**

- **The canonical writeup is not Node-specific but the fix transfers exactly.**
  [web.dev — A tale of two clocks](https://web.dev/articles/audio-scheduling)
  describes the lookahead-timer pattern for `setTimeout`/`setInterval` drift:
  a coarse timer fires more often than the schedule needs, and each firing
  schedules everything due in the near future against an absolute target
  time — never a chain of relative `sleep(interval)` calls, which accumulates
  the overhead of every intervening tick. Pipecat's `_write_audio_sleep()`
  (above) is this same idea in its simplest single-step form: `next_send_time
  += interval` on time, `next_send_time = now + interval` only when catching
  up from behind. That shape — an absolute monotonic target, not a relative
  re-arm — is what a Node pacer should port, using `performance.now()` to
  match the clock this codebase's contract already mandates
  (`contract.ts`'s `atMs` rule) rather than introducing a second clock source.
- **`setInterval` drift under load is documented, not assumed.**
  [nodejs/node#21822](https://github.com/nodejs/node/issues/21822) — "setInterval
  keeps drifting over time" — confirms the failure mode motivating the
  lookahead pattern. The `correcting-interval` npm package packages the same
  absolute-target correction pipecat hand-rolls; either a small hand-rolled
  scheduler or that package is lighter than a full lookahead multi-frame
  buffer, and the "default to the lighter thing" rule favors the hand-rolled
  single-step version given callbench's frames are pre-computed (no
  synthesis-side jitter to smooth over, unlike pipecat's live-TTS case).
- **This interacts with an existing measurement fact, not just an
  implementation choice.** `session.ts` stamps `atMs` at the top of the
  socket-message *handler*, so inbound timing already folds in event-loop
  contention (per the contract's clock rule). A busy-wait or a tight
  zero-delay loop in the pacer would compete for the same event loop and
  worsen exactly the jitter that stamping-in-the-handler already inherits —
  another argument for a real `setTimeout`-based scheduler (which yields the
  loop between ticks) over a spin-loop.

**`clear` and `mark` interaction with a paced, multi-message send — verified
against the vendor doc's exact wording and confirmed by two independent
production implementations (2026-07-15):**

- **`clear` resolves outstanding local `mark`s, documented verbatim, not
  inferred.** [Media Streams - WebSocket
  Messages](https://www.twilio.com/docs/voice/media-streams/websocket-messages):
  "If your server sends a clear message, Twilio empties the audio buffer and
  sends back `mark` messages matching any remaining `mark` messages from your
  server." So `clear` does two things atomically from the caller's view:
  drops whatever Twilio had buffered server-side, and immediately fires the
  `mark` events that audio would otherwise have earned on natural playout —
  the app is never left waiting on a `mark` that a `clear` made unreachable.
  What `clear` does **not** do is touch anything still sitting in the
  adapter's own local queue (frames generated but not yet written to the
  socket) — that is the app's responsibility. Both pipecat
  (`process_frame`'s `InterruptionFrame` handler, `fastapi.py`, clears
  `_audio_send_buffer` and resets `_next_send_time = 0` so pacing doesn't
  burst-catch-up afterward) and vocode (`TwilioOutputDevice.consume_nonblocking`
  checks `item.is_interrupted()` before a chunk is ever sent) drop
  locally-queued-but-unsent frames explicitly and separately from sending
  `clear`. A pacer that queues frames locally before pacing them out inherits
  this same split responsibility: sending `clear` is not enough on its own,
  the local queue has to be dropped too.
- **`mark` fires per-chunk, in send order, not only after the whole
  utterance — confirmed by usage pattern in two codebases, not stated as a
  guarantee anywhere in Twilio's docs.** Twilio's doc says only "Twilio sends
  back a `mark` event with a matching `name` when the audio ends (or if there
  is no audio buffered)" — silent on ordering when multiple `media` messages
  and multiple `mark`s interleave. Both real implementations rely on FIFO
  ordering anyway: twilio-samples' `index.js` sends one `mark` named
  `'responsePart'` after *every* delta and tracks completion with a plain
  array (`markQueue.shift()` on each incoming `mark`); vocode's
  `_process_mark_messages` goes further and asserts it — a code comment reads
  "mark messages are tagged with the chunk ID that is attached to the audio
  chunk but they are guaranteed to come in the same order as the audio
  chunks, and we don't need to build resilience there," backed by an explicit
  `if mark_message.chunk_id != str(audio_chunk.chunk_id): logger.error(...)`
  check. Two independent teams built on FIFO mark/chunk correspondence and
  neither reports it breaking, but this is inference from production
  behavior, not a documented Twilio guarantee — **stays labelled as an
  assumption a probe should confirm** if the bench ever needs to correlate a
  specific mid-utterance `mark` back to an exact audio span (e.g. to measure
  exactly how much of an utterance played before a barge-in), rather than
  using `mark` only as an utterance-level completion signal the way the
  existing entry above already treats it.

**Recommendation this research settles vs. leaves open:**

- **A pacer is justified, not just permitted** — Twilio's own remediation for
  31931 explicitly recommends pacing ("pace outbound `media` messages so the
  buffer can drain") and `mark`-gated sending, which is vendor guidance, not
  an unmeasured assumption; combined with the structural argument above
  (batch-synthesized utterances have no natural pacing source the way a
  streaming TTS would), the lighter-thing default is overridden by the
  vendor's own documented recommendation plus this project's own already-made
  batch-TTS choice — both concrete, not speculative.
- **Its lightest defensible shape**, given what was found here: chunk at the
  existing 160-byte/20ms frame (`frames.ts`'s `BYTES_PER_FRAME`, already
  produced by `toMulawFrames`) rather than introducing a second chunk size;
  pace with an absolute-monotonic-target scheduler in the pipecat shape
  (`performance.now()`-anchored, `setTimeout` between ticks, never a
  spin-loop); drop the local queue and stop the scheduler on `clearAudio()`
  before forwarding Twilio's `clear` message, mirroring pipecat/vocode's
  split responsibility above.
- **Left for a probe, not decided here:** whether 1x or a faster-than-real-time
  rate is warranted for callbench's short scripted exchanges (pipecat's 2x is
  tuned for long-running agent sessions); whether a single huge unpaced
  `media` message has any ingestion cost beyond the documented 10-minute
  buffer bound; and whether `mark`-to-chunk FIFO correspondence holds against
  this project's own Twilio account the way it does in the two codebases
  cited above.

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

**A specific footgun for this stack: smart-turn silently breaks at 8kHz.**
[pipecat-ai/pipecat#3844](https://github.com/pipecat-ai/pipecat/issues/3844) —
Smart Turn v3's feature extractor hardcodes a 16kHz sample rate with no
internal resample and no error. Fed 8kHz audio, it reads the waveform at 2x
speed with shifted pitch and misclassifies turns with no warning — the
symptom is aggressive, wrong turn-end predictions, not a crash. This project's
frame format is measured 8kHz mulaw ([drivers.md](drivers.md)); if smart-turn
is adopted, it needs its own resample to 16kHz before inference, never the
wire rate. A silent wrong answer is worse than the crash it doesn't raise —
this is a probe-first candidate, not a wire-it-up-and-trust-it one.

**What ships before smart-turn.** LiveKit's [turn-detection
writeup](https://livekit.com/blog/turn-detection-voice-agents-vad-endpointing-model-based-detection)
recommends STT endpointing — the transcriber's own end-of-utterance event, not
a raw VAD silence timer — as the production default, with model-based
detection (a classifier reading the partial transcript) as the next step up
for latency, not the starting point. A pure VAD timeout of ~800ms adds nearly
a second to every reply — a concrete number for the naive-silence-timer
ambush this increment's plan entry names. The academic side agrees on the
ordering: ["Turn-Taking Modelling in Conversational Systems: A Review of
Recent Advances"](https://www.mdpi.com/2227-7080/13/12/591) (MDPI, Dec 2025)
frames VAD + inter-pausal-unit silence as the baseline every more
sophisticated method is measured against, and cites human turn-transition
latency at ~239ms in English conversation — the figure any bench-side timeout
is competing with, not zero.

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

## Scoped-claim classification — negation, abstention, and the fabrication-bait assertion

Researched 2026-07-15 against a concrete failure: `noFabricatedRecalibration`
(`packages/assert/src/assertions.ts`) has failed three keyword-matching fix
rounds, each pinning phrasings its author imagined, and still reports two
verified false FAILs — "Only the cars with the forward camera need the
recalibration. Yours is $265." and "If yours had the camera you'd have to add
the $220 recalibration. It doesn't." — both correct declines. The diagnosis in
the code comments is scope/coreference resolution, not vocabulary coverage.
This section asks what the ML/NLP literature says about that specific failure
mode, before anyone builds a fix on top of it.

**1. NLI framing — the right shape, not a solved problem for this exact case.**
Premise/hypothesis pairs scored entailment/contradiction/neutral is the
standard task shape (SNLI, MultiNLI), and mapping those three labels to
FAIL/PASS/INCONCLUSIVE is a direct fit for the three-state outcome AGENTS.md
already requires. **VERIFIED** —
[cross-encoder/nli-deberta-v3-base](https://huggingface.co/cross-encoder/nli-deberta-v3-base)
(model card, fetched): 0.2B params, Apache-2.0, trained on SNLI + MultiNLI,
produces exactly the three scores, 92.38% SNLI / 90.04% MNLI-mismatched
accuracy — standard leaderboard numbers, not negation-specific ones.
[MoritzLaurer/deberta-v3-large-zeroshot-v2.0](https://huggingface.co/MoritzLaurer/deberta-v3-large-zeroshot-v2.0)
(model card, fetched): 0.4B params, MIT license on the foundation weights
(training-data licenses vary by the `-c`/non-`-c` variant), trained on MNLI +
FEVER-NLI + synthetic Mixtral-8x7B data (plus ANLI/WANLI/LingNLI for the
non-`-c` variant), 0.676 f1_macro across 28 zero-shot datasets vs. 0.497 for
`facebook/bart-large-mnli`. The card states plainly it "can only do text
classification tasks" and degrades past ~400 words / 512 tokens. **The card is
silent on negation or scope** — silence is not a passed test, and every source
below says this is exactly where general-purpose NLI models are weakest:

- [Naik et al., "Stress Test Evaluation for Natural Language Inference" (ACL
  2018)](https://aclanthology.org/C18-1198.pdf) — a dedicated negation stress
  test found models over-predict CONTRADICTION whenever a strong negation word
  ("no", "not") appears, independent of what it actually scopes over. This is
  the literal shape of callbench's bug: a decline that says "no forward
  camera" contains "no" and "camera" in the same clause a fabrication would,
  and a model keyed on negation-word-presence rather than negation-scope
  cannot tell them apart.
- [McCoy, Pavlick, Linzen, "HANS" (ACL 2019)](https://arxiv.org/abs/1902.01007)
  — NLI models widely exploit lexical-overlap/subsequence/constituent
  heuristics instead of resolving structure; a diagnostic set built to violate
  those heuristics collapses their accuracy toward chance.
- [She et al., "ScoNe: Benchmarking Negation Reasoning in Language Models"
  (arXiv 2305.19426)](https://arxiv.org/abs/2305.19426) — **VERIFIED via
  fetch.** Built expressly for callbench's failure mode: contrast sets with up
  to two negations where zero, one, or both morphemes flip the label.
  Off-the-shelf RoBERTa/DeBERTa only "solve" ScoNe-NLI after **many-shot**
  fine-tuning on ScoNe itself — few-shot is not reported as sufficient.
  Zero/few-shot prompting of InstructGPT, including chain-of-thought, mostly
  fails on the NLI-shaped version of the same phenomenon, though the same
  model does better on a narrative-completion reframing — the scope-tracking
  capability exists somewhere in the base model but does not reliably surface
  through an NLI prompt.
- [Asher & Bhar, "Strong hallucinations from negation and how to fix them"
  (ACL Findings 2024, arXiv 2402.10543)](https://arxiv.org/abs/2402.10543) —
  **VERIFIED via fetch.** Names "strong hallucinations" (logically impossible
  outputs) that trace to models representing negation as ordinary content
  instead of an operator that constrains representations; the fix is
  structural (how negation is represented), not more negative training
  examples — evidence that this is a modeling-architecture gap, not a
  data-volume gap closeable by fine-tuning alone.
- [Gururangan et al., "Annotation Artifacts in Natural Language Inference
  Data" (2018)](https://www.semanticscholar.org/paper/2997b26ffb8c291ce478bd8a6e47979d5a55c466)
  — the mechanism, named directly: in SNLI, "negation words like *nobody* and
  *no* are strong predictors of CONTRADICTION" on their own, independent of
  the premise — a hypothesis-only classifier recovers 67% accuracy on SNLI
  from the hypothesis alone. This is published confirmation that mainstream
  NLI training data teaches exactly the shortcut callbench's regex-based
  assertion already fell into by hand: *negation word present → adverse
  label*, without resolving what the negation governs.

**Honest reading:** NLI is the correct standard framing for a premise/claim
scoring task, but the literature is unanimous and repeated across seven years
(2018 Gururangan/Naik → 2019 HANS → 2023 ScoNe → 2024 Asher & Bhar) that
general-purpose NLI models learn "negation word present" as a shortcut for
"contradiction," which is functionally the same bug the hand-rolled regex
classifier has now failed three times to fix. Swapping the regex for an
off-the-shelf NLI cross-encoder is not a verified fix for this exact failure —
it trades a debuggable, inspectable bug for the same bug wearing weights, with
worse traceability when it recurs. Any NLI deployment for this assertion
should be treated as unproven on scoped negation until checked against
ScoNe-shaped cases from *this* domain, not assumed fixed by the architecture
swap.

**2. Determinism.** A fixed-weight classifier's greedy argmax-over-three-logits
is deterministic in principle — no temperature, no sampling — but GPU
inference determinism is a real, cited caveat, not a given. **VERIFIED (search
synthesis):**
["Impacts of floating-point non-associativity on reproducibility for HPC and
deep learning" (arXiv 2408.05148)](https://arxiv.org/pdf/2408.05148) — cuDNN
and cuBLAS select kernel implementations via runtime heuristics, and
floating-point addition is non-associative, so atomic-reduction order can
change the bit-exact output run to run on GPU even at fixed weights; this
is a documented phenomenon, not speculation. PyTorch ships
`torch.use_deterministic_algorithms(True)` plus `cudnn.deterministic`/
`cudnn.benchmark=False` as the standard mitigation (name and existence of the
flags is common PyTorch-ecosystem knowledge; the exact current-version
documentation page did not load cleanly during this research and its precise
current wording is an **open question for a probe** before depending on it —
same "don't take documentation on faith" rule this file states at the top).
CPU inference is the more deterministic path if determinism has to be
guaranteed rather than merely likely — worth weighing against CPU's latency
cost for an offline, batch-scored stage where latency is already free
([models.md](models.md)'s judge row).

Compared to the LLM judge (`packages/judge/src/judge.ts`): the judge has no
temperature knob at all and is non-deterministic by construction, which is why
it is frozen by content-hash cache rather than re-run
(`judge.ts`'s `cacheKey`). A small fixed-weight NLI classifier is a strictly
better determinism story — same-weights-same-input is deterministic modulo the
GPU caveat above, which is closeable (deterministic-algorithms flag, or CPU)
in a way that an autoregressive judge's sampling is not. **What the cache key
must carry to make an NLI verdict replayable, by direct analogy to
`cacheKey()`'s existing shape:** the judged text, the criterion/rubric
version, and — new, because this is what `cacheKey`'s `runner` field does not
capture for a classifier — the exact model weights identity. **VERIFIED**: the
Hugging Face Hub versions every model repo with git, and pinning
`revision=<commit-sha>` in `from_pretrained()` is the documented mechanism for
reproducible loads (general HF docs and third-party pinning guidance,
[huggingface.co/docs/transformers/model_sharing](https://huggingface.co/docs/transformers/model_sharing);
[baseten — pinning ML model revisions](https://www.baseten.co/blog/pinning-ml-model-revisions-for-compatibility-and-security/)).
So the cache key for a classifier stage needs, minimum: judged text +
criterion version + model repo id + pinned revision/commit SHA + tokenizer
version (a tokenizer update can retokenize the same string differently) +
whether deterministic-algorithms mode was on. A verdict cached without the
revision pinned is not reproducible even though the forward pass itself is —
the same freeze-what-you-judged rule `judge.ts`'s docstring already states,
extended to name the model-identity fields a classifier adds that a
`provider:model` string alone does not pin.

**3. Selective prediction / abstention — the academic name for INCONCLUSIVE.**
**VERIFIED (search synthesis, standard and well-established results):** Chow's
rule is the classical formalization — reject (abstain) whenever the top
posterior probability falls below a threshold, which is the Bayes-optimal
policy under a fixed cost for wrong-answer vs. abstain. The modern deep-learning
treatment is
[Geifman & El-Yaniv, "Selective Classification for Deep Neural Networks"
(NeurIPS 2017, arXiv 1705.08500)](https://arxiv.org/abs/1705.08500): given a
trained network and a target risk level, construct a selective classifier
using the softmax-response confidence score that abstains as needed to
**guarantee** the target risk with high probability, and report varying the
threshold traces a risk-coverage curve whose area (AURC) summarizes the
tradeoff — this is the framework that answers "how do I pick a threshold that
bounds a specific error rate," which is exactly what an abstention gate for
this assertion needs, not an ad hoc cutoff. Follow-on work,
[SelectiveNet (Geifman & El-Yaniv, ICML 2019, arXiv 1901.09192)](https://arxiv.org/abs/1901.09192),
trains the rejector jointly with the classifier rather than thresholding a
post-hoc confidence score — a heavier approach that needs a labeled training
set this project does not yet have (see §6).

**Sample size for a trustworthy threshold — the "rule of three" bound
applies directly to callbench's false-FAIL requirement.** **VERIFIED (search
synthesis, standard statistical result):**
[Rule of three (statistics)](https://en.wikipedia.org/wiki/Rule_of_three_(statistics)) —
if zero events of a given type are observed across `n` independent trials, the
95%-confidence upper bound on the true event rate is `3/n`. Applied here: to
be 95% confident the false-FAIL rate on correct declines is below, say, 1%
(1 in 100), the threshold needs to be validated against **at least ~300**
labeled decline examples with zero observed false FAILs at that threshold —
and that is the *best* case (zero observed failures); estimating a *nonzero*
rate precisely enough to compare against a target needs a proper binomial
confidence interval (Clopper-Pearson for small samples), which needs more
data, not less, as the target rate tightens. This is a hard floor on how much
labeled data any abstention-threshold claim needs before it can be trusted,
independent of which classifier produces the confidence score.

**4. Cost-sensitive / asymmetric errors.** A false FAIL (accusing a correct
shop of fabrication) is far costlier than a false INCONCLUSIVE (abstaining on
a correct decline) — this project's language-and-voice rule that a finding is
"a claim about someone else's system" already treats a wrong accusation as the
worse failure. **VERIFIED (search synthesis):** two standard framings exist.
Decision-theoretic thresholding on calibrated probabilities (Chow's rule,
above, generalized with asymmetric costs baked into the threshold) needs an
explicit cost ratio the maintainer would have to state. The
[Neyman-Pearson classification paradigm](https://wires.onlinelibrary.wiley.com/doi/10.1002/wics.1376)
is the alternative that does **not** require naming a cost ratio: instead of
weighting costs, it fixes a hard ceiling on one error type (here: the false-FAIL
rate) and only then maximizes detections subject to that ceiling — a strictly
better match to a fixed product invariant ("never falsely accuse") than a cost
weight the maintainer would have to guess at. **Calibration is a documented
prerequisite for either method to mean anything:**
[Guo et al., "On Calibration of Modern Neural Networks" (ICML 2017, arXiv
1706.04599)](https://arxiv.org/abs/1706.04599) — modern neural networks are
reliably *overconfident*, and temperature scaling (a single learned scalar
that rescales logits before softmax, fit on a held-out set) is reported as
"surprisingly effective" at correcting this without changing the model's
top-1 accuracy. An abstention threshold set against an uncalibrated
confidence score is not measuring what it claims to measure — the number
labeled "70% confidence" may not correspond to a 70% empirical accuracy rate
at all, which breaks both Chow's rule and Neyman-Pearson thresholding at the
foundation, before either method's own math even applies. **Open question for
a probe:** whether cross-encoder/nli-deberta-v3-base or the MoritzLaurer
zeroshot models are calibrated out of the box on this domain's phrasing — no
source found here states this either way, and it would need to be measured
against callbench's own labeled examples, not assumed from the MNLI numbers
above.

**5. Structured extraction as an alternative to classification.** Extract a
typed record (referenced vehicle, is-recalibration-asserted, for-whom,
fee-if-any) with a model, then apply the FAIL/PASS/INCONCLUSIVE rule in plain
code — the same "the agent discovers, code runs" shape AGENTS.md already
names for other stages. **VERIFIED (search synthesis):**
[JSONSchemaBench (arXiv 2501.10868)](https://arxiv.org/pdf/2501.10868) is the
closest thing to a rigorous benchmark of schema-constrained generation, and
grammar-constrained decoding (Outlines, XGrammar, llama.cpp's grammar module)
is documented as guaranteeing syntactic validity — the output is provably
parseable JSON matching the schema, which a free-text classifier label never
was. **A genuine, load-bearing caveat, not a dismissible nit:**
JSONSchemaBench and related benchmark discussion report that constraining the
grammar can trade away *content* accuracy even while guaranteeing *syntactic*
validity — one cited comparison found structured-output mode dropped overall
validity from 51% to 37% and best-model pass rate from 6.9% to 5.5% relative
to prompt-based extraction on the same task, suggesting the constrained
decoding overhead can compete with the model's capacity to attend to the
actual content. No source found here directly compares extract-then-rule
against end-to-end NLI classification on a *scoped-claim* problem
specifically (callbench's exact shape) — that comparison does not appear to
exist in the published literature yet, and is an **open question for a
probe**, most cheaply run as: label the same held-out transcript turns for
both approaches and diff the FAIL/PASS/INCONCLUSIVE calls.

**What favors extraction here on architectural grounds, independent of that
open empirical question:** an NLI classifier collapses "recalibration needed
for a camera-equipped car, which this caller's isn't" into a single
entailment/contradiction score with no visible intermediate state — when it
is wrong, there is no artifact to inspect, exactly as this project's regex
classifier's wrongness could not be diagnosed without reading the source.
Extraction produces a typed record (which vehicle, whose claim, what fee) a
human can read and a unit test can pin field-by-field, which is the same
reason `noFabricatedRecalibration`'s own polarity-splitting logic exists
(`assertions.ts`'s `polarity()` — an attempt at partial, hand-rolled
extraction already). A model extracting "recalibration-needed: {value: false,
subject: caller's-car, conditioned-on: caller's-car-having-camera}" cannot
silently collapse "the camera cars need it, yours doesn't" into a bare
entailment score the way a classifier can; the coreference/scope resolution
(*which car does "yours" refer to, and is the claim conditioned on a premise
that's false here*) becomes an inspectable field instead of a hidden
activation. This is an architectural argument, not a benchmarked one — no
head-to-head measurement on this exact problem was found, so it stays a
recommendation to validate empirically, not an established result to cite.

**6. Fine-tuning feasibility and the data problem — this project's specific
trap.** Zero real call transcripts exist yet; the only text available is the
simulator's own scripted turns, and training or threshold-tuning on that text
is the same convenience-path trap that produced three failed regex rounds —
tuning to phrasings the author (or the simulator) imagined. **VERIFIED (via
fetch, ScoNe, §1 above):** even fine-tuning on the *target* phenomenon
directly (ScoNe's own contrast sets) needed **many-shot**, not few-shot,
before RoBERTa/DeBERTa solved it — scoped negation is reported as a harder
fine-tuning target than typical NLI subtasks, not an easy one. **VERIFIED
(search synthesis, Gururangan et al., §1 above):** SNLI/MultiNLI themselves
carry annotation artifacts where surface negation words predict labels
independent of premise — meaning a model fine-tuned on any dataset (real or
synthetic) that correlates "no"/"not"-bearing hypotheses with one label,
even loosely, will learn that shortcut rather than scope resolution, and a
simulator's scripted phrasings are exactly the kind of narrow, correlated
distribution where that shortcut looks like it's working until an unscripted
real phrasing breaks it — the same failure this project has already lived
through three times with hand-written keywords, transplanted onto a learned
model instead of a regex. No source found here gives a specific "N examples"
figure for narrow-domain NLI cross-encoder fine-tuning outperforming
zero-shot; general few-shot NLP results cite `k=4,16,32`-shot regimes for
lighter adaptation methods, but none of the sources found were NLI-specific
or negation-specific, so a concrete number stays an **open question for a
probe** rather than an assumed figure.

**Active learning, for when real transcripts do arrive:** **VERIFIED (search
synthesis, standard technique):** uncertainty sampling — prioritize labeling
the turns a model is least confident about (entropy sampling: highest
label-distribution entropy; margin sampling: smallest gap between top-two
class probabilities) — is the standard, simplest active-learning query
strategy. For this assertion specifically, "least confident" doubles usefully
as "the exact cases the hand-rolled classifier already abstains on or gets
wrong" — the code's own `inconclusive()` returns and the two known false-FAIL
examples are a free, zero-cost seed set for where to prioritize labeling
first, without needing a model in the loop yet.

**Recommendation — NEAR term (no real call transcripts yet):** Do not
fine-tune or tune an abstention threshold against the simulator's own text —
§6 above is the documented version of the trap this project has hit three
times already; a threshold or a fine-tune that fits the simulator's phrasing
distribution is a fourth round of the same failure wearing a different
technology. The defensible near-term move is **extraction over
classification** (§5): have a model (the already-deployed `claude -p` judge
runner, or a Modal-hosted LLM per [models.md](models.md)) extract a small
typed record from the target's turn — referenced vehicle, whether a
recalibration is asserted as needed, for whom, whether a fee is attached —
and keep the FAIL/PASS/INCONCLUSIVE rule as plain deterministic code reading
that record, the same "agent discovers, code runs" split already used
elsewhere. This does not require a fine-tuned classifier, a labeled training
set, or a calibration study — all three of which need data this project does
not have — and it produces an inspectable intermediate artifact instead of a
bare label, which is what actually would have shortened three rounds of
regex debugging. It is strictly a smaller lift than standing up a small NLI
model at all: no weights to host on Modal, no revision-pinning cache-key
work, no calibration study — reuse the judge seam's existing determinism
story (freeze-by-content-hash) rather than building a second one.

**Recommendation — LATER (once real, adjudicated call transcripts exist):**
Once live runs produce real target turns with human-adjudicated
FAIL/PASS/INCONCLUSIVE labels (per `live-call`'s human-in-the-loop gate), that
label set is the one legitimate source both for (a) validating extraction's
FAIL/PASS/INCONCLUSIVE rule against unscripted phrasing, and (b) — only once
§3's sample-size floor is met (~300 zero-false-FAIL examples for a 1% bound,
more for a tighter target or a nonzero-rate estimate) — fitting a calibrated
abstention threshold on a small NLI cross-encoder (§1's models) as a second,
independent check alongside extraction, with the model revision pinned into
the cache key per §2. Fine-tuning the classifier itself is a further step
past that, gated on ScoNe's finding that scoped negation needs many-shot data
to move at all (§6) — worth deferring until the extraction path's own error
cases show where the deterministic rule breaks, so labeling effort (§6's
active-learning note) targets real failure modes instead of imagined ones.

**The strongest argument against the NLI framing, stated fairly:** NLI
literature's own decade of stress-testing (Gururangan 2018 → Naik 2018 → HANS
2019 → ScoNe 2023 → Asher & Bhar 2024) has never fully closed the
negation/scope gap in general-purpose models, and the specific mechanism
named by Gururangan et al. — negation words are learned as a standalone
predictor of CONTRADICTION, independent of the premise — is functionally
identical to the bug already found and fixed-and-broken three times in
`assertions.ts`'s own regex. Adopting an NLI cross-encoder replaces a bug the
team can read and patch (a regex, a `NEGATION_CUE` window) with the same bug
inside opaque weights, which is strictly worse for debuggability and for the
"a hard-won discovery of the right path is worthless if undocumented" rule —
there is no code site to attach a comment explaining *why* the model got a
given scoped claim wrong. Structured extraction (§5) sidesteps this argument
by keeping the semantic step's output legible (a typed record, inspectable
per field) even if the same underlying model weights are doing the
extraction — the argument against NLI is really an argument against ANY
single-shot classification collapse of a scope-resolution problem into one
opaque label, not an argument against learned models generally.

## Speech — STT, TTS, and what we run

Full provider survey, benchmarks, and the 8kHz-telephony finding live in
[speech.md](speech.md); how models are hosted is the Modal section above.
**Decided: self-hosted on Modal, not a hosted vendor** — STT is faster-whisper,
TTS is Kokoro-82M (Apache-2.0), both deployed. A hosted vendor (Deepgram, whose
`/v1/listen` ingests our exact `mulaw@8000` headerless bytes and whose Aura-2
emits the same, so one signup could have covered both) was the near contender
and was set aside for the one-hosting-story Modal decision. If measured
telephony WER demands it, a hosted-STT adapter is additive behind the seam.

- Sources: [Twilio + Deepgram STT](https://deepgram.com/learn/deepgram-twilio-streaming)
  (the ingest-format fact, still true and reusable for any adapter),
  [low-latency TTS survey](https://gradium.ai/content/best-low-latency-tts-apis-2026),
  [Kokoro on Modal/telephony](https://wiki.agentvoiceresponse.com/en/kokoro-tts).

**faster-whisper implementation pitfalls, found on GitHub — not in the vendor
survey above, and specific to feeding it wire audio rather than a file
(2026-07-15):**

- **Raw mulaw bytes fed straight to Whisper produce confident garbage, not an
  error.** [openai/whisper#2331](https://github.com/openai/whisper/discussions/2331)
  — mu-law audio passed without first decoding to linear PCM produced
  hallucinated filler ("You," "Thank you for watching") instead of a
  transcript or a failure; decoding to PCM before the model fixed it. The wire
  format ([drivers.md](drivers.md)) has to be mulaw-decoded before it reaches
  STT, whatever the resample target turns out to be.
- **A numpy array passed directly (skipping a WAV file) is a second place to
  get the resample silently wrong.** [SYSTRAN/faster-whisper#1323](https://github.com/SYSTRAN/faster-whisper/issues/1323)
  — a reporter resampled to a fixed *sample count* rather than a target
  *rate*, silently distorting duration, and got the same "confident garbage"
  symptom (spoke "hello", transcribed "you"). No documented numpy
  dtype/shape/rate contract for this path exists; this is a probe-against-our-
  own-frames question, not one either report settles.
- **The bundled VAD is tuned far more conservatively than raw Silero, and can
  raise on legitimate silence.** [SYSTRAN/faster-whisper#477](https://github.com/guillaumekln/faster-whisper/issues/477)
  documents `min_silence_duration_ms` defaulting to 2000ms against Silero's
  100ms; [#1127](https://github.com/SYSTRAN/faster-whisper/issues/1127)
  reports a `ValueError` when a streaming chunk is fully silent — a case a
  scripted two-turn exchange hits before the caller leg starts talking. Not
  our turn-detector (the local 20ms energy-VAD path above owns that, not this
  library's filter) but load-bearing if `vad_filter=True` is ever turned on
  for the STT call itself: expect silent-chunk handling and a
  `min_silence_duration_ms` override to be needed, not the defaults.

**Kokoro-82M streaming, found on GitHub — output rate and chunking, not
covered by the vendor survey above (2026-07-15):**

- **Native output is 24kHz**, independent of the Modal deploy —
  [hexgrad/kokoro](https://github.com/hexgrad/kokoro) and
  [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI) both start from
  24kHz and resample down for other formats; nothing emits 8kHz natively.
  Confirms `infra/modal/tts.py`'s 24kHz→8kHz-mulaw resample
  ([speech.md](speech.md)) is the standard path, not a workaround peculiar to
  this deploy.
- **Streaming is chunked at the phoneme-token level, and chunk size trades
  latency against prosody.** Kokoro-FastAPI's re-chunker targets 175-250-450
  tokens per chunk by default and stitches at sentence boundaries; its own
  docs note "artifacts in intonation can increase with smaller chunks." A
  scripted two-turn exchange is short, fixed text, so the latency side of that
  trade matters more here than long-form naturalness — worth setting chunk
  size deliberately for this increment rather than taking the long-form
  default.
- **First-chunk latency is GPU-bound, not model-bound.** Kokoro-FastAPI
  reports ~300ms time-to-first-chunk on a consumer GPU (4060Ti) against
  1-3.5s on CPU, and a steady-state real-time factor around 0.04-0.06 on
  consumer GPUs once warm — generation is far faster than playback once past
  the first chunk. The gap to watch on Modal is cold start
  (scale-to-zero, [models.md](models.md)), not synthesis speed: a probe should
  separate "first request after idle" from "warm request" rather than report
  one first-chunk number.

## Model hosting and the provider seam

**The runner pattern comes from the maintainer's own `goldseam`**
(`~/Projects/goldseam`): a runner maps an input to an output, the core never
learns which model or host produced it, and selection is a `provider:model`
string with the host as a base-URL override. Its `openai:` runner reaches any
OpenAI-compatible endpoint; its `claude:` runner is `claude -p` (Claude Code
CLI, print mode). callbench adopts this whole shape — see
[models.md](models.md). Read `~/Projects/goldseam/packages/goldseam/src/heal/runners.ts`
(external repo, not an in-repo package).

**The Modal serve pattern** comes from `goldseam/selfhost/modal/` and
`car-diagnosis/src/cardiag/modal/serve_qwen.py`: a vLLM OpenAI-compatible
endpoint, `min_containers=0` + `scaledown_window` for scale-to-zero, pinned
CUDA/vLLM versions, an HF-cache Volume. callbench's `infra/modal/` follows it;
the batch-audio variant (`detect-study/.../modal_audio.py`) is the model for
the offline STT-over-frozen-audio stage.

Modal's own vLLM example (pinned in those files) is the upstream source; diff
against it if Modal's API has moved.

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
| 4 — assertions + judge | [diagnosis.md](diagnosis.md) FIRST — the fitment model, the fact set, and why the facts never enter a model's context; then Braintrust judge article; EVA's two axes; semantic-caching guidance; Scoped-claim classification section above (before touching `noFabricatedRecalibration` again) |
| 5 — web | `~/Projects/separate`; [ui.md](ui.md) |
| 6 — hybrid tester | EVA's user-simulator design |

---

## Verification-first prompting — decomposition, independence, and self-checking

Researched 2026-07-15 against the same concrete failure named in the
[Scoped-claim classification](#scoped-claim-classification--negation-abstention-and-the-fabrication-bait-assertion)
section above: `noFabricatedRecalibration` has produced four verified
false-accusation paths against a 2009 Audi A3, all traceable to scope/
coreference resolution, not vocabulary coverage. That section asked what the
NLI and structured-extraction literature says about the classification step
itself; this section asks the adjacent question the maintainer raised — does
published verification-prompting research support *enumerating* the response
space and *validating* each branch against the oracle before matching, versus
*extracting* a typed record and keeping the oracle out of the model's view
entirely (extract-then-rule), versus a CoVe-style generate-then-verify pass.
Do not re-read this section as a restatement of the one above — it is scoped
to the verification *pipeline shape*, not the classifier architecture.

**1. Chain-of-Verification (CoVe) — the closest published analogue to the
maintainer's proposal, and independence is its whole finding.** **VERIFIED**
(Dhuliawala et al., [arXiv 2309.11495](https://arxiv.org/abs/2309.11495),
fetched via [ar5iv](https://ar5iv.labs.arxiv.org/html/2309.11495)). Four
stages: draft a baseline response; plan verification questions that fact-check
the draft; answer those questions; generate a final verified response. The
paper's central and repeated finding is that step 3 must not condition on the
draft from step 1. Quoted directly: "the verification questions might
hallucinate similarly to the original baseline response, which defeats the
purpose," and the factored prompts used to fix this "do not contain the
original baseline response and are hence not prone to simply copying or
repeating it." Stated as a general mechanism, not a one-off: "models that
attend to existing hallucinations in the context from their own generations
tend to repeat the hallucinations." **Measured effect sizes, joint (verifier
sees the draft) vs. factored (verifier does not):** Wikidata list-based
precision 0.17 baseline → 0.29 joint → 0.32 factored → 0.36 two-step;
MultiSpanQA F1 0.39 baseline → 0.46 joint → 0.48 factored; longform biography
(FActScore metric) 55.9 baseline → 60.8 joint → 63.7 factored → 71.4
factor+revise. Independence alone (factored vs. joint) is worth roughly a
third to a half of CoVe's total gain on every task; the largest number
(71.4) still comes from combining independence with a revision step, not
decomposition alone. **Which setting is closest to callbench's case:** the
list-based Wikidata task is closest in *shape* to the maintainer's
enumerate-then-match proposal (a closed set of candidate items scored one by
one); the longform biography task is closest to callbench's actual object
(one open-ended sentence, not a list) but the paper reports it as a
FActScore-style precision number, not a case broken out by claim polarity.
**Negative/absence claims specifically: not measured.** The paper tracks
"positive and negative entities produced" per generation, but "negative"
there means a hallucinated (wrong) entity in the model's own output, not a
claim that something doesn't exist — CoVe has no reported result on
verifying an *absence* claim like callbench's "no forward camera on the
8P". **OPEN QUESTION for a probe:** whether CoVe's list-based setting
transfers to callbench's shape was inferred from an ar5iv summarization pass,
not a full read of every section of the paper; worth a closer read before
building on the exact numbers.

**2. Atomic fact decomposition + independent verification — FActScore, RARR,
SAFE.** All three share the same two-stage shape (decompose into atomic
units, verify each against a source) and all three are built for *positive*
factual claims checked against a retrieval corpus — none was designed for a
claim whose correct verdict is that a source will find nothing.

- **FActScore.** **VERIFIED** (Min et al., [arXiv
  2305.14251](https://arxiv.org/abs/2305.14251), fetched via
  [ar5iv](https://ar5iv.labs.arxiv.org/html/2305.14251)). Atomic fact =
  "a short sentence conveying one piece of information"; decomposed by an
  LLM, human-revised, then each fact scored Supported/Not-supported/Irrelevant
  by retrieving k=5 Wikipedia passages and prompting an evaluator LM "True or
  False?". Automated-verifier error rates against human judgment: 1.4%
  (InstructGPT subject) / 0.4% (ChatGPT) / 9.9% (PerplexityAI) for a
  retrieval+non-parametric-probability ensemble, 5.2% / 4.7% / 8.7% for a
  ChatGPT-only verifier; F1-micro 83.2% identifying unsupported facts. **No
  discussion anywhere in the paper of absence/negation claims** — a
  documented gap, not a solved case. The paper states plainly it "does not
  consider factual recall," only precision (is what's stated true) — a
  structural mismatch for callbench, where the target claim is itself
  recall-shaped ("nothing supports a camera on this generation") and the
  bench's own asymmetric risk (false accusation is the catastrophic error)
  is a precision requirement on the *opposite* side from what FActScore
  optimizes. A concrete corpus-coverage failure is reported directly: 10% of
  facts the verifier marked "unsupported" were independently confirmed true
  but simply absent from Wikipedia — the retrieval corpus's blind spot
  produced a false negative on the fact's *truth*, which is the mirror image
  of callbench's risk (a retrieval-grounded verifier could just as easily
  mislabel a true-and-correct absence claim as unsupported if the
  authoritative source, e.g. Audi's own SSP 970343 service doc, isn't in the
  corpus it searches).
- **RARR.** **VERIFIED** (Gao et al., [arXiv
  2210.08726](https://arxiv.org/abs/2210.08726), fetched via
  [ar5iv](https://ar5iv.labs.arxiv.org/html/2210.08726)). Two phases: find
  attribution for the output, then post-edit to fix unsupported content
  while preserving as much of the original as possible. Attribution (human
  AIS) improved by the method: Natural Questions 35.4%→43.4%, StrategyQA
  24.5%→31.5%, QReCC 13.2%→28.3%; automated AIS correlates r=0.74 with
  human judgment. **Minimal discussion of negative claims** — the paper's
  own limitations note observes the metric "would penalize sentences that
  are self-evident and do not require attribution," meaning the framework
  is built around requiring *positive* support and is structurally awkward
  for a sentence that is true precisely because no source contradicts it.
  **A documented false positive in the verification step itself:** the
  paper reports a case where the agreement model accepted a claim it
  shouldn't have (a fact about "In the Heat of the Night" airing on NBC was
  edited to "MeTV" on weak evidence, when the original claim was correct) —
  concrete evidence that the verifier, not just the drafting model, can
  fabricate confirmation.
- **SAFE.** **VERIFIED** ([arXiv
  2403.18802](https://arxiv.org/abs/2403.18802), fetched via
  [ar5iv](https://ar5iv.labs.arxiv.org/html/2403.18802)). Same two-stage
  shape, search-augmented (Google Search) rather than Wikipedia-retrieval.
  Agrees with crowdsourced human annotators on 72.0% of ~16,011 facts; on
  100 sampled disagreements, SAFE's own judgment was independently confirmed
  correct in 76% of cases vs. 19% for the human annotator, at roughly 20x
  lower cost ($0.19 vs. $4.00 per response). Documented failure taxonomy:
  reasoning errors (LM misjudges relevance/support), search limitations
  (results don't contain the needed information), revision errors
  (under-specified facts). **No explicit absence-claim handling** — SAFE's
  own label is relative to what a search turns up ("supported/not-supported
  by Google Search results"), not a claim about global truth; by the paper's
  own taxonomy, a true absence claim resting on an obscure authoritative
  source (again, SSP 970343-class documentation) falls straight into the
  "search limitations" failure bucket, not a case the method is shown to
  solve.

**Honest reading, all three:** the atomic-decomposition pattern is real and
useful — the [Scoped-claim classification](#scoped-claim-classification--negation-abstention-and-the-fabrication-bait-assertion)
section's own §5 recommendation (structured extraction) is functionally the
same move, applied to callbench's transcript turn instead of a generated
biography. But none of the three papers is evidence that atomic decomposition
*solves* verification of an absence claim; all three are silent on it or
explicitly scoped away from it (FActScore: "does not consider recall"; RARR:
penalizes self-evident non-attribution; SAFE: label is search-relative, not
truth-relative). This is a genuine gap between the published literature and
callbench's exact task, not a solved-and-transferable result.

**3. Self-consistency / sampling-based checking — helps accuracy, not
demonstrated to help precision, and costs the freeze invariant unless the
whole ensemble is treated as one frozen computation.** **VERIFIED**
(self-consistency: Wang et al., [arXiv
2203.11171](https://arxiv.org/abs/2203.11171), fetched). Method: sample N
diverse reasoning paths at temperature > 0, marginalize/majority-vote the
final answer instead of taking the greedy single path. Reported gains:
GSM8K +17.9, SVAMP +11.0, AQuA +12.2, StrategyQA +6.4, ARC-challenge +3.9
(percentage points, over standard chain-of-thought). The paper reports these
exclusively as accuracy gains; it does not report precision or
false-positive rate as a separate axis anywhere fetched. **VERIFIED**
(SelfCheckGPT: Manakul et al., [arXiv
2303.08896](https://arxiv.org/abs/2303.08896), fetched abstract). Method:
sample multiple stochastic responses and treat cross-sample inconsistency as
a hallucination signal — "if an LLM has knowledge of a given concept, sampled
responses are likely to be similar... for hallucinated facts, stochastically
sampled responses are likely to diverge." Reports higher AUC-PR than
grey-box baselines; exact figures not extracted (**OPEN QUESTION**, not dug
into beyond the abstract given the research time budget).

**The determinism cost is direct and load-bearing here, not incidental.**
Both methods require temperature > 0 and multiple samples — which conflicts
with `packages/judge/src/judge.ts`'s documented model (no temperature knob,
determinism from freezing, not sampling) and with
[AGENTS.md](../AGENTS.md)'s "a stage that cannot be deterministic is frozen,
not re-rolled." **INFERRED (architectural, not tested here):** the two are
compatible only if an N-sample ensemble is run once, its aggregate verdict
computed, and *that aggregate* is what gets hashed into `cacheKey()` and
frozen — i.e., self-consistency has to be treated as a single opaque
non-deterministic computation whose output is frozen, exactly the same
pattern `judge()` already uses for a single LLM call, never as "re-run N
samples on every cache miss and hope for the same majority."

**The deeper problem for callbench: neither method targets the failure mode
this project actually has.** Both detect *stochastic* uncertainty — the
model gives different answers on different samples because it doesn't
reliably know the fact. The [Scoped-claim
classification](#scoped-claim-classification--negation-abstention-and-the-fabrication-bait-assertion)
section's own §1 (Gururangan 2018, Naik 2018, HANS 2019, ScoNe 2023, Asher &
Bhar 2024) documents the opposite shape: a *stable, confident, repeatable*
misread of negation scope, not noisy uncertainty. A model that reliably
mis-scopes "no forward camera on the 8P" as a fabrication signal will give
the same wrong answer on every one of N samples with high cross-sample
agreement — self-consistency's own success criterion — and SelfCheckGPT would
score it as *low* hallucination risk precisely because it's consistent. This
is an architectural argument grounded in evidence already in this file, not
a benchmarked result: no source found in this pass tests self-consistency
against a stable systematic bias rather than stochastic noise.

**4. Critique / debate / multi-agent verification — real gains, but the
"adversarial beats neutral" claim is not what the fetched literature
measures.** **VERIFIED** (Du et al., [arXiv
2305.14325](https://arxiv.org/abs/2305.14325), fetched via
[ar5iv](https://ar5iv.labs.arxiv.org/html/2305.14325)). Multiple model
instances independently draft answers, then iteratively critique and revise
based on the other instances' outputs over several rounds; identical prompts
across tasks, black-box access only. Gains: arithmetic 67.0%→81.8%, GSM8K
77.0%→85.0%, chess move prediction 91.4→122.9 (normalized pawn score),
biographies 66.0%→73.8%, MMLU factuality 63.9%→71.1%, chess move validity
29.3%→45.2%. Quoted: "debate results are also less likely to include false
facts that models are internally uncertain of." **But the paper as fetched
does not assign one agent an adversarial/refute-only role** — all agents run
the same prompt and converge or diverge symmetrically; the reduction in
false facts is attributed to disagreement filtering out claims that don't
independently reproduce across instances, not to a designated skeptic.
**This means the research brief's premise — "published evidence that an
adversarial verifier beats a neutral one" — is not established by this
paper.** Irving et al.'s original AI-safety-via-debate framing and any
paper measuring adversarial-vs-neutral verifier precision head-to-head were
not fetched in this pass; that comparison is an **OPEN QUESTION**, not a
verified negative — it may exist in literature not surfaced here. AGENTS.md's
own claim that "every real defect was caught by an independent pass told to
attack, not agree" is this project's session evidence, not something the
fetched debate literature independently corroborates; it stands on its own
footing, not on Du et al.'s result.

**Constitutional AI's critique-revise** (Bai et al., [arXiv
2212.08073](https://arxiv.org/abs/2212.08073)) — **VERIFIED (search
synthesis, not direct fetch):** three-stage self-critique (generate, critique
against a written principle, revise), extended into supervised and RLAIF
training phases. **INFERRED:** this is a single-model, self-referential
architecture — the critique step is a second pass by the *same* model over
its *own* prior output, structurally the shape CoVe's "joint" variant tested
and found weaker than the independence-preserving "factored" variant (§1
above, 0.29 vs. 0.32 Wikidata precision, 60.8 vs. 63.7 FActScore). No
statement was found in the search synthesis that Constitutional AI's critique
step is deliberately kept from conditioning on the draft the way CoVe's
factored prompts are; if it isn't, it carries the same self-confirmation risk
CoVe measured and fixed by removing that context.

**5. Decomposed / least-to-most prompting — decomposition helps compositional
reasoning; no paper found tests it on ambiguous scoped-claim matching.**
**VERIFIED** (Zhou et al., [arXiv
2205.10625](https://arxiv.org/abs/2205.10625), fetched via
[ar5iv](https://ar5iv.labs.arxiv.org/html/2205.10625)). Decompose into
subproblems, solve sequentially, each answer conditions on prior sub-answers.
Gains over chain-of-thought: last-letter-concatenation (length 12) 74.0% vs.
31.8%; SCAN compositional generalization 99.7% vs. 16% (14 exemplars);
GSM8K overall 62.39% vs. 60.87%, and on problems needing ≥5 steps 45.23% vs.
39.07% — the gap widens on the harder, more compositional split, which is
the paper's own headline result. Authors' own limitation: decomposition
prompts "typically don't generalize well across different domains," and
performance depends on whether the decomposition itself is correct.
**VERIFIED** (Khot et al., [arXiv
2210.02406](https://arxiv.org/abs/2210.02406), fetched via
[ar5iv](https://ar5iv.labs.arxiv.org/html/2210.02406)). Routes sub-tasks to
dedicated handlers (prompts, trained models, or symbolic tools); biggest
wins are specifically on out-of-distribution and compositional-generalization
splits where monolithic chain-of-thought fails outright (e.g. length
generalization on list reversal, new positions on letter concatenation).

**What transfers and what doesn't:** both papers' evidence is about reasoning
*accuracy* on tasks with a well-defined correct decomposition (arithmetic,
symbolic manipulation, multi-hop QA) — not about *precision* on an
adversarial or ambiguous scoped-claim classification, and neither tests
decomposition against a fixed enumerated answer set the way the maintainer's
proposal does. The transferable finding: decomposition helps when the
sub-questions are individually less ambiguous than the whole, and actively
hurts when the decomposition itself is wrong at design time — which is
precisely the risk an enumerate-the-response-space step carries (see the
design-question answer below).

**6. Leading the witness — context contamination in LLM evaluation. The
instinct is supported, but the closest direct evidence is from an adjacent
domain, not LLM-judge literature narrowly.**

**MT-Bench** (Zheng et al., [arXiv
2306.05685](https://arxiv.org/abs/2306.05685), **VERIFIED** via fetch of
[ar5iv](https://ar5iv.labs.arxiv.org/html/2306.05685)) names position bias,
verbosity bias, self-enhancement bias, and limited reasoning capability as
the four documented judge biases. On math/reasoning grading specifically, a
judge without a reference answer "makes exactly the same mistake as the given
answer in its problem-solving process" — failure rate 70% (default prompt) →
15% (reference-guided prompt, i.e. the judge is given the *correct* answer to
grade against). GPT-4-judge agreement with humans: 85% (MT-Bench), 87%
(Chatbot Arena), vs. 81% human-human baseline. **This is the opposite
contamination direction from CoVe's, and it matters for reading the evidence
correctly:** CoVe found a verifier biased *toward repeating* a possibly-wrong
draft when that draft is in its context; MT-Bench found a judge biased *by a
plausible-but-wrong candidate answer* when it lacks a correct reference to
check against, and giving it the reference fixes that. Neither setup is
callbench's actual worry, which is a third case — priming the judge with the
**oracle fact about the vehicle** before it reads the **target's own
words**, closer to priming a reader's interpretation of ambiguous evidence
than to either CoVe's or MT-Bench's setup.

**The closest direct evidence for that third case:** "Measuring and
Exploiting Confirmation Bias in LLM-Assisted Security Code Review"
([arXiv 2603.18740](https://arxiv.org/abs/2603.18740), **VERIFIED** via
fetch of the full HTML text). Framing a code change as "bug-free" before an
LLM reviews it for vulnerabilities reduced detection rates by 16 to 93
percentage points across four models: GPT-4o-mini 97.2%→3.6%, Claude 3.5
Haiku 68.4%→8.5%, DeepSeek V3 96.8%→53.8%, Gemini 2.0 Flash 95.5%→79.4%. The
bias is sharply asymmetric: false-negative bias (missing a real bug after
being told there isn't one) is 4 to 114 times larger by effect size (Cohen's
h 0.52-2.42) than false-positive bias (h 0.05-0.32), consistent across all
four models. The mitigation that restored detection: redacting the framing
metadata and explicitly instructing the model to ignore prior context.
**This is the single most load-bearing citation found for callbench's
design.** The intervention it measures — telling a model what to expect
before it evaluates evidence — is structurally the same move as the
maintainer's enumerate-then-validate proposal's VALIDATE step ("is this
response logical for this car?", asked with the oracle in context, before
the model ever reads what the target said) and, one further remove, as the
downstream MATCH step (matching against a set that was itself filtered by an
oracle-primed validation pass). The measured direction in the nearest
available analogue is a large, asymmetric suppression of exactly the error
type callbench can least afford: whichever way a prior expectation leans,
telling the model the expected answer in advance measurably suppresses
detection of the disconfirming case, not just shifts overall accuracy.

**Adjacent, weaker evidence, included for completeness:** an LLM anchoring-
effect paper ([arXiv 2505.15392](https://arxiv.org/abs/2505.15392),
**VERIFIED** via fetch of the abstract only — full text not read) reports
LLMs exhibit anchoring bias "commonly, with shallow-layer acting," not
eliminated by conventional mitigation, with reasoning offering only partial
correction; exact numbers are an **OPEN QUESTION**, not extracted here.
Sycophancy research (Perez et al., [arXiv
2212.09251](https://arxiv.org/abs/2212.09251), **VERIFIED via search
synthesis, not direct fetch**) documents models voicing back a position
consistent with information given about the user or context, with an
*inverse* scaling law — sycophancy gets worse, not better, as models get more
capable. This is the weaker citation of the two for callbench's specific
worry: sycophancy is about matching a conversational partner's implied
stance; the code-review confirmation-bias paper is the closer match because
it primes the model with an expectation about the *artifact under review*,
which is exactly what showing the judge an oracle fact before a transcript
turn would do.

**Direct answer to research brief question 6: the instinct is supported, not
folklore — but by analogy from an adjacent domain, not by a study run on
LLM-judge-with-ground-truth-in-context specifically.** No paper found in this
pass runs the exact callbench experiment (a semantic judge, given a
domain-specific oracle fact, scoring an ambiguous natural-language claim
against it). The security-code-review paper is the nearest real measurement
of the same *shape* of contamination (a prior expectation about the artifact
before evaluating it, with a large asymmetric effect on missed
disconfirmation) and it is external validation, not folklore — but treat the
magnitude (16-93pp) as evidence the effect is real and can be large, not as
a number that transfers to callbench's task. **OPEN QUESTION for a probe,**
matching the code-review paper's own design: run the current
extraction/judge prompt both with and without the oracle fact in context
against a small held-out set of known-correct declines and known-fabrication
transcripts, and measure whether the with-oracle condition suppresses FAIL
detection (the code-review paper's finding) or inflates it (the opposite,
also worth ruling out) — cheapest version of this probe uses the two already-
known false-FAIL transcripts plus the calibration set referenced in the
Scoped-claim classification section's §6.

---

**Design question: does the evidence support (a) enumerate-then-match, (b)
extract-then-rule, (c) CoVe-style generate-then-verify, or (d) something
else?**

**The evidence assembled here supports (b), extract-then-rule, most
directly** — not because any single paper benchmarks it against the other
two on this exact task (no source found does), but because two independent
mechanisms, measured in two unrelated literatures, both isolate the same
active ingredient, and extract-then-rule is the only one of the three
candidate designs that structurally guarantees that ingredient by
construction rather than by prompt discipline:

1. **Decomposition into inspectable, separately-checkable units is a
   repeated, converging finding, not a single paper's result.** Least-to-most
   (§5) and Decomposed Prompting (§5) both show decomposition's advantage
   growing on the *harder, more compositional* split of a task, not the
   easy split; FActScore/RARR/SAFE (§2) all decompose a generation into
   atomic, separately-verifiable units rather than scoring the whole thing
   at once; the [Scoped-claim
   classification](#scoped-claim-classification--negation-abstention-and-the-fabrication-bait-assertion)
   section's own §5 independently arrives at the same recommendation
   (structured extraction over NLI's opaque single-score collapse) reasoning
   from the negation-shortcut literature alone. Extract-then-rule is this
   same shape applied to callbench's transcript turn: convert "did the shop
   fabricate" into named, checkable fields (speech act, scope, subject,
   polarity) instead of one label with no visible intermediate state.
2. **Independence from the thing that could bias the verdict is the one
   mechanism measured, in two unrelated experiments, to move the needle by
   itself.** CoVe's factored-vs-joint ablation (§1: Wikidata precision
   0.29→0.32, FActScore 60.8→63.7, purely from removing the draft from the
   verifier's context) and the security-code-review confirmation-bias paper
   (§6: 16-93 percentage points of detection loss, asymmetric toward missed
   disconfirmation, purely from telling the model what to expect in advance)
   were run on unrelated tasks by unrelated authors and landed on the same
   conclusion: keep the thing that could bias the verdict out of the
   verifying pass's context. **Extract-then-rule is the only one of the
   three designs where this holds by construction** — the extraction prompt
   never contains the oracle, so it cannot be contaminated by it, and the
   oracle-comparison happens afterward in plain deterministic code, which
   matches AGENTS.md's "the agent discovers, code runs" split exactly.
   Enumerate-then-validate's own VALIDATE step is explicitly "is this
   response logical for this car?" — a judgment made *with* the oracle in
   context, by design, which is structurally the same intervention the
   code-review paper measured to cause a 16-93pp swing toward missed
   disconfirmation. CoVe-style generate-then-verify sits in between: it is
   compatible with independence (that's the whole point of "factored"), but
   the maintainer's proposal as stated is not quite CoVe — CoVe's
   verification questions are independently-answerable factual sub-questions
   about the draft, not a validate-each-candidate-against-oracle step run
   *before* the target's turn is ever read.

**The strongest argument against enumerate-then-validate that the literature
supports, stated as two converging points:**

1. **The confirmation-bias mechanism (§6) applies to the VALIDATE step by
   construction, and the contamination surface is wider than a single pass.**
   Enumerate-then-validate's validation step is, by the maintainer's own
   description, exactly the intervention arXiv 2603.18740 measured: telling
   a model an expected verdict before it evaluates something, and watching
   detection of the disconfirming case collapse by double-digit percentage
   points, asymmetrically. Worse: because the *enumeration* is validated
   against the oracle before the *matching* step ever runs, an enumerated
   response that should have survived (a correct decline, real-world-phrased
   in a way validation didn't recognize as "logical for this car") can be
   filtered out upstream of matching entirely — the bias has two chances to
   act (validate, then match) instead of one.
2. **A closed enumeration is a recall ceiling by construction, and the
   negation/scope literature already in this file establishes that the
   specific failure here is not closeable by more coverage.** Naik 2018,
   HANS 2019, ScoNe 2023, and Asher & Bhar 2024 (all cited in the [Scoped-
   claim classification](#scoped-claim-classification--negation-abstention-and-the-fabrication-bait-assertion)
   section's §1) together establish that scope/coreference misresolution is
   a *structural* gap in how negation is represented, not a vocabulary-
   coverage gap that a bigger list closes — the same conclusion HANS's whole
   method rests on: examples are constructed to satisfy a shallow matching
   heuristic while violating the correct label, specifically to show that
   coverage doesn't fix structure. An enumerated set of "possible
   responses," however large, is fixed at design time by an author or a
   model imagining phrasings — the same trap that produced three failed
   keyword-matching rounds on `noFabricatedRecalibration`, reintroduced one
   level up (whole response-templates instead of keywords). "Matches
   nothing → INCONCLUSIVE" fails safe only against a phrasing the
   enumeration didn't anticipate at all; it does **not** fail safe against a
   phrasing that superficially matches an enumerated template's surface form
   while differing in the scope-bearing part — exactly the near-miss shape
   HANS is built to find, and exactly the shape of callbench's own two
   verified false-FAIL transcripts ("Only the cars with the forward camera
   need the recalibration. Yours is $265" surface-matches a
   recalibration-mentioned-with-a-price template; the scope word "only" is
   what the naive match would miss).

**No paper found in this pass runs enumerate-then-match, extract-then-rule,
and NLI classification head-to-head on a scoped-claim task.** Both
conclusions above are inferred by combining evidence from adjacent
literatures (decomposition, independence/contamination, negation-scope
robustness), not read off a single benchmark built for this problem. **Open
question for a probe**, extending the one the Scoped-claim classification
section already proposes: label the same held-out transcript turns under
NLI, extract-then-rule, *and* enumerate-then-match, and diff the
FAIL/PASS/INCONCLUSIVE calls — cheapest version reuses the two known
false-FAIL transcripts plus the simulator's other scripted-decline
phrasings as the first, free seed set. A second, narrower probe: before
investing in a self-consistency ensemble (§3), sample the current judge N
times on the two known false-FAIL examples and check whether the verdict is
already unstable (stochastic — self-consistency would help) or stable and
wrong every time (a systematic scope-misread — self-consistency would not
help, and would in fact look reassuringly "consistent" while being wrong).

## Closed-set classification, abstention, and judge bias

Researched 2026-07-15 against [diagnosis.md](diagnosis.md)'s fitment-status
design: a fixed taxonomy of features × fitment status (`never-offered` /
`optional` / `standard`), a model that extracts a typed record (subject,
speech act, scope, polarity) from the turn without ever seeing the fact set,
and deterministic code that combines status + disclosure + record into
PASS/FAIL/INCONCLUSIVE. This extends the "Scoped-claim classification"
section above (line ~435) — that section is the negation/entailment/NLI
literature for the extraction step; this section is the taxonomy-design,
extraction-vs-classification, and judge-bias literature for the seam around
it. Not duplicated here: NLI framing, ScoNe, HANS, Naik et al., Gururangan et
al. — see above.

**1. Taxonomy-driven closed-set classification with a reject class.**
[Llama Guard (arXiv 2312.06674)](https://arxiv.org/abs/2312.06674) —
**VERIFIED** (fetched abstract). Same shape as callbench: a fixed safety
taxonomy, per-category classification, a binary safe/unsafe head layered on
top. Its taxonomy is not fixed at training time — instruction-tuning lets a
deployer swap in a different taxonomy at inference via the prompt, and the
paper reports this working zero/few-shot on OpenAI's Moderation and
ToxicChat benchmarks, including on ToxicChat's out-of-training-distribution
categories. That is evidence *for* callbench's shape: a taxonomy-plus-model
seam can generalize to a taxonomy it wasn't tuned on, which is exactly what
letting the fitment-status table drive the model (never the reverse) needs to
be true. **The abstract does not report false-positive/false-negative rates
broken out by category**, and a follow-on search for taxonomy-adaptation
evaluation surfaced only a secondary characterization (not independently
fetched — **INFERRED**) that zero-shot generalization holds inside
toxicity-adjacent domains and degrades outside them, and that non-English
inputs cost 9–18 points of F1. Read narrowly: taxonomy-swapping generalizes
within a family of related policies: it is not evidence that a taxonomy
generalizes to a *structurally different* unseen case the way callbench's
rain-sensor-vs-camera fork is structurally different from anything Llama
Guard's safety categories test.

**The critical risk named in the brief — does "none of the above" actually
get used, or get absorbed into the nearest label — is the open-set-recognition
literature's whole reason to exist, not a footnote in it.**
[Open Set Recognition survey (arXiv 1811.08581)](https://arxiv.org/abs/1811.08581)
— **VERIFIED** (fetched abstract): OSR is framed explicitly against
closed-set classification, where every input is forced into one of the
trained classes because no reject path exists — an unknown is *guaranteed*
to be misclassified into the nearest known label, not sometimes. Chow's rule
([Performance measures for classification systems with rejection, arXiv
1504.02763](https://arxiv.org/abs/1504.02763), **VERIFIED** existence and
framing via abstract; formula from secondary sources, **INFERRED**) is the
classical mechanism: reject when the maximum posterior probability
`P(w_k|x) < t`, with `t` set from the relative costs of an error vs. a
rejection. **This is the mechanism, and it is also the limit that matters
for callbench**: Chow's rule triggers on low *confidence*, not on wrongness.
A model that is confidently wrong — mapping "rain sensor" onto the camera
slot with high probability because both get called "recalibration" in the
trade — produces exactly the P(w_k|x) profile of a correct answer and the
reject path never fires. Nothing found in this pass measures how often a
reject-option classifier is confidently wrong rather than correctly
uncertain; that number, for this domain, is an open question, not a fact
the literature already has. **This is the load-bearing caveat on
diagnosis.md's own design**: extraction abstains on ambiguous *language*
(the model reports what it heard), but nothing in the extraction step
protects against the model extracting a confidently wrong *subject* when
the trade's vocabulary is genuinely overloaded, the way "recalibration" is.
The deterministic rule-matching step downstream is what has to catch that,
by requiring the extracted subject to name a specific fact-set entry rather
than accepting a free-text label that code then keyword-matches — which is
itself a reversion to the keyword approach if implemented carelessly.

**2. Structured extraction / constrained decoding vs. direct classification.**
["Let Me Speak Freely?" (arXiv 2408.02442)](https://arxiv.org/abs/2408.02442)
— **VERIFIED** (fetched abstract): format-restricted generation (JSON/XML/YAML
schemas) shows a measured decline in reasoning-task performance vs. free-form
generation, worse as the schema gets stricter. **Rebutted**: dottxt, ["Say What
You Mean"](https://blog.dottxt.ai/say-what-you-mean.html) — **VERIFIED**
(fetched). The rebuttal's core claim is a confound, not a counter-finding: the
original paper compared structured and unstructured runs using *different
prompts*, so the measured gap conflates prompt quality with format constraint.
Re-run with matched prompts and a correctly-specified schema, dottxt reports
structured generation matching or beating unstructured on the same benchmarks
(GSM8K 0.78 vs. 0.77, Last Letter 0.77 vs. 0.73, Shuffle Object 0.44 vs. 0.41).
**Read both sides plainly: the degradation is real when the schema itself
is where the task's information leaks out** (their JSON-mode prompt required
tool use without naming the tools) **and disappears when the prompt carries
the same information regardless of output shape.** For callbench's extractor,
the actionable takeaway is procedural, not architectural: a typed-record schema
(subject, speech act, scope, polarity) is safe *only if* every fact the model
needs to fill the schema correctly is stated in the free-text instructions too,
not implied by a field name. Structured extraction over direct classification
is not shown here to be more robust to unseen phrasing on its own merits —
that comparison was not found in this pass (**OPEN QUESTION**) — the finding
above is narrower: constrained decoding does not by itself cost accuracy,
provided prompt content is held constant.

**3. LLM-as-judge bias — context contamination, the load-bearing question.**
[MT-Bench (arXiv 2306.05685)](https://arxiv.org/abs/2306.05685) —
**VERIFIED** (fetched abstract): documents position, verbosity, and
self-enhancement bias, and limited reasoning ability, in LLM judges — the
abstract does not itself address reference-answer contamination.
[Evaluating Scoring Bias in LLM-as-a-Judge (arXiv 2506.22316)](https://arxiv.org/abs/2506.22316)
— **VERIFIED** (fetched full text): names "reference answer score bias"
directly and reports it as the largest of three biases studied. Providing a
reference answer shifts the judge's score toward the reference's *own*
score — a reference scored 5/5 pulls judged outputs toward 5, a reference
scored 1–3 measurably degrades scoring accuracy for some judge models
(Qwen), with a fluctuation up to ~0.2 on the scoring scale for smaller
models (Qwen3-8B). That is a quantitative, non-folklore result: **putting an
expected answer in a judge's context moves the verdict toward confirming
it.** [LLM-as-a-judge validity in physics assessment (arXiv 2603.14732)](https://arxiv.org/abs/2603.14732) — **VERIFIED** existence and general
finding via fetch, specific numbers not extracted (PDF parse was partial):
names anchoring on reference materials/rubrics as a mechanism causing
systematic disagreement with human raters who scored without that anchor.
["Bias in the Loop" (arXiv 2604.16790)](https://arxiv.org/html/2604.16790v1)
— **VERIFIED** (fetched): does *not* test ground-truth-in-context directly —
its bias suite is prompt-injected cues (position, authority, sentiment,
verbosity) — but its methodology note that the baseline judge is told to
generate its own answer *before* seeing the item under judgment is itself
evidence the field treats pre-exposure to a candidate answer as a
contamination risk worth designing around, even where this particular paper
does not measure it.

**Direct answer to the brief's question: this is evidence-backed, not
folklore.** The mechanism diagnosis.md avoids — a model asked to verify a
claim against a fact set it can see will find what it was shown — has a
measured analogue in 2506.22316 (reference-answer score bias, ~0.2
magnitude) and a named-but-not-quantified analogue in 2603.14732 (anchoring
on reference materials skewing physics-assessment marking). Neither paper
studies callbench's *exact* task (three-state scoped-claim verification
against a closed fact set, rather than open-ended numeric scoring against a
rubric), so the transfer from "judge told a numeric reference score" to
"extractor kept blind to a categorical fact table" is a reasonable
extrapolation, not a citation-for-citation match — flag it **INFERRED** at
that boundary, not VERIFIED.

**4. Rubric / annotation-guideline design.**
[Artstein & Poesio, "Inter-Coder Agreement for Computational Linguistics"
(2008)](https://direct.mit.edu/coli/article/34/4/555/1999/Inter-Coder-Agreement-for-Computational)
— **VERIFIED** existence and general framing via search (not directly
fetched — **INFERRED** on specifics): the standard survey on measuring
annotator agreement in NLP, 1,648 citations, argues weighted alpha-like
coefficients suit corpus annotation better than raw kappa in many tasks. Its
practical maxim, widely repeated in applied annotation practice
(**INFERRED**, secondary sources): when two competent annotators disagree,
the guideline is the thing that's wrong, not the annotators — which is a
direct match for how diagnosis.md's fitment-status table was produced (the
keyword assertion's three failed fix rounds were the same signal: the rule,
not the phrasing, needed to change). A concrete match for callbench's own
open-question of a second `standard`/`optional`/`never-offered` case:
common annotation-practice guidance is to enumerate categories *with worked
examples* of borderline cases (nested entities, ambiguous attachment) rather
than leave the boundary to prose criteria, on the theory that examples are
what annotators actually pattern-match against. [Counting on Consensus (arXiv
2603.06865)](https://arxiv.org/abs/2603.06865) — **VERIFIED** existence via
search, not fetched (**INFERRED** on content) — a 2026 survey specifically on
choosing the right agreement metric for NLP annotation/evaluation tasks,
relevant if callbench ever wants to measure agreement between the
model-extracted record and a human's reading of the same transcript.

**5. Taxonomy completeness — the failure that broke the keyword assertion,
generalized.** No single source found in this pass gives a computable
completeness test; the two literatures below name the problem precisely and
both stop at "detect when you're outside the taxonomy," not "prove the
taxonomy is complete." **Grounded theory / theoretical saturation**
(**INFERRED**, standard qualitative-methods framing, multiple secondary
sources, not one paper): saturation is declared when further data stops
producing new categories — an empirical stopping rule, not a proof, and
researchers explicitly disagree on when it's been reached. Read against
diagnosis.md: the fact set's camera entry is labeled "high-confidence, not
conclusively enumerated" for exactly this reason — Audi's own service
literature never states the negative outright, so the fact set's authors
are inferring saturation (repeated failure to find a counterexample across
markets/years) rather than citing a source that states completeness. That is
the right epistemic posture for a `never-offered` entry, and it is also
unfalsifiable by construction until the ETKA/PR-code query diagnosis.md
already flags as the thing that would settle it. **Open-set recognition /
novel-class-discovery / OOD-detection** surveys — [OOD Detection: A
Task-Oriented Survey (arXiv 2409.11884)](https://arxiv.org/abs/2409.11884),
[OOD Detection in NLP (arXiv 2305.03236)](https://arxiv.org/abs/2305.03236),
[Novel Class Discovery: an Introduction (arXiv 2302.12028)](https://arxiv.org/abs/2302.12028)
— **VERIFIED** existence via search, content **INFERRED**: this literature's
target is detecting *that* an input falls outside the trained taxonomy, not
certifying the taxonomy covers everything real. Applied to callbench: the
fact set can be probed for coverage gaps (does every feature the caller's
scenarios might name have a status row?) but no cited method here proves a
negative — "this vehicle has no other option that overloads a probe word the
way rain-sensor/camera overload 'recalibration'." That check stays a search
task for a human (or an agent) against the parts catalog, the same way the
camera fact itself was settled: by an unsuccessful, deliberate attempt at
refutation, not a completeness proof.

**Does the published evidence support this design for a precision-critical
scoped-claim judgment?** Partially, and unevenly across the three moving
parts. The fact-blind extraction step is the best-supported piece: judge/
scorer contamination from a visible reference answer is measured, not
assumed (2506.22316, 2603.14732), so keeping the fact set out of the model's
context is a defensible reading of real evidence, not folklore, even though
no cited study runs callbench's exact task. The taxonomy-plus-model seam
(Llama Guard) is evidence that a taxonomy-driven classifier can generalize
across *related* categories it wasn't tuned on; it is not evidence about
structurally novel forks. The reject-option/open-set literature is where the
design is weakest: Chow's-rule-style abstention protects against low
*confidence*, not high-confidence *wrongness*, and nothing found in this
pass measures how often a fact-blind extractor would be confidently wrong on
an overloaded trade term rather than correctly uncertain.

**Strongest evidence-backed argument that this repeats the keyword mistake
in better clothes:** the taxonomy itself is still hand-authored and still
only covers what its authors imagined (three fitment statuses; four facts;
one has a confidence caveat, three are unsourced-but-plausible). The keyword
assertion failed because its author enumerated phrasings by hand and missed
what the trade actually said; the fitment-status table is the same act one
layer up — its author enumerated *features* by hand and could just as
plausibly miss one. Moving the point of failure from "unmatched phrasing"
to "uncovered feature" is a real improvement (the model, not a human, now
absorbs phrasing variance; a human still owns feature coverage, which is a
narrower and more auditable job) but it is not a different kind of failure,
and nothing surveyed in this pass — including the taxonomy-adaptation
evidence in Llama Guard — shows a taxonomy verified complete by any means
other than someone trying hard to break it and failing, which is exactly
the posture diagnosis.md already takes toward the camera fact and should
take toward the other three.

**What needs a probe, not more reading:** whether the fact-blind extractor,
run against ScoNe-shaped or trade-vocabulary-overloaded utterances *from
this domain* (not general NLI benchmarks), is confidently right, confidently
wrong, or abstains — the three-way split Chow's rule cannot distinguish from
the outside. No amount of further literature search resolves that; only a
probe against real or invented recalibration-ambiguous utterances can.

## False presuppositions and sycophancy — the probe's academic framing

Researched 2026-07-15 against [diagnosis.md](diagnosis.md)'s camera probe: the
bench asks a real shop's voice agent whether a 2009 Audi A3 needs a camera
recalibration, a feature the 8P generation never offered, so the question
itself carries a false presupposition by design. Five rounds of building that
probe happened before anyone searched for its academic name — the search this
section runs late, per [AGENTS.md](../AGENTS.md)'s own rule that a day spent
re-deriving a solved thing looks identical, from the inside, to a day spent
working. This section is upstream of the two above: [Scoped-claim
classification](#scoped-claim-classification--negation-abstention-and-the-fabrication-bait-assertion)
and [Closed-set classification, abstention, and judge bias](#closed-set-classification-abstention-and-judge-bias)
ask how to *classify* a turn once it exists; this section asks whether the
probe *design itself* — bait a false presupposition, fail an agent that
accepts it, fail an agent that asks a fork-resolving question about a fork
that does not exist — already has a name, a benchmark, and a published
failure-rate estimate in the literature. Not re-covered here: NLI, ScoNe,
HANS, Naik et al., Gururangan et al., Llama Guard, Chow's rule — see those two
sections.

**1. Presupposition verification in QA.**

- **Kim, Pavlick et al., "Which Linguist Invented the Lightbulb? Presupposition
  Verification for Question-Answering" (ACL 2021, [arXiv
  2101.00391](https://arxiv.org/abs/2101.00391)).** **VERIFIED** (fetched via
  ar5iv). Defines a false presupposition as a background assumption a question
  requires to hold — "Who is the current monarch of France?" presupposes a
  current French monarch — and builds a three-step pipeline (generate the
  presupposition, verify it, explain the failure) evaluated against 100
  unanswerable Natural Questions wh-questions and a 462-item verification set
  (234 dev / 228 test). **No aggregate acceptance-rate number is reported** —
  the paper argues its case with worked failures instead: Google answered
  "Which linguist invented the lightbulb?" with "Thomas Edison," Bing answered
  "When did Marie Curie discover Uranium?" with "1896." Both are real search
  engines accepting the presupposition and inventing an answer, which is
  structurally identical to a shop quoting $220 for a camera that isn't there
  — same shape, no camera. **Presupposition type: world facts, historical
  facts, and entity existence/possession** (a monarch existing, a stock symbol
  existing) — none is a product-catalog attribute.
- **Yu, Min, Zettlemoyer, Hajishirzi, "CREPE: Open-Domain Question Answering
  with False Presuppositions" (ACL 2023, [arXiv
  2211.17257](https://arxiv.org/abs/2211.17257)).** **VERIFIED** (fetched via
  ar5iv). Sources 8,400 real Reddit ELI5 questions (not invented by the
  researchers) and finds **25% carry a false presupposition** by the community's
  own top-voted answer — the closest published base rate for "how often does a
  real questioner's premise turn out to be wrong" in an open forum, though it
  is a rate of *questions asked*, not *models fooled*. Presupposition
  subtypes: false predicate (30%), false property (22%), false causal relation
  (22%), false clausal claim (14%), **false existential presupposition
  (6%)** — the last is the shape closest to callbench's camera bait (assuming
  an entity/feature exists when it doesn't), and it is the smallest, least-
  studied slice of their own taxonomy. **The best detection model reaches only
  67.1% F1** on flagging a false presupposition at all — meaning roughly a
  third of false-presupposition questions are not caught before any answering
  step even starts. Human evaluation additionally found models "rarely
  correctly satisfy users['] information need" once a presupposition is
  flagged, with corrections themselves sometimes containing new false claims.
  **No per-model "answered anyway" acceptance percentage is tabulated** —
  detection F1 and correction quality are the reported metrics, not an
  accept/reject rate, so CREPE is evidence that the *problem* is common and
  hard, not a direct estimate of the *failure rate on acceptance* that
  callbench's probe measures.
- **Kim, Htut, Bowman, Petty, "(QA)² : Question Answering with Questionable
  Assumptions" (ACL 2023, [arXiv
  2212.10003](https://arxiv.org/abs/2212.10003)).** **VERIFIED** (fetched via
  ar5iv). Sources 602 real Google-autocomplete search queries (570 eval), half
  carrying a false or unverifiable assumption, and scores end-to-end QA output
  by human-judged acceptability rather than a classifier label — closer to
  callbench's own PASS/FAIL grading of a live response than CREPE's
  detection-F1 framing. **The best system tested (text-davinci-003,
  in-context) reaches 56% acceptable responses on questionable-assumption
  questions, against 62% on valid ones** — a real but modest 6-point gap, not
  the wholesale collapse a reader might expect, and the paper's own framing is
  that this "leaves substantial headroom," not that models fail outright.
  Assumption types: 77% wh-word-associated, 15% definite-description
  existence/uniqueness — again all general-knowledge domains (movie plots,
  athlete trades), no product-catalog attribute case. **The paper does not
  evaluate or discuss models asking a clarifying question as a response
  strategy at all** — acceptable responses are scored as "point out the
  problem, repair, and answer"; a clarifying-question response is neither
  named as correct nor as an error, which is a direct, notable silence on
  research question 4 below.
- **Won't Get Fooled Again: Answering Questions with False Premises (Hu et
  al., ACL 2023, [aclanthology.org/2023.acl-long.309](https://aclanthology.org/2023.acl-long.309/)),
  FalseQA dataset.** **VERIFIED** existence and construction, **INFERRED** on
  numbers (only the abstract loaded cleanly; the PDF's baseline
  acceptance-rate table did not extract). 2,365 human-written false-premise
  questions (FPQs) with explanations and true-premise revisions; reports that
  pretrained LMs learn to discriminate FPQs after fine-tuning on as few as 256
  examples, which is a smaller sample-efficiency floor than the "many-shot"
  finding [Scoped-claim classification](#scoped-claim-classification--negation-abstention-and-the-fabrication-bait-assertion)
  §6 reports for ScoNe's scoped-negation contrast sets — worth a closer read
  before assuming the two findings transfer to each other, since FalseQA's
  premises (illustrated with "How many eyes does the sun have?") read as
  world-knowledge absurdities rather than scope-ambiguous negation.
- **Related, math-domain, found while chasing an unverifiable "86%
  acceptance" claim a search summary attributed to GPT-OSS-120B and could not
  be traced to a primary source — dropped rather than cited on secondhand
  authority:** Wang et al., "Don't Take the Premise for Granted: Evaluating
  the Premise Critique Ability of Large Language Models" ([arXiv
  2505.23715](https://arxiv.org/html/2505.23715v1)). **VERIFIED** (fetched).
  Not a QA-presupposition paper — it injects flawed premises into math word
  problems and measures a "Proactive Premise Critique Rate" (does the model
  flag the flaw before solving). Measured PPCR: GPT-4o 11.0%, DeepSeek-R1
  19.6%, Llama-4-Maverick-17B 27.2%, Gemini-2.0-flash-thinking 38.2%,
  Claude-3.7-Sonnet 36.2%, DeepSeek-V3 40.5% — **every model tested proactively
  catches a planted false premise well under half the time**, in a domain
  (arithmetic) with none of the negation-scope or trade-vocabulary ambiguity
  this project's own transcripts carry. Cited for the direction of the number,
  not the domain match: even in an unambiguous, single-fact domain, models
  overwhelmingly solve past a flawed premise rather than name it.

**Cross-cutting read on research question 1's crux — does the literature find
that models accept false presuppositions rather than reject them, and at what
rate — plus the product-attribute question:** yes, consistently, across every
paper fetched, with rates that vary by task shape rather than converging on
one number: CREPE's 67.1% F1 ceiling implies roughly a third missed outright;
(QA)² finds a real but modest 6-point acceptability gap; the premise-critique
paper finds 11-40.5% proactive-flag rates in an unrelated domain. **No
fetched source studies a presupposition about a product attribute** — every
dataset here is built from open-domain world knowledge (historical facts,
Reddit ELI5 science questions, autocomplete trivia, arithmetic) or, in
FalseQA's illustrative example, plain absurdity. None resembles "does this
specific 2009 vehicle, identified by VIN-adjacent facts, have this specific
hardware option" — a presupposition whose truth value depends on a narrow,
sourced catalog fact rather than general world knowledge. That gap is
addressed directly in §5 below.

**2. Sycophancy.**

**Sharma et al., "Towards Understanding Sycophancy in Language Models"
(Anthropic, [arXiv 2310.13548](https://arxiv.org/abs/2310.13548)).**
**VERIFIED** (fetched via ar5iv). Defines sycophancy as "responses that match
user beliefs over truthful ones" and measures it three ways: feedback
sycophancy (rating a user's own work more positively when told the user likes
it, ~85% positivity under some prompts), answer sycophancy (a user
suggesting an answer, correct or not, shifts the model's stated answer —
suggesting a *wrong* answer costs up to 27 accuracy points on LLaMA 2, GPT-4
is the most robust model tested), and mimicry sycophancy (repeating an
incorrect attribution the user supplied without correcting it). **The paper
treats accepting a false user premise as sycophancy itself, not a distinct,
separately-named phenomenon** — there is no separate "false-premise
acceptance" category set apart from the three sycophancy measures above.
**Preference-model and human evidence on why this persists:** preference
models favor a convincingly-written sycophantic response over a truthful one
a non-negligible fraction of the time, and on the hardest misconception
items human raters preferred the sycophantic response over the correct one in
over 35% of comparisons — RLHF's own reward signal is implicated, not just
model capability.

**Question vs. assertion — the maintainer's specific concern, and the honest
gap in the fetched evidence.** Sharma et al.'s own experiments do not run
this comparison directly: the "are you sure?" challenge is a question, the
answer-sycophancy setup is a hedge-plus-assertion ("I think the answer is X,
but I'm not sure"), and the paper does not report accuracy or acceptance
broken out by which grammatical form carried the false premise. **The closest
direct evidence found is a different paper, not Sharma et al.:** Zhang et
al., "Measuring Sycophancy of Language Models in Multi-turn Dialogues"
(EMNLP Findings 2025, [arXiv 2505.23840](https://arxiv.org/html/2505.23840v4)).
**VERIFIED** (fetched). Reuses **CREPE's own false-presupposition questions**,
delivered as ordinary questions in a natural multi-turn conversation (its own
worked example: "Are there even people living there?", about Crimea) —
i.e. this paper's whole setup is presupposition-carried-by-question, not
assertion. Its §6.2 ("Ignorance or Sycophancy?") finding is the single most
useful data point for callbench's design: when a model failed to flag a false
presupposition inside the natural conversational turn, then was *separately,
directly* asked "true or false?" about the same presupposition stripped of
conversational framing, **51%-75% of models correctly identified it as
false** — meaning the knowledge was present the whole time and conversational
framing, not ignorance, suppressed it. The paper reads this as sycophancy
proper (conversational pressure overriding known-correct knowledge), which
answers the "same phenomenon or distinct" half of research question 2:
**accepting a false premise stated as a question is sycophancy's own
mechanism in this paper's design, not a separate failure mode requiring its
own name.** What it does *not* answer — because nothing fetched in this pass
compares question-framing against assertion-framing on matched content — is
whether asking "does it need a camera recalibration?" is *more* or *less*
sycophancy-inducing than asserting "it needs a camera recalibration." **OPEN
QUESTION**, and one this project could answer cheaply: the caller's script
already has both forms available (the fabrication-bait probe is phrased as a
question; a trivial variant restates it as a flat assertion), so a same-target,
matched-content A/B is a probe this bench could run itself rather than one
that needs more literature.

**3. Unanswerable questions and abstention — a different task, not a
relabeling of the same one.**

**Rajpurkar, Jia, Liang, "Know What You Don't Know: Unanswerable Questions
for SQuAD" (SQuAD 2.0, [arXiv 1806.03822](https://arxiv.org/abs/1806.03822)).**
**VERIFIED** (search synthesis of the paper and its own abstract/tables, not a
full fetch). Over 50,000 unanswerable questions, crowd-written adversarially
to *look* answerable given a specific paragraph, added alongside SQuAD 1.1's
answerable set. A strong 86% F1 (SQuAD 1.1) system drops to 66% F1 on 2.0; the
paper's own framing is that the paragraph genuinely lacks the fact the
question asks about, and the system's job is to notice the absence and
abstain rather than guess a plausible-looking span.

**These are related tasks, not the same one, and conflating them would
mis-specify what callbench measures.** SQuAD 2.0's unanswerability is a
*missing-evidence* problem: the paragraph is silent on the question, and any
answer offered is unsupported by the given context, but nothing in the
question itself is false — a different paragraph could easily answer it. A
false-presupposition question is a *contradicted-evidence* problem: the
question is not silent-on but actively wrong about a background fact ("this
car has a camera"), and no amount of additional context makes the
presupposition true. This distinction has a direct instance inside
diagnosis.md's own table: the row where the caller says a feature "does not"
apply and the agent asks about it anyway is scored **FAIL, not
INCONCLUSIVE** — precisely because the ground truth was available and
contradicted, not merely absent. Collapsing the two into one "abstain here"
category would blur that FAIL back into an INCONCLUSIVE, which the fitment
table explicitly refuses to do. **The published discourse in this area
recognizes the distinction too, not just this project:** [Two Axes of LLM
Abstention: Answer Correctness and Question Answerability (arXiv
2607.08456)](https://arxiv.org/pdf/2607.08456) frames abstention along two
separate axes (whether the *question* is answerable at all, and whether a
given *answer* is correct) rather than one — **VERIFIED** existence and
framing via its own title and abstract; the PDF's full body did not extract
cleanly in this pass, so the paper's specific numbers are **OPEN QUESTION**,
but the axis-separation itself is exactly the SQuAD-2.0-vs-CREPE distinction
made above, independently named by a different paper.

**4. The distinguishing question — does any published work treat a
clarifying question about a nonexistent entity as an error, rather than as
good practice?**

**No published work found in this pass treats it that way, and that absence
was searched for directly, not assumed.** Two distinct literatures were
checked and both come up empty on this exact claim:

- **Clarification-question generation in dialogue and IR.** The surveyed
  literature (ambiguous-query resolution, clarifying-question generation for
  conversational search, entity-level clarification in dialogue systems) is
  uniformly framed around clarification as a *repair* for genuine ambiguity —
  a question resolves which of several real referents the user meant, or
  fills a genuinely missing slot. **No source found in this pass scores a
  clarifying question as *wrong* because its subject does not exist** — the
  failure modes the literature discusses are a system failing to *ask* when
  it should have, or asking about the wrong slot among several real ones,
  never asking a well-formed question about an entity with no referent at
  all. This is consistent with how these systems are typically evaluated:
  against a closed slot schema or an entity graph where every candidate slot
  is, by construction, a real one — the evaluation setup structurally cannot
  produce diagnosis.md's exact case (a slot that looks real from the wording
  but has no filler in this system's world), because the schema was never
  built to contain a fake slot to test against.
- **Presupposition-QA and the clarification option specifically.** (QA)²
  (§1 above) is the one paper in this pass whose task shape includes a model
  that *could* choose to ask rather than answer, and its own evaluator
  neither scores a clarifying-question response as acceptable nor names it as
  an error — the response taxonomy is silent on it entirely, treating
  "point out the flaw and answer" as the only credited move.

**This is a genuine, load-bearing gap, and the honest framing matters
because three independent reviewers have called the maintainer's rule
indefensible.** The absence of counter-evidence is not the same as
confirmation — it means no fetched source *validates* the rule and equally
none *contradicts* it; the rule stands on diagnosis.md's own argument (a
question about something that cannot exist is the observable signature of
missing vehicle context, not a competence signal) rather than on any
external authority. **What the literature does supply, obliquely, is a
reason the gap exists rather than evidence closing it:** every clarification-
question benchmark surveyed here is built over a closed set of *real* slots
or entities, so "ask about a slot that has no filler in the ground truth at
all" is outside every evaluated distribution, not a case those benchmarks
were shown to handle correctly and simply weren't cited — it is a case they
structurally never construct. Diagnosis.md's `never-offered` fitment status
is, functionally, the schema move those benchmarks skip: naming that a slot
can be absent by construction, not merely unfilled, and grading a question
about it accordingly. **OPEN QUESTION for a probe, not more reading:** whether
a purpose-built adversarial clarification-question benchmark exists somewhere
this pass's search terms missed (candidate future search terms: "spurious
slot," "non-existent slot," "hallucinated slot," "fictitious entity
clarification") — the searches run here (clarification + nonexistent entity,
clarification + presupposition failure) came back empty, which is evidence of
absence within this pass's search budget, not proof the literature has never
touched it.

**5. Domain analogue — product-attribute QA.**

**The catalog-grounded shape callbench actually needs was not found solved
in public research; the closest work is attribute-value *extraction*, a
different task from attribute-presupposition *verification*.**

- **Product Question Answering in E-Commerce: A Survey (ACL 2023,
  [aclanthology.org/2023.acl-long.667](https://aclanthology.org/2023.acl-long.667/)).**
  **VERIFIED** existence and its own stated framing (categorizes PQA into four
  answer-form problem settings) via the abstract; the PDF's body did not
  extract as readable text in two attempts in this pass, so its taxonomy
  detail, and specifically whether it discusses a never-offered/optional/
  standard-style distinction, is an **OPEN QUESTION** left for a follow-up
  fetch or a direct PDF read, not a confirmed gap.
- **Amazon product-QA datasets (AmazonQA, SemiPQA, hetPQA).** **VERIFIED**
  existence and scale via search synthesis (not fetched in full): AmazonQA
  pairs 923k questions against 3.6M answers and 14M reviews across 156k
  products, and marks each question answerable-or-not from the available
  reviews; SemiPQA covers 258 attribute types with a held-out "unseen
  attribute" split. **The answerable/unanswerable label in these datasets
  is evidentiary, not ontological** — a question is "unanswerable" because no
  review or listing happens to mention it, the SQuAD-2.0 shape (§3 above), not
  because the attribute is catalog-verified never to exist on that product.
  Nothing found in this pass distinguishes "nobody happened to write a review
  mentioning the sunroof" from "this trim was never sold with a sunroof" —
  which is exactly diagnosis.md's `optional`-vs-`never-offered` split, and
  exactly the distinction the caller's camera bait depends on. This is an
  **INFERRED** reading of dataset descriptions, not a claim verified against
  the raw data or a full paper fetch.
- **Attribute-value extraction and hallucination.** A cluster of recent
  papers (TACLR, [arXiv 2501.03835](https://arxiv.org/pdf/2501.03835);
  EAVE, [arXiv 2406.06839](https://arxiv.org/html/2406.06839v1);
  multimodal/visual extraction work) treat hallucination as a known failure
  mode of LLM-based attribute extraction — a model inventing a value for an
  attribute not stated in the product page. **VERIFIED** existence of the
  hallucination framing via search synthesis; specific mitigation numbers not
  fetched in this pass (**OPEN QUESTION**). **This is the nearest true analogue
  found to callbench's fabrication-bait probe** — an LLM asked to fill an
  attribute slot invents a value rather than reporting absence — but the task
  shape is still extraction *from a document the model can see* (the product
  page is in context), not verification of a spoken claim *against a fact set
  the model is deliberately kept blind to*, which is diagnosis.md's whole
  design (see "Where the facts live, and why not in the prompt"). No fetched
  source frames catalog-attribute hallucination as a *dialogue*-turn
  verification problem the way callbench does; it is uniformly framed as a
  generation-time extraction problem.

**Direct answer to research question 5: no public dataset or method found in
this pass handles the never-offered / optional / standard three-way split
callbench's fact set encodes.** Every product-QA resource surveyed treats
"unanswerable" as an evidentiary gap in the source document, the SQuAD-2.0
shape, not a catalog-verified ontological absence. The gap between
"catalog-verified never-offered" and "not mentioned in this document" is the
single most reusable idea diagnosis.md's fact-set design contributes that was
*not* found already solved in the literature searched here — worth stating
plainly rather than papering over with a citation that only partially fits.

---

**Does the presupposition literature give callbench a better framing, a
benchmark to calibrate against, or a published failure-rate estimate?**

**A better framing: yes, and it was worth the search.** "False presupposition
question-answering" is the exact, citable name for what the camera probe
does, distinct from ordinary adversarial testing or plain fact-checking —
CREPE's own existential-presupposition subtype (6% of its taxonomy) and (QA)²'s
"questionable assumption" framing are the closest published vocabulary for
"a question whose premise a competent answerer must reject before answering
anything else." That name did not exist in [diagnosis.md](diagnosis.md) or
[probes.md](probes.md) before this pass — both call it "fabrication bait" or
"the camera probe," a project-local name for a phenomenon with a decade of
published study under a different one. Sycophancy is the second half of the
name: the multi-turn sycophancy paper's own §6.2 finding (§2 above) — that
models often *know* the correct fact and suppress it under conversational
framing — is the mechanism most likely operating when a shop's voice agent
accepts the camera bait, as distinct from the shop's agent simply never
having the vehicle fact in the first place. Both explanations produce the
same observed FAIL, and diagnosis.md's own design (facts never enter the
model's context, so the agent under test can't be shown to have "known" the
answer, only shown to have said or not said it) is explicitly agnostic
between them — the literature confirms that agnosticism is the right
posture, not just a modeling convenience: the sycophancy-vs-ignorance
distinction is real and measured, and callbench's transcript-only record
cannot resolve it either way, which matches how diagnosis.md already treats
"why" the target failed as out of scope for a finding.

**A benchmark to calibrate against: not directly, and this is worth stating
plainly rather than stretching a fit.** CREPE and (QA)² are the closest
published benchmarks, and neither is usable as a calibration set for
callbench's judge or extractor without adaptation — both are open-domain
world-knowledge QA, evaluated by a retrieval-grounded or human-rated
correctness metric, not a closed four-fact catalog scored by a
deterministically-coded three-state rule. A model tuned or validated against
CREPE's Reddit-science presuppositions has no guarantee of transferring to
"does an 8P-chassis Audi have a factory front camera," the same domain-shift
caution [Scoped-claim classification](#scoped-claim-classification--negation-abstention-and-the-fabrication-bait-assertion)
§6 already raises about fine-tuning on the simulator's own scripted text —
tuning to *any* fixed distribution, including a published one, risks the
same trap if the target domain (voice-agent quotes for a specific vehicle
platform) differs enough from the benchmark's domain (general trivia).

**A published failure-rate estimate: a range, not a number, and the range is
wide enough that it bounds expectations rather than predicting a result.**
Across every fetched source that reports a comparable figure: CREPE's
detection ceiling implies roughly a third of false-presupposition questions
go unflagged; (QA)² finds a 6-point acceptability gap between
questionable-assumption and valid questions; the math-domain premise-critique
paper finds 11%-40.5% proactive-flag rates; the multi-turn sycophancy paper
finds the *opposite*-direction number (51%-75% correct when asked directly,
implying a large drop under conversational framing, though the paper does not
tabulate the conversational-failure rate as a single percentage). None of
these numbers is callbench's number — none was measured against a phone call,
a voice agent, a shop's business incentive to quote a fee, or a
catalog-attribute presupposition — but together they establish that "a
sizable minority to a slim majority of systems accept a well-constructed
false presupposition" is the documented range across every domain tested so
far, which is the right prior to hold walking into a live call, not a
guarantee about this specific shop.

**The strongest argument that this framing does not fit, stated fairly, not
dismissed.** Every benchmark and paper fetched in this pass is open-domain —
Reddit trivia, search-engine autocomplete, Wikipedia-adjacent facts, or
arithmetic — and every one is text-in/text-out, evaluated by a retrieval
corpus, a human rater, or a symbolic checker, never a live spoken exchange
with a commercial party who has a financial incentive in the answer. Callbench's
task differs on at least three axes none of the fetched literature crosses at
once: **(a) the ground truth is a narrow, low-resource catalog fact** (one
service bulletin, a parts-catalog page) rather than something a retrieval
corpus like Wikipedia or Google Search reliably contains — FActScore's own
documented failure mode ([Verification-first
prompting](#verification-first-prompting--decomposition-independence-and-self-checking)
§2) is exactly this: 10% of its "unsupported" verdicts were true facts simply
absent from the corpus, and diagnosis.md's own camera fact is exactly the
kind of statement a general retrieval corpus is unlikely to state as a
negative; **(b) the respondent has a business incentive to find work**,
which no fetched paper's task setup creates — Google, Bing, and Reddit
commenters have no revenue at stake in whether a lightbulb has an inventor or
a windshield needs a sensor; **(c) the channel is live spoken dialogue under
real-time pressure**, not a batch text query, which is the whole reason this
project exists as a phone-call bench rather than a text-QA harness in the
first place. The presupposition-QA literature establishes that the *general
cognitive failure* — accepting a well-formed question's false premise — is
real, common, and understudied in exactly the shape (existential/attribute
presuppositions) that matters here. It does not establish, and nothing
fetched claims, that the failure rate transfers to a domain with a narrow
private catalog, a paying customer, and a financial incentive to say yes.

**Single most useful source for this project, given all of the above:** the
multi-turn sycophancy paper's CREPE-derived §6.2 finding (Zhang et al., [arXiv
2505.23840](https://arxiv.org/html/2505.23840v4)) — not for its numbers, which
don't transfer, but for its method: separating "does the model know the fact"
from "does the model say the fact" by asking the same question two ways, once
embedded in conversational pressure and once stripped of it. That is a cheap,
concrete probe design callbench could run on its own target directly (ask the
camera question live, then, in a separate call, ask the shop point-blank
whether the 8P had a factory camera) to get the same ignorance-vs-sycophancy
read this project's transcript-only record cannot currently produce — flagged
here as a probe idea for the maintainer, not built.

## Dialogue state tracking and KB-grounded verification

Researched 2026-07-15 against a direct question: `diagnosis.md`'s per-turn
record (`subject`, `speechAct`, `scope`, `polarity`, `fee`), extracted blind
to the fact set and joined to it by deterministic code, resembles dialogue
state tracking (DST) crossed with knowledge-base-grounded response
verification. Did callbench re-derive either from first principles when a
named, published shape already existed? This section is scoped to the DST /
dialogue-act / KB-verification literatures specifically; it does not repeat
the [Scoped-claim classification](#scoped-claim-classification--negation-abstention-and-the-fabrication-bait-assertion)
section's NLI/negation findings or the [Verification-first
prompting](#verification-first-prompting--decomposition-independence-and-self-checking)
section's CoVe/decomposition findings — both are cited by reference below,
not restated. It also does not repeat the [Closed-set
classification](#closed-set-classification-abstention-and-judge-bias)
section's taxonomy-completeness and judge-bias findings.

**1. Dialogue state tracking — MultiWOZ, SGD, and the schema-guided
paradigm.**

- **MultiWOZ.** **VERIFIED** (Budzianowski et al., [arXiv
  1810.00278](https://arxiv.org/abs/1810.00278), fetched via
  [ar5iv](https://ar5iv.labs.arxiv.org/html/1810.00278)). 10,438 dialogues
  across 7 domains, 24 slots, annotated with a per-turn dialogue-act label
  (13 act types — inform, request, recommend, offer, select, not_found, and
  others) alongside the belief state. **No scope field.** The ontology has
  no equivalent of callbench's `scope` — domain is attached to an act
  (`inform(domain=hotel,...)`) but nothing distinguishes a claim about *this*
  entity from a claim about entities generally; the task never needs that
  distinction because MultiWOZ's dialogue state is the user's stated
  preference, not a claim graded against a fact the user doesn't have.
- **SGD (Schema-Guided Dialogue).** **VERIFIED** (Rastogi et al., [arXiv
  1909.05855](https://arxiv.org/abs/1909.05855), fetched via ar5iv). The
  schema — slot names, intents, natural-language descriptions — is "passed
  as input," not baked into the model, which is explicitly what enables
  "zero-shot generalization to new APIs." **This is the same move callbench
  made refactoring `subject` to be drawn from the fact set's feature list
  rather than a hardcoded enum** — SGD is the named precedent for
  schema-as-data, and the fact that a research paper built an entire
  benchmark to prove this generalizes is evidence the choice was sound, not
  merely convenient. **Slot status is a 3-way classification** — `none`
  (unchanged since last turn), `dontcare`, `active` — the nearest DST
  analogue to callbench's `unnamed`. But the fit is partial: SGD's `none`
  answers "did this turn update a slot the schema already told the model to
  track," which presupposes the slot is already selected; callbench's
  `unnamed` answers a prior question — "did this turn name *any* feature at
  all" — because callbench has no multi-turn state to carry forward and no
  policy consuming the state to select what to ask next. SGD is DST in the
  full sense (a belief state persists and accumulates across a dialogue);
  callbench's record does not persist across turns and is not consumed by a
  policy — it is closer to a single-turn NLU decode (intent + requested-slot
  detection, the "active intent" and "requested slots" components SGD's own
  state also contains) than to full state tracking. **No scope field in SGD
  either** — same absence as MultiWOZ, for the same reason: SGD's state
  answers "what does the user want," never "is this claim true of the thing
  under discussion."
- **DSTC lineage.** **INFERRED** (standard field knowledge, not
  independently fetched this pass): the Dialogue State Tracking Challenge
  series (Williams et al., starting 2013) is where "dialogue state tracking"
  as a named task originates, predating MultiWOZ and SGD; both inherit its
  slot-value framing rather than inventing it.

**Direct answer to the "is our record a DST schema" half of research
question 1: partially, and only the shape, not the job.** Both `subject`
(schema-as-data, matching SGD) and the per-turn extraction pattern (matching
MultiWOZ's dialogue-act annotation, in spirit) have real DST precedent.
`scope` does not — no DST schema found in this pass carries a "whose entity"
axis, because no DST task grades a claim's truth against an oracle the
speaker doesn't have access to; DST tracks what the *user* wants, which is
definitionally true by construction (the user's stated goal cannot be
"wrong"). callbench's `scope` field exists because its speaker's claim
*can* be wrong, which DST's speaker's never is.

**2. Dialogue act / speech act taxonomies — DAMSL, SWBD-DAMSL, ISO
24617-2.** **VERIFIED (search synthesis; primary sources not directly
fetched this pass — Jurafsky et al.'s DAMSL/SWBD-DAMSL papers and Bunt et
al.'s ISO documents are pre-arXiv-era PDFs, confirmed via
[web.stanford.edu/~jurafsky/ws97/CL-dialog.pdf](https://web.stanford.edu/~jurafsky/ws97/CL-dialog.pdf)
and [people.ict.usc.edu/~traum/Papers/Buntetal-ISO24617-2.pdf](https://people.ict.usc.edu/~traum/Papers/Buntetal-ISO24617-2.pdf)
search results, content read from search summaries not the full PDFs —
flagged INFERRED where specific, VERIFIED only for the documents' existence
and headline framing).**

SWBD-DAMSL started as ~50 basic tags (STATEMENT, QUESTION, ...) crossed with
orthogonal diacritics (Task-Management, Communication-Management), collapsed
for tractable inter-annotator agreement to a 42-tag mutually-exclusive set —
the version most automatic dialogue-act taggers target. ISO 24617-2
generalizes this into a published international standard: dialogue acts are
"functional segments" carrying a communicative function plus a "dimension"
(Task, Feedback, Social Obligation, Turn/Time Management, ...), explicitly
multidimensional — a single utterance can carry more than one function
across dimensions simultaneously, which is closer to callbench's
`speechAct` × `scope` cross than SWBD-DAMSL's flat 42-way tag is.

**Neither taxonomy has scope as a dimension.** Both are general-purpose
discourse-structure schemes — what kind of conversational move is this
(inform, request, feedback, commit) — not fact-verification schemes; neither
was built to distinguish "asserts a rule about the class" from "asserts a
fact about this instance," because that distinction is not a
discourse-structure question, it is a question about what the claim is
*about*, which sits a level below dialogue-act taxonomy entirely (a
STATEMENT/Inform act can carry either scope with no change to its
dialogue-act tag). **`speechAct`'s categories partially map onto ISO
24617-2's Task dimension** — `asserts`≈Inform/Statement, `asks`≈Info-Request,
`defers`≈a non-committal response lacking a direct ISO analogue, `denies`≈a
negated Inform with no dedicated ISO tag of its own (negation is carried in
the propositional content, not the communicative function, in ISO 24617-2's
framing) — **`other` has no standard analogue by design; it is
callbench's own reject class.** Adopting ISO 24617-2 wholesale would buy a
published inter-annotator-agreement track record and existing tooling
(DialogBank) at the cost of a taxonomy sized for general discourse analysis,
most of which (Social Obligation, Turn Management, most of Feedback) is
irrelevant to fabrication detection; the four-plus-one `speechAct` categories
already are the ISO Task dimension's assert/deny/request cases narrowed to
what this task needs, which is the same "generalize over specify" tradeoff
AGENTS.md already names, not an oversight to fix.

**3. KB-grounded dialogue and faithfulness — Q², FaithDial, BEGIN, and the
structured-vs-text gap.**

- **Q².** **VERIFIED** (Honovich et al., [arXiv
  2104.08202](https://arxiv.org/abs/2104.08202), fetched via ar5iv). Pipeline:
  generate questions from the response's entities/noun phrases, answer them
  against the knowledge source, compare the response's implied answer to the
  knowledge's answer via NLI rather than token overlap. **Operates only over
  free text** (Wikipedia sentences, Topical-Chat articles, persona
  descriptions) — "no structured fact tables or attribute-value KBs are
  discussed." Best correlation: 0.98 Spearman (system-level, Wizard of
  Wikipedia) vs. 0.92 for an end-to-end NLI baseline. **No treatment of
  negation or absence claims** — the exact shape of callbench's camera fact
  (a `never-offered` status is a universal-negative claim) is outside what Q²
  was built or evaluated against.
- **FaithDial / BEGIN.** **VERIFIED** (Dziri et al., [arXiv
  2204.10757](https://arxiv.org/abs/2204.10757), fetched via ar5iv).
  Faithfulness is defined as entailment by a knowledge subset (a Wizard of
  Wikipedia snippet, one sentence, ~27 tokens); the BEGIN taxonomy it uses
  scores full/partial hallucination, generic, and uncooperative — again
  **free text only, no structured attribute verification**, and no
  discussion of absence claims.
- **The structured case does exist, but as a much harder, unsolved
  benchmark, not a mature tool.** **VERIFIED** (FEVEROUS, [arXiv
  2106.05707](https://arxiv.org/abs/2106.05707), existence and headline
  numbers via search synthesis, not directly fetched this pass — flagged
  accordingly). FEVEROUS extends FEVER (below) to verify claims against
  *both* Wikipedia text and table cells — the closest published analogue
  found to "verify a claim about an entity attribute against a structured
  table," which is exactly what callbench's deterministic fitment-status
  lookup does. Its own reported baseline gets the evidence *and* the verdict
  right for only 18% of claims — direct evidence that entity-attribute
  verification against structured data is not a solved, off-the-shelf
  capability in the general case, even though the task shape is named and
  benchmarked.
- **The nearer TOD-specific structured-KB precedent grounds generation, not
  verification.** **VERIFIED (existence via search synthesis; full-text
  detail not extracted — the fetched abstract did not surface the table
  schema or grounding mechanism in enough detail to quote, flagged
  accordingly).** Eric & Manning's Key-Value Retrieval Networks ([arXiv
  1705.05414](https://arxiv.org/abs/1705.05414), KVRET) generate task-oriented
  responses grounded in a structured, attribute-value knowledge base (in-car
  calendar/weather/POI data) via a key-value retrieval mechanism. This is
  the TOD literature's structured-KB-grounding precedent, but it is
  generation-side (produce a response consistent with the KB) not
  verification-side (grade whether an already-produced response, from a
  system callbench does not control, is consistent with a KB) — the
  direction is reversed from callbench's task, which never generates
  anything, only judges.

**Direct answer to research question 3: no source found in this pass does
what callbench does — verify a natural-language claim about a specific
entity attribute against a structured fact table, with an explicit
three-state (not two-state) outcome.** The closest thing (FEVEROUS) is real,
named, and benchmarked, but young and hard (18% baseline), and comes from
the fact-checking literature, not the dialogue literature — it verifies
claims about Wikipedia infoboxes, not turns in a live conversation. No
standard metric for this exact combination (structured KB + dialogue turn +
three-state outcome) was found; **OPEN QUESTION**, and plausibly does not
exist yet as a named, converged-on metric rather than one this search missed.

**4. Extract-then-verify vs. end-to-end — is the two-stage split an
established pattern with a name?** **VERIFIED** (FEVER, Thorne et al.,
[arXiv 1803.05355](https://arxiv.org/abs/1803.05355), fetched via ar5iv).
FEVER's own pipeline is three stages — document retrieval, evidence-sentence
selection, then entailment classification — described in the paper as "one
possible approach," **not given a single fixed name like "extract-then-verify"
in the paper itself.** The field converged on calling this shape "retrieve
(-and-)verify" or "pipeline" fact-checking in later survey literature
(**INFERRED**, not independently fetched this pass); FEVEROUS is the direct
descendant that adds structured evidence. FEVER's own three-way label —
Supported / Refuted / NotEnoughInfo — is a direct precedent for a three-state
outcome under a name other than callbench's PASS/FAIL/INCONCLUSIVE, arrived
at independently in an unrelated task (fact-checking Wikipedia claims, not
grading a voice agent), which is corroborating evidence the third state is
the right shape for adversarial verification generally, not just for this
project's own reasoning about abstention (already covered from the
selective-prediction angle in [Scoped-claim
classification](#scoped-claim-classification--negation-abstention-and-the-fabrication-bait-assertion)
§3).

**So: yes, extract-then-verify (there called retrieve-then-verify, or just
"the FEVER pipeline") is an established, named, and heavily benchmarked
pattern — just not under callbench's name for it, and not from the dialogue
literature.** It is the fact-checking field's default architecture, not a
callbench invention; what callbench adds that FEVER's version doesn't have
is the fact-blindness constraint on the extraction step (§6 below), which
FEVER's evidence-retrieval stage has no equivalent need for, because FEVER's
retriever is not itself a semantic judge at risk of confirmation bias the
way an LLM extractor shown the oracle would be.

**5. Simulated users and evaluating a deployed system the tester does not
own.**

- **Classical TOD evaluation simulates the user to train or test a system
  the researcher controls.** **VERIFIED (search synthesis):** Schatzmann,
  Young et al.'s agenda-based user simulator (2007; extended 2009) is the
  standard reference — a hidden-agenda stack drives simulated user turns
  against a dialogue manager under development, explicitly for bootstrapping
  or evaluating *that* system, which the researcher owns and can instrument
  internally. Schatzmann & Young's own 2009 finding, reported in the search
  synthesis, is itself a caution relevant to callbench's own EVA
  comparison: "a superior result in automatic metrics does not guarantee a
  better result in the real situation" — simulated-user evaluation and
  real-user evaluation can diverge, a gap callbench's own "no real utterance
  from the target has ever been observed" open item (`diagnosis.md`) already
  names independently.
- **The academic line and callbench's line differ on a structural axis this
  search did not find bridged in a published TOD paper: who owns the system
  under test.** Every DST/user-simulation paper found in this pass (SGD,
  MultiWOZ, Schatzmann) evaluates a system the *same* research group trained
  or built, with full internal access (the true belief state, the training
  data, the model weights) available for scoring — the "static corpus /
  researcher-controlled system" pattern **VERIFIED** for VoiceAgentEval
  ([arXiv 2510.21244](https://arxiv.org/pdf/2510.21244), fetched) as well: it
  tests named models (Claude, GPT-4, Gemini) against predefined scenarios
  the benchmark authors wrote, not a live call into a business's own,
  unowned deployment. This is the same category the [Voice-agent
  testing](#voice-agent-testing--the-closest-prior-art) section's EVA
  citation already sits in — bot-to-bot audio, but still a system the
  evaluator can instrument or at minimum chose and configured. **No source
  found in this or the prior EVA-focused pass evaluates a voice agent by
  dialing a number the tester does not operate and has no instrumentation
  access to** — every academic and commercial system found (EVA, VoiceAgentEval,
  Hamming, Coval, Cekura, per the Voice-agent-testing section) tests systems
  the evaluator built, deployed, or was given API/instrumentation access to.
  callbench's product invariant — "a system it does not own," a business's
  live phone line with no cooperation, no shared logs, no ground-truth
  belief state to compare against — is not a variant of the published
  academic evaluation setup; it is closer in spirit to a compliance mystery
  shop than to a TOD benchmark, and **this specific configuration (opaque
  target, phone-only access, human-gated dial) was not found published in
  the academic literature searched this pass.** **OPEN QUESTION**, not a
  confirmed gap — it may exist in venues (telecom industry QA, regulatory
  compliance testing) this academic-focused pass did not search.

**Direct answer to research question 5: the academic line (DST, agenda-based
simulation, TOD benchmarks) and callbench's line are related but not the
same, and the difference is not cosmetic.** Academic TOD evaluation, EVA
included, evaluates a system the evaluator has some form of access to or
control over; callbench evaluates a system it has neither. That difference
changes what "ground truth" even means: academic DST's ground truth is the
simulated user's own known goal (unimpeachable by construction); callbench's
ground truth is a fact about a physical vehicle the target itself may not
have correct, which is why `diagnosis.md`'s own outcome table has to reason
about *confidence* in the fact set (the camera row's "high, not conclusive")
in a way no DST paper found here needs to, because no DST paper's ground
truth is externally falsifiable the way a vehicle's build sheet is.

---

**Design question: is callbench's record a reinvention of DST, and should
it adopt an existing schema/taxonomy? Is extract-then-verify an established
pattern with a published name?**

**Partial reinvention of shape, not of task.** callbench independently
arrived at two things DST/SGD already named and validated — schema-as-data
(SGD) and per-turn structured extraction over a free-text taxonomy
(MultiWOZ's dialogue acts, ISO 24617-2's communicative functions) — without
having read either before building, which is exactly the "day spent
re-deriving a solved thing" AGENTS.md warns against for those two specific
design choices. Where it did **not** reinvent something that already
existed: the `scope` field. No DST schema, no dialogue-act taxonomy, and no
KB-grounded-faithfulness paper found in this pass carries an equivalent,
because none of those tasks needs to distinguish a class-level claim from an
instance-level one — that distinction is manufactured by the specific
combination callbench sits in (a claim that can be false, checked against a
fact table the claim's own speaker cannot be assumed to have gotten right).
`scope` is not a gap in the search; it is evidence the task is not fully
inside any one searched literature.

**Should it adopt an existing taxonomy?** For `speechAct`: partial adoption
is worth considering — ISO 24617-2's Task-dimension categories are a
published superset with real inter-annotator-agreement tooling behind them,
and narrowing to the four-plus-`other` set callbench already uses is a
defensible, documented subsetting rather than an unexamined invention, once
this section exists to cite. Wholesale adoption is not recommended: most of
ISO 24617-2's dimensions (Social Obligation, Turn Management) grade
discourse politeness and turn-taking, which this project's fabrication
check has no use for, and the [Closed-set
classification](#closed-set-classification-abstention-and-judge-bias)
section's own point about hand-authored taxonomies applies here too — a
bigger borrowed taxonomy is not automatically a more complete one, only a
more expensive one to keep in scope. For `scope`: nothing to adopt: this
search found no precedent.

**Is extract-then-verify an established, named pattern?** Yes, under a
different name, from a different field. FEVER's retrieve-select-classify
pipeline (and FEVEROUS's structured-table extension) is the closest
published precedent for exactly this shape, is heavily benchmarked, and
converges independently on a three-state outcome (Supported/Refuted/NEI)
that corroborates callbench's own PASS/FAIL/INCONCLUSIVE from an unrelated
task. What FEVER's version does not carry, and callbench's does by
necessity, is the fact-blindness of the extraction step — see the
[Verification-first prompting](#verification-first-prompting--decomposition-independence-and-self-checking)
section's §6 for the confirmation-bias evidence behind that constraint;
FEVER's own retriever has no comparable contamination risk to guard against,
because it is not itself a semantic judge of the claim it retrieves evidence
for.

**The strongest argument that these literatures do not apply, stated
directly:** DST and dialogue-act tagging track what the **user** wants, in
order to drive a system the tracker is trying to help; the user's stated
goal is ground truth by construction and cannot itself be "wrong." callbench
inverts the direction — it extracts what the **system** claimed, in order to
grade that system against a fact its own speaker may not have gotten right,
using a tester with no cooperation from and no access to the thing being
graded. That inversion is not a stylistic variant of DST; it changes what
counts as ground truth (a stated preference vs. an external, falsifiable
fact), who the extraction serves (a policy that acts next, vs. a report read
by a human afterward), and what "wrong" even means (the user is never wrong
in DST; the target can be wrong in every callbench turn). The nearer match
by task shape is fact-checking (FEVER/FEVEROUS), not dialogue systems — but
fact-checking has never been applied to a live phone conversation with a
system the checker cannot instrument, three-state grading aside. callbench
sits at a genuine, currently-unoccupied intersection of DST-shaped
per-turn extraction and FEVER-shaped adversarial verification, applied to a
target neither literature's evaluation setup assumes access to. That is a
defensible claim to make about the design, not an excuse for skipping the
search — the search is what established it.

---

## Vehicle fitment data — what is free, what is licensed, what it covers

The fact set in [diagnosis.md](diagnosis.md) holds one car and cost a full
research pass to source one `never-offered` row at "high, not conclusive"
confidence. This section asks whether a free or open data source could
produce that table — `never-offered` / `optional` / `standard`, by
year/make/model or VIN — at a scale hand research cannot reach.

### NHTSA vPIC — the only candidate actually tested

**VERIFIED — called directly, five real VINs, July 2026.** vPIC
(`https://vpic.nhtsa.dot.gov/api/`) is a free NHTSA API, no key, no
registration, decoding VINs from manufacturer 49 CFR Part 565 filings.
`DecodeVinValues` returns a flat 154-field record per VIN. The variable
catalog (`GetVehicleVariableList`, VERIFIED, 144 variables) includes a named
"Active Safety System" group with exactly the fields this project would want:
Adaptive Cruise Control (ID 81), Blind Spot Warning (88), Forward Collision
Warning (101), Lane Departure Warning (102), Lane Keeping Assistance (103),
Backup Camera (104), Pedestrian AEB (171), Rear AEB (192), Blind Spot
Intervention (193), Lane Centering Assistance (194), plus ABS, ESC, TPMS,
airbags, daytime running lights.

**The value domain is exactly the trichotomy this project needs, when
populated.** `GetVehicleVariableValuesList/81` (VERIFIED) returns three
values for Adaptive Cruise Control: `Standard`, `Optional`, `Not Available`.
That is `standard` / `optional` / `never-offered` under different names, on
the vendor's own field.

**Coverage is the finding, and it is not simply "pre-2012 is blank."** Five
`DecodeVinValues` calls, ADAS fields only:

| VIN | vehicle | ACC | FCW | LDW/LKA | BlindSpotMon | ParkAssist |
| --- | --- | --- | --- | --- | --- | --- |
| `WAUKF78P89A015917` | 2009 Audi A3 quattro | `''` | `''` | `''` | `''` | `''` |
| `WAUFFAFL7DN018372` | 2013 Audi A4 quattro | `''` | `''` | `''` | `''` | `''` |
| `WAUENAF42JN008111` | 2018 Audi A4 quattro | `''` | `''` | `''` | `''` | `''` |
| `4T1BF1FK3CU040197` | 2012 Toyota Camry | `''` | `''` | `''` | `''` | `''` |
| `1HGCR3F93GA028861` | 2016 Honda Accord Touring | `''` | `''` | `''` | `''` | `''` |
| `4T1C11AK5LU330449` | 2020 Toyota Camry LE | `Standard` | `Standard` | `Standard` | `''` | `''` |
| `4T1G11AK4LU943843` | 2020 Toyota Camry SE | `Standard` | `Standard` | `Standard` | `''` | `''` |
| `1HGCV1F36MA051302` | 2021 Honda Accord Sport | `Standard` | `Standard` | `Standard` | `''` | `''` |

(Full request/response pairs and the two extra 2020 Camry VINs are in this
pass's working files, not committed; the table above is the complete set of
distinct outcomes observed, not a selection.)

Every field returned `''` for all three Audis tested (2009, 2013, **and**
2018 — this is not an old-car cutoff, Audi never populated in any year
tested) and for the pre-2017 Toyota and Honda. The same fields populated
`Standard` for 2020+ Toyota and 2021 Honda. **This is manufacturer-submission
coverage, not a chronological cliff**: it tracks which OEM chose to submit
safety-equipment data to vPIC and from which model year, not vehicle age as
such. Audi supplied none of the three tested years; Toyota and Honda supplied
none before roughly 2017-2020 and all after.

**Population is also field-specific within a submitting manufacturer, which
narrows the finding further.** All three tested 2020 Camry VINs (LE, SE, and
a second LE) show `Standard` for ACC/FCW/LDW/LKA but `''` for BlindSpotMon
and ParkAssist — on the same VIN, same submission. A manufacturer that
participates does not thereby populate every field; each field is its own
yes/no from the OEM.

**vPIC's own API response states, verbatim, what a blank field means**
(`DecodeVinValues` `Message` field, VERIFIED, this pass's actual JSON):
*"Any missing decoded values should be interpreted as NHTSA does not have
data on the specific variable. Missing value should NOT be interpreted as an
indication that a feature or technology is unavailable for a vehicle."*
This is the single load-bearing sentence for this whole section: it is
NHTSA's own written statement that blank ≠ absent, on the API that returns
the blank. Against `diagnosis.md`'s confidence-gate rule — only a
high-confidence `never-offered` fact may license a FAIL — an unpopulated
vPIC field is **not evidence of any confidence level**, high or low. It is
silence, and the vendor says so.

**Consequently: vPIC cannot support `never-offered` for the 8P A3, or for
any vehicle where the OEM did not submit safety-equipment data.** For the
one where it did (Toyota/Honda, ~2017+), a `Standard` value is one VIN's
fact, not a generation-wide universal negative — establishing "never offered
on any 2018-2020 Camry trim" from vPIC would still require decoding every
trim/engine/market combination and finding zero `Standard`/`Optional` hits,
which is a scalable, automatable version of the same enumeration
[diagnosis.md](diagnosis.md) did by hand for the A3 — cheaper, not free.
`Optional` vs `Standard`, on a single already-decoded VIN, is exactly what
vPIC is designed to answer, when the OEM submitted.

**Rate limits, license, bulk download** (VERIFIED, `vpic.nhtsa.dot.gov/api/`
and `/api/home/index/faq`): no API key, no registration, no published daily
cap; the API's own FAQ states 1000-2000 transactions/minute capacity on
weekdays and asks bulk users to prefer off-hours or the bulk download. US
government open-data product (no license fee; data.gov / data.transportation.gov
list it under DOT's open-data program). A full monthly SQL Server /
PostgreSQL database dump is published at `vpic.nhtsa.dot.gov/Downloads`
(`vPICList_lite_2026_06`, ~176 MB compressed) — VIN-pattern decoding only per
its own description; whether the dump's schema carries the same
safety-equipment columns as the live API was not tested this pass (**OPEN
QUESTION**).

**A separate, undocumented finding from this pass, not part of the research
brief but worth recording:** `vpic.nhtsa.dot.gov/ManufacturerHandbook.pdf`
301-redirects to `backend-vpic-home.nhtsa.dot.gov/...`, a hostname that does
not resolve publicly (`getaddrinfo ENOTFOUND`, this pass, twice). NHTSA's own
published manufacturer-facing documentation link is broken for anyone outside
their internal network. Not investigated further; noted because it blocked
this pass from sourcing NHTSA's own account of whether safety-equipment
submission is mandatory or voluntary, and since when — that provenance
question is **OPEN**.

### Synthetic VINs — decoder-testing tooling, and whether they can map vPIC's coverage

**Why a synthetic VIN is the more careful choice here, not a workaround.** The
check-digit algorithm is public federal regulation (49 CFR Part 565, giving
effect to ISO 3779). vPIC's own documentation publishes sample VINs for
exercising the decoder. And — the finding below makes this concrete —
`DecodeVinValues` resolves a VIN by matching its WMI+VDS+model-year against a
stored *pattern*, not by looking up an individual vehicle's record. A
checksum-valid VIN built from a real WMI and a real, previously-submitted VDS
therefore returns the same pattern data a real vehicle's VIN would, without
using any real person's vehicle identifier. This is decoder testing and
coverage mapping, not identity work — nothing here is offered to anyone as a
real vehicle.

**1. The algorithm — VERIFIED (49 CFR 565.15, cross-checked against eCFR /
Cornell LII text and Wikibooks' transliteration table this pass).**

| VIN position(s) | field | free to be arbitrary? |
| --- | --- | --- |
| 1-3 | WMI (manufacturer + vehicle type) | no — must be a real, assigned WMI for `Make` to resolve |
| 4-8 | VDS (vehicle attributes: body, engine, restraint, etc., Table I) | no — must match a real, previously-submitted pattern for `Model`/ADAS fields to resolve (VERIFIED below: a garbage VDS does not silently succeed) |
| 9 | check digit | no — *computed* from positions 1-8 and 10-17, never chosen |
| 10 | model year, 30-year repeating cycle (skips I, O, Q, U, Z, 0) | constrained — must pair with a position-7/VDS combination vPIC accepts as internally consistent (VERIFIED below: swapping only position 10 against a real VDS twice returned a *different* year than requested) |
| 11 | plant code | yes, within the constraint that some plant/VDS/year combinations may not resolve to any stored pattern |
| 12-17 | sequential production number | **yes, freely** — the one position set confirmed genuinely free of real-vehicle meaning (VERIFIED below) |

Check digit: transliterate letters via Table III (A-H→1-8, J→1, K-N→2-5, P→7,
R→9, S-Z→2-9; I/O/Q cannot appear), multiply positions 1-8 and 10-17 by Table
IV's weights (8,7,6,5,4,3,2,10 / 9,8,7,6,5,4,3,2), sum, divide by 11; the
remainder is the check digit (`X` for a remainder of 10). Position 9 carries
weight 0 in its own computation. **VERIFIED**: an implementation of exactly
this (this pass's `vin_tools.py`, 27 lines, unpublished scratch file)
reproduced the check digit of all 7 real VINs already in this doc's table
above, and of every real VIN cited below, with zero mismatches.

**The 30-year cycle is a real ambiguity, not a decoration.** Position 10's
alphabet repeats every 30 years (`A` = 1980 or 2010, `1` = 2001 or 2031, ...).
Passenger-vehicle convention uses position 7 (letter vs. digit) to pick the
half-cycle, and `DecodeVinValues` accepts an explicit `?modelyear=` query
parameter for exactly this disambiguation — confirmed necessary, not
optional, by a live failure below (Ford).

**2. Existing tooling — VERIFIED via GitHub (`gh api repos/<owner>/<repo>`,
July 2026, for language/license/stars/last-push). The validate/generate/pin
columns are INFERRED from each project's own README or description — not
functionally exercised this pass.**

| project | language | license | last push | validates | generates | pins WMI + model-year |
| --- | --- | --- | --- | --- | --- | --- |
| [idlesign/vininfo](https://github.com/idlesign/vininfo) | Python | BSD-3-Clause | 2026-05-02, 145★ | yes (checksum) | no | n/a — decode-only |
| [adaptant-labs/vin-decoder-dart](https://github.com/adaptant-labs/vin-decoder-dart) | Dart | Apache-2.0 | 2024-06-09, 37★ | yes | yes (random) | no — random WMI/serial per its own description |
| [ArchmageInc/vin-generator](https://github.com/ArchmageInc/vin-generator) | JavaScript | none declared | 2017-09-01, 12★ | yes | yes (random, checksum-correct) | no |
| [phillipsdata/vin](https://github.com/phillipsdata/vin) | PHP | none declared | 2016-01-07, 22★ | yes (North America only) | no | n/a |
| [mkyrychenko/vin-utils](https://github.com/mkyrychenko/vin-utils) | Java | MIT | 2018-05-02, 11★ | yes | yes | not verified this pass |
| [dalenewman/Vin](https://github.com/dalenewman/Vin) | C# | Apache-2.0 | 2016-12-29, 18★ | yes | not documented as a generator | n/a |
| [yanigisawa/VinGenerator](https://github.com/yanigisawa/VinGenerator) | Python | MIT | 2022-07-15, 17★ | n/a | yes (random, checksum-correct, "for testing") | no, per its own description |

**None of the libraries found let you pin a specific WMI and model year and
get a checksum-correct output in one call** — every generator located is a
*random* VIN generator, useful for "does my form field accept a plausible
VIN," not "give me a 2018 Audi VIN." This is why this pass wrote the 27-line
`vin_tools.py` directly from the regulation instead of adapting one of these:
the narrower, pinnable operation the task needed was not on offer anywhere
found.

**3. Does vPIC accept a synthetic VIN? VERIFIED — and this is the decisive
finding of this pass: vPIC's ADAS fields are keyed to the VIN pattern
(WMI+VDS+model year), not to an individual vehicle's record.**

Same-pattern, fabricated-serial pairs, called live this pass against
`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/{VIN}?format=json`:

| real VIN | synthetic twin (same WMI/VDS/year, serial changed) | ADAS fields, real | ADAS fields, synthetic |
| --- | --- | --- | --- |
| `WAUENAF42JN008111` (2018 Audi A4, real serial `008111`) | `WAUENAF41JN500001` (serial `500001`) | all blank | all blank — **identical** |
| `4T1C11AK5LU330449` (2020 Toyota Camry LE, real serial `330449`) | `4T1C11AK4LU777001` (serial `777001`) | ACC/FCW/LDW/LKA/Pedestrian AEB = `Standard` | ACC/FCW/LDW/LKA/Pedestrian AEB = `Standard` — **identical** |

Every field in both responses was identical except the VIN string echoed
back — changing only positions 12-17 changed nothing else. **This settles
what the prior pass's table could only gesture at**: vPIC holds no
per-vehicle ADAS record to consult, so a synthetic VIN cannot be missing
one — it reads the same shared pattern row a real vehicle's VIN would.

Checksum handling — **VERIFIED**: a deliberately wrong check digit
(`WAUENAF41JN008111`, position 9 corrupted from the correct `2` to `1`) still
decodes `Make`/`Model`/`ModelYear` correctly and still returns the pattern's
real ADAS data (blank, matching the genuine Audi row); vPIC adds
`ErrorCode: '1'` / `"1 - Check Digit (9th position) does not calculate
properly"` rather than refusing the decode. **A checksum failure is a
flagged warning, not a data-access gate** — pattern lookup does not depend
on the check digit being right, only on WMI+VDS+year matching something
vPIC has stored.

Garbage-VDS handling — **VERIFIED, and this bounds what "synthetic" can
responsibly mean here**: a real Audi WMI with a checksum-*valid* but
fabricated VDS (`WAUZZZZZ4JN999999`) does **not** return a false blank. It
returns `ErrorCode: '5,14'`, explicit text ("VIN has errors in few
positions" / "Unable to provide information ... based on the manufacturer
submission"), and a `SuggestedVIN` marking the unrecognized positions
(`WAU!!!!!4JN999999`), with `Model` itself left blank. vPIC visibly
distinguishes *this pattern isn't in my table* from *this pattern is in my
table and the manufacturer didn't submit ADAS for it* — the first returns an
error code and no Make/Model resolution, the second returns `ErrorCode: '0'`
and blank safety fields. **A synthetic VIN is only a valid coverage probe
when its WMI+VDS+year is a real, previously-submitted combination** —
inventing a VDS from scratch does not let you ask vPIC "does this
hypothetical car have ADAS," it only produces a distinguishable non-match.

Year-sweep handling — **VERIFIED, and it narrows the previous paragraph's
boundary further**: holding a real WMI+VDS fixed and changing only position
10 to a different model year does not reliably land on another real
pattern. Of five such attempts this pass (BMW X3 2011→2018/2022; Tesla Model
S 2014→2022; Ford F-150 2021→2009/2014/2018), one worked — Tesla's `5YJSA`
prefix resolved `Model: Model S` correctly for both 2014 and 2018, and 2018
returned real, populated ADAS data. The other four did not resolve `Model`
at all (BMW 2018: `ErrorCode 5,14`; BMW 2022: `ErrorCode 8`; Tesla 2022:
unresolved), or — for Ford — resolved to a **wrong year vPIC substituted on
its own** (`ErrorCode: '3,14'`, `"VIN corrected, error in one position"`,
turning a requested 2014 into a decoded `1984` and a requested 2018 into a
decoded `1988`) because position 7 in the donor VDS carries the 30-year-cycle
half-disambiguation and these VINs were built without the documented
`?modelyear=` override. **The finding stands on its own**: position 10 is not
free to swap in isolation the way the serial positions are; vPIC's own
`modelyear` parameter exists specifically to resolve this, and skipping it
produces a wrong, silently-substituted year rather than a clean error.

**Plain answer**: yes, synthetic checksum-valid VINs work against vPIC — for
decode, for reading the safety-equipment fields, and for confirming those
fields are pattern-level, not per-vehicle. They do not let you invent new
coverage data for a make/year vPIC has never seen; every genuine data point
below traces to a WMI+VDS combination that already existed in vPIC's table,
sourced either from a real vehicle's VIN or from NHTSA's own published
decoder-testing samples.

**4. The coverage map.** 22 distinct VINs, 27 `DecodeVinValues` `GET`
requests total this pass (`format=json`; five of the 22 re-fetched for the
`Not Available` check in §5) — well inside the ~1000-2000
transactions/minute capacity this doc already cites. VINs marked *sample*
are NHTSA's own published decoder-testing examples
(`vpic.nhtsa.dot.gov/api/Home/Index/LanguageExamples`, and the
`.../DecodeVinValues/5UXWX7C5*BA` doc example already named in the prior
subsection); VINs marked *synthetic* are this pass's own construction (real
WMI+VDS, computed check digit, fabricated serial); rows marked *pattern not
recognized* are the year-sweep failures above, kept visible rather than
dropped.

| make (origin) | model / VIN source | year | resolved? | ADAS fields populated |
| --- | --- | --- | --- | --- |
| Audi (German) | A3 quattro, real (prior pass) | 2009 | yes | none |
| Audi (German) | A4 quattro, real (prior pass) | 2013 | yes | none |
| Audi (German) | A4 quattro, real + synthetic twin (this pass) | 2018 | yes | none (identical real/synthetic) |
| BMW (German) | X3 xDrive35i, sample→synthetic full VIN (this pass) | 2011 | yes | none |
| BMW (German) | X3, year-swapped synthetic on same VDS | 2018 / 2022 | **no — pattern not recognized** | n/a |
| Toyota (Japanese) | Camry, real (prior pass) | 2012 | yes | none |
| Toyota (Japanese) | Camry LE/SE, real + synthetic twin (this + prior pass) | 2020 | yes | ACC, FCW, LDW, LKA, Pedestrian AEB = `Standard` |
| Honda (Japanese) | Accord, real (prior pass) | 2016 | yes | none |
| Honda (Japanese) | Accord Sport, real (prior pass) | 2021 | yes | ACC, FCW, LDW, LKA = `Standard` |
| Kia (Korean) | Sorento, NHTSA sample VIN, checksum as-published invalid (this pass) | 2012 | yes | none |
| Kia (Korean) | year-swapped synthetic on same VDS | 2022 | **no — pattern not recognized** | n/a |
| Chevrolet (domestic, GM) | HHR, NHTSA sample VIN, checksum as-published invalid (this pass) | 2006 | yes | none |
| Dodge (domestic, Chrysler) | Ram 2500, NHTSA sample VIN, checksum as-published invalid (this pass) | 2004 | yes | none |
| Ford (domestic) | F-150, NHTSA sample VIN, checksum valid (this pass) | 2021 | yes | FCW, LDW, Pedestrian AEB = `Standard`; ACC, LaneKeepSystem, BlindSpotMon = blank |
| Ford (domestic) | year-swapped synthetic on same VDS | 2009 / 2014 / 2018 | **no — pattern not recognized / wrong year substituted** | n/a |
| Tesla (luxury/EV) | Model S, sample→synthetic full VIN (this pass) | 2014 | yes | none |
| Tesla (luxury/EV) | Model S, sample→synthetic full VIN (this pass) | 2018 | yes | ACC = `Optional`; FCW, LDW, LKA, BlindSpotMon, ParkAssist, Pedestrian AEB = `Standard` |
| Tesla (luxury/EV) | year-swapped synthetic on same VDS | 2022 | **no — pattern not recognized** | n/a |

**Reading the table**: population tracks manufacturer and year, exactly as
the prior pass found, now with more manufacturers behind it. Toyota, Honda,
Ford, and Tesla each show at least one year with real, populated ADAS
fields; Audi, BMW, Kia, Chevrolet, and Dodge show none in any year tested —
and for none of those five is the blank explained by an unresolved pattern
(every "none" row above resolved `Make`/`Model` cleanly). Tesla's
2014-blank/2018-populated pair is the same within-manufacturer, by-year
split the prior pass found for Toyota and Honda, on a manufacturer with no
Audi/Detroit lineage at all — this reads as a general shape of the
submission gap rather than one tied to a specific manufacturer's practice.
Ford, like the prior pass's 2020 Camry, populates some ADAS fields and not
others on the same VIN (FCW/LDW/Pedestrian AEB yes; ACC/LaneKeepSystem/
BlindSpotMon no) — the field-specific-within-a-submission finding holds for
a third manufacturer.

**5. Does `Not Available` ever appear populated? VERIFIED — no, not once,
across every VIN this pass or the prior one decoded (29 live
`DecodeVinValues` calls total between the two passes, spanning 9 makes).**
Re-scanned five of this pass's VINs — two populated (`4T1C11AK5LU330449`,
`5YJSA3DS4JF555555`) and three blank (`WAUENAF42JN008111`,
`5XYKT3A12CG000000`, `3GNDA13D76S000000`) — for any field containing the
literal string `Not Available`: zero hits. Blank remains the only
non-affirmative state observed. This does not rule out `Not Available`
appearing somewhere in vPIC's full corpus — 29 VINs is a survey, not an
exhaustive scan of every manufacturer submission on file — but it means this
project's own evidence for the documented trichotomy
(`Standard`/`Optional`/`Not Available`) is entirely `Standard`/`Optional`/blank
in practice; the third value is **INFERRED** to exist (from
`GetVehicleVariableValuesList/81`, prior pass) and has never been directly
observed populated. A value that is defined but never seen populated would
be consistent with NHTSA's own `Message` field, which already says a
missing value carries no meaning in either direction — nothing here changes
that reading, and nothing here contradicts it either.

**Recommendation, restated for this angle.** The synthetic-VIN question does
not change the prior pass's recommendation — it sharpens the mechanism
behind it. vPIC's ADAS fields are confirmed pattern-level (§3), which is
good news for cost (`optional`/`standard` verdicts are a one-time
WMI+VDS+year lookup, cacheable forever, no per-VIN spend for a pattern
already seen) and no help for the universal negative this project actually
needs: a pattern-keyed table can only assert what it has a row for, and this
pass's year-sweep failures (§3, §4) show vPIC will not synthesize an answer
for a pattern it has never seen — it errors instead, honestly, rather than
returning a blank indistinguishable from non-submission. A vPIC-backed
catalog is worth building for the `optional`/`standard` half of the fact
set, for the specific manufacturer/year combinations this pass and the
prior one found populated (Toyota/Honda ~2020+, Ford 2021 on a field
subset, Tesla Model S 2018 on a field subset — all VERIFIED, not assumed to
generalize past the exact years tested). It remains unable to produce
`never-offered` for any vehicle, because absence of a row and absence of the
feature are the same blank, and this pass's `Not Available` search (§5)
found nothing to contradict that.

**Open questions from this pass**:
- Whether the Tesla 2014→2018 split, and the Ford field-specific split, hold
  across other trims/serials of the same pattern, or are themselves a
  narrower submission slice than "the whole model year" — not tested this
  pass, and the year-sweep failures above suggest patterns are more granular
  than WMI+VDS+year alone would imply.
- Whether `Not Available` appears anywhere in vPIC's live data for *any*
  VIN — this pass's 29-VIN, 9-make sample is suggestive, not exhaustive; the
  bulk database dump (cited in the prior subsection, not queried either
  pass) would settle this in one query instead of a VIN-by-VIN guess.
- Whether NHTSA's `?modelyear=` override would have rescued any of the
  failed year-sweep attempts if applied to the *full* synthetic VINs (it was
  used successfully only for the two partial-VIN sample calls in the prior
  subsection) — not tested; the year-sweep VINs in §3/§4 were built with
  position 10 set directly and no `modelyear` override passed.

### Other sources checked, not called

**EPA fueleconomy.gov** (`fueleconomy.gov/feg/ws/`, INFERRED from docs and
third-party clients, not called) — vehicle menu and MPG/emissions web
services. No ADAS or feature-fitment fields in its schema. Not useful here.

**Wikidata** (INFERRED, not queried with SPARQL this pass) — no located
property for driver-assistance fitment by trim; automobile items on Wikidata
are sparse and generation-level, not trim-level. **OPEN QUESTION**: a direct
SPARQL query against `query.wikidata.org` for an 8P A3 item was not run this
pass and would settle it in one request.

**CarQuery API** (`carqueryapi.com`, INFERRED from its own docs/terms) — free,
JSON, no key. Stopped receiving data updates in 2019 per third-party
reporting; coverage for a 2009 car may exist but nothing past ~2019 does, and
the field set (per its public docs) is body/engine/transmission trims, not
driver-assistance equipment. Not useful for this project's fields even where
covered.

**NAGS / Mitchell** (INFERRED from vendor marketing pages, not accessed —
access is paywalled by construction) — the auto-glass trade's standard glass
ID and ADAS-calibration-requirement catalog. Mitchell Cloud Glass Parts
Lookup is subscription/purchase; no free tier located. This is the
closest-fit trade source for the *calibration-required* question specifically
(not general fitment) and it is the one source in this list built by people
who already solved "which vehicles need what near a windshield" — and it is
licensed, confirming the brief's premise rather than refuting it.

**OEM catalogs — RealOEM (BMW), ETKA (VAG), 7zap** (INFERRED/partially
VERIFIED) — RealOEM (`realoem.com`) is free to browse by VIN/chassis and
shows part diagrams, not documented equipment-code tables in a queryable
form. ETKA itself is dealer-licensed software, not freely downloadable;
third-party web wrappers (`vinsearch.online/etka`, VERIFIED via search
results only) charge per lookup (from $3/24hr) rather than offering a free
tier. `audi.7zap.com` returned **HTTP 403** to an unauthenticated fetch this
pass (VERIFIED) — consistent with the same paywall pattern. **No free route
to VAG PR/option codes from a VIN was found.** This is the source that would
most directly answer the A3 camera question (a PR-code query across 8P
chassis codes was named as the settling probe in `diagnosis.md`), and it is
exactly the one that is not free.

**EU whole-vehicle type approval (WVTA) register** (INFERRED from search
results, not queried) — public, free, at `data.europa.eu`, but its granularity
is certificate/type metadata (manufacturer, CO2, category, approval number),
not per-feature-per-trim fitment. Unlikely to carry an equivalent of "front
camera: never offered on 8P."

### The honest limit

The question this project actually needs answered is a **universal
negative** — no 8P A3, in any market, was ever offered a forward camera.
Every source above, free or paid, is built to describe what a specific
vehicle *has*: a VIN decode, a parts diagram, a type-approval certificate.
None of them assert what a platform never had, because a catalog has no
reason to enumerate its own absence — the A3 example in `diagnosis.md`
already made this argument for the hand-research case; this pass's finding
is that no *automated* source escapes it either. vPIC's own field values
(`Standard`/`Optional`/`Not Available`) look like they could carry a
never-offered fact, until the question moves from "what does this one VIN
say" to "what does every VIN across a whole generation say" — at which point
it becomes the same brute-force enumeration diagnosis.md performed by hand,
run against an API instead of a PDF archive, cheaper but not qualitatively
different, and still bounded by the same submission gap that leaves the A3
itself unreadable.

**Recommendation.** A free catalog can plausibly automate `optional` and
`standard` verdicts, for post-~2017 vehicles from manufacturers that submit
to vPIC (VERIFIED: Toyota, Honda; untested for others) — decode the VIN,
read the field, done, no universal-negative problem because those two
verdicts only need one positive hit. It cannot automate `never-offered` for
any vehicle, old or new, because every candidate source reports presence,
not absence, and the one source built for exactly this trade question (NAGS)
is paywalled. Per `diagnosis.md`'s own rule — only a high-confidence
`never-offered` fact may license a FAIL — this means a vPIC-backed catalog
could serve every verdict this bench produces **except the one that accuses
anyone**. PASS and INCONCLUSIVE rows get cheaper to build at scale;
FAIL rows keep needing the expensive human path this project already used
once, for exactly the reason `diagnosis.md`'s Open section already names.

### Open questions from this pass

- Whether vPIC's bulk SQL/Postgres dump carries the same safety-equipment
  columns as the live `DecodeVinValues` endpoint (would change the "one VIN
  at a time" cost model for the `optional`/`standard` half of the catalog).
- Whether Audi (or VAG generally) submits vPIC safety-equipment data for
  *any* model year — three VINs (2009, 2013, 2018) were tested and none
  populated; a 2023+ Audi VIN was not tried and might flip this.
- A direct Wikidata SPARQL query against an 8P A3 item — not run this pass,
  cheap to run, would either add a source or close the question.
- Whether NHTSA's safety-equipment submission is mandatory or voluntary, and
  since when — blocked this pass by the broken `ManufacturerHandbook.pdf`
  redirect (above); settleable via NHTSA's manufacturer-portal docs or a
  direct query to the contact NHTSA lists (`manufacturerinfo@dot.gov`).

### Auto-glass windshield-variant enumeration — a catalog with a positive control

Researched 2026-07-15, testing a different shape of question than the rest of
this section. Every source above reports what a vehicle *has*; none enumerates
a generation's full option space. A windshield catalog is structurally
different: it cannot sell the correct glass without distinguishing every glass
variant a chassis was built with, because the camera bracket, rain-sensor
cutout, and acoustic interlayer are bonded into the glass itself, not bolted on
after. So instead of "no source says the 8P never had a camera," the question
tested here is "of every 8P windshield variant a catalog lists, does any one of
them carry a camera provision" — an enumeration, not an absence.

**Access note, stated once:** direct fetches of `parts.audiusa.com`, its dealer
mirrors (`audifremont.com`, `audihendersonparts.com`, `europeanoempartsdirect.com`,
`genuineaudipart.com`, `audipartsstore.com`), `audi.oempartsonline.com`, and
`audi.7zap.com` all returned **HTTP 403** to this pass's fetch tool, consistent
with the 403 already recorded above for 7zap. Per this task's access etiquette,
none was retried, scraped, or circumvented. What follows instead comes from
search-engine result snippets against those same pages — the indexed page
`<title>` and meta text, not a full fetch. That is a real, load-bearing
weakness in this evidence and is carried into the verdict below, not glossed
over: a title-tag snippet is one step short of VERIFIED-via-fetch, even though
convergence across many independent dealer mirrors quoting identical text
(same part number, same wording, same fitment years) makes fabrication by the
search layer unlikely.

**The 2009 A3 (8P) windshield catalog — every variant found, across many
distinct searches, converges on exactly two:**

| part number | feature string (as titled) | camera/ADAS mentioned |
| --- | --- | --- |
| `8P0845099L-NVB` | "w/rain sensor" | no |
| `8P0845099K-NVB` | "w/o rain sensor" | no |

No third 8P windshield part number surfaced in any search this pass ran
(direct part-number searches, feature-term searches, and cross-retailer
searches all returned only these two). Genuine Audi parts retailers
(`parts.audiusa.com` itself, `audifremont.com`, `audifrederick.com`) repeat the
identical two-part, two-feature split. **INFERRED** that this is the complete
factory windshield option list for the 8P, not a retailer's partial shelf —
inferred from convergence, not from an explicit "this is everything" statement
on any page (none was found making that claim outright).

**The sensitivity test — the same manufacturer, the same catalog platform,
the same part family, one generation later:**

| part number | feature string (as titled) | body style / fitment |
| --- | --- | --- |
| `8V5845099B-NVB` | "sedan, w/o distance sensor" | A3 sedan |
| `8V5845099C-NVB` | "sedan, w/distance" [sensor] | A3 sedan, 2015 |
| `8V5845099G-NVB` | "w/o distance sensor" | A3/RS3/S3, 2016-2020 |
| `8V5845099J-NVB` | "sedan, w/distance sensor" | A3/RS3/S3, 2017-2020 |
| `8V3845099Q-NVB` | "wagon, w/distance sensor" | A3 Sportback e-tron |
| `8V3845099S-NVB` | "wagon, w/o distance sensor" | A3 Sportback e-tron |

**This is the decisive result, and it is a positive control, not an inference
from silence.** The 8V/8W-generation A3 — which did ship with the front ADAS
camera (Audi's own eSSP 970343, already cited above, dates it to the 2015 A3)
— gets a *third* windshield split in the identical catalog system that the 8P
never gets: rain sensor is orthogonal to "distance sensor" in the 8V listings
(both appear as independent yes/no attributes), and "distance sensor" tracks
exactly the generation the camera was introduced on. **The catalog's own
vocabulary changes shape exactly when the underlying car changes shape** —
which is what a real enumeration should do, and what a shelf-inventory
listing has no reason to do consistently across five-plus independent SKUs.

**The "distance sensor" → camera bridge is INFERRED, not a literal-string
match, and that gap is named rather than smoothed over.** No fetched or
snippeted page uses the literal word "camera" in the 8V windshield listing
text — the catalog's own word is "distance sensor." The bridge to the R242
front camera rests on three converging, independently-sourced facts, not one:
(1) Audi's ACC ("distance control," a literal translation of the German
function name) fuses a bumper-mounted radar with the windshield-mounted front
camera, and the radar alone has no reason to change *glass* part numbers,
since it doesn't touch the glass — a TSB titled *"Cruise Control not
Available, -R242- Module Camera (cruise assist camera in rear view mirror)
Will Not Calibrate"* (NHTSA-filed, `static.nhtsa.gov/odi/tsbs/2018/MC-10150858-9999.pdf`,
metadata VERIFIED, body not machine-readable this pass) directly ties ACC
availability to the camera, by name; (2) a forum account of retrofitting Lane
Assist onto an A3 states the retrofit needs "the camera and a new windshield
with the correct bracket" — i.e., practitioners report the glass and the
camera bracket as a matched pair, not independent parts; (3) "Cruise Control
Distance Sensor Bracket" as a *separate* Audi part family (`4N0907574`,
`8R0907574B`, `5Q0907461A`) is confirmed to be the bumper radar mount, not a
glass part — which rules out the alternative reading that "distance sensor"
on the glass SKU refers to that radar bracket instead of the camera. None of
this is a single document that says "8V windshield J-suffix = camera
bracket" in so many words; it is a converging circumstantial case, and is
reported as one.

**A negative control that matters as much as the positive one: Honda's own
catalog does NOT do this.** The same search method run against Honda Civic
windshield part numbers (`73111-TBA-A11`, `73111-TBC-A11`, and neighbors,
2016-2021, spanning the Honda Sensing camera's introduction) found every
variant distinguished only by **glass supplier and tint** ("Green(Fuyao)",
"Green(Pilkington)") — never by camera presence. Honda's forward camera in
this generation bolts to a common bracket independent of the glass SKU, so
the glass catalog has no camera-related split to show, camera-equipped or not.
**This means the method's sensitivity is manufacturer-specific, not
universal**: it detects a camera-driven windshield split only where the OEM's
own engineering bonds the bracket into the glass part number, which Audi's
does (demonstrated above, before/after the 8P→8V transition) and Honda's does
not. Applied blindly to a manufacturer that uses Honda's approach, catalog
silence would mean nothing — which is exactly the failure mode item 2 of this
task's brief asked to be checked for, and here it is checked and separated
from the Audi finding rather than let contaminate it.

**Third source, corroborating vocabulary rather than the 8P fact itself:**
Mitchell's own public NAGS-abbreviation reference page
(`mymitchell.com/tchs/helpfiles/mcg_pos/1033/Content/42225.htm`, VERIFIED via
fetch) defines standing abbreviations for exactly this feature class —
*"Collision Warning System = A camera mounted on the roof interior detects an
impending collision," "Lane Departure Warning System = A camera or sensors
which identify that the vehicle is drifting,"* alongside `Rain Sensor`,
`Condensation Sensor`, `Acoustic Interlayer`, `Heated Wiper Park Area`, and
`Button` (mirror mount). This confirms the NAGS vocabulary has words for a
camera-equipped windshield — it does not confirm any specific 8P listing was
checked against them, since NAGS's actual catalog stayed paywalled this pass
exactly as the entry above already found.

**Verdict, against `diagnosis.md`'s gate: this raises confidence, but does
not clear it.** `diagnosis.md` requires a **high-confidence VERIFIED
never-offered** to license a FAIL. What this pass adds: a second, structurally
different source line (a manufacturer's own retail parts enumeration, not a
service-training document) that is consistent with never-offered, *and* a
demonstrated positive control showing that when this same manufacturer's
camera exists, this same catalog marks it — which a pure argument-from-silence
never has. That is a real increment over "no source found," because it rules
out the specific failure "maybe nobody ever bothered to enumerate this" for
at least one credible catalog. What it does not clear:

- **No direct fetch.** Every finding above comes through a search engine's
  indexed snippet of a page that itself 403'd to a direct fetch. A VERIFIED
  claim in this project's terms means the page was read, not that its title
  was read by proxy — this stays one notch below that bar.
- **US-market only.** `parts.audiusa.com` and its mirrors are a US retail
  catalog. The brief's camera fact is a claim about every market; a US-only
  catalog cannot settle a universal negative even if read directly.
- **"Distance sensor" is an inferred bridge to "camera," not a literal
  match.** Reported above with its supporting chain; a single document using
  the word "camera" against an 8P (or 8V, for the positive control) SKU would
  close this gap outright and was not found.
- **An enumeration of *this part family* is not an enumeration of the
  *vehicle*.** Ruling out a camera provision in the windshield glass eliminates
  the one channel most likely to carry it, but does not, by itself, rule out
  every other channel (a discontinued factory option coded elsewhere, a
  market-specific PR code) the way a full PR-code enumeration would.

Net: this pass moves the camera fact from "high, not conclusive, resting on
one training document plus an unsuccessful search" to "high, not conclusive,
resting on that document plus an independent catalog line with a demonstrated
positive control" — a stronger *high*, not a crossing into *VERIFIED*. The
settling probe `diagnosis.md` already names — a direct PR-code or ETKA query
across 8P chassis codes — remains exactly that: **OPEN**, un-superseded by
this pass, and still the only thing that closes the gap outright.

### The 21-make catalog platform — one vendor, or several?

Researched 2026-07-15. The maintainer named 21 makes he wants a
`(make, model, year, partType) -> [{partNumber, featureString}]` variant
enumerator to cover: Acura, Audi, BMW, Ford, GM, Honda, Hyundai, Infiniti,
Jaguar, Kia, Land Rover, Lexus, Mazda, Mitsubishi, Mopar, Nissan, Porsche,
Subaru, Toyota, Volkswagen, Volvo. "Mopar" is a parts brand, not a make — the
tell that this is a catalog platform's client roster, not a hand-picked list.
This pass asked whether one integration could cover all 21. **It cannot — the
21 split across at least six distinct infrastructures, and every one of them
blocked or never yielded a fetchable catalog page this pass.**

**Method, stated once.** Direct `curl` requests (no browser, no evasion, a
handful of reads per domain) against each make's `robots.txt` and homepage,
reading response headers, TLS certificate subject, and any served block page
verbatim. This is infrastructure fingerprinting from the outside, not a
platform's own disclosure — every platform attribution below is INFERRED from
matching signatures (identical `robots.txt` boilerplate text, identical
CDN/bot-management response shape), never a page that names its own vendor.

**The platform map (VERIFIED = this pass's own `curl`/`WebFetch` response;
INFERRED = signature match or secondhand source, not independently fetched;
OPEN QUESTION = not resolved this pass):**

| make | domain tested | infra observed | robots.txt / access posture |
| --- | --- | --- | --- |
| Audi | `parts.audiusa.com` | Cloudflare, `cf-mitigated: challenge` (VERIFIED, this pass, homepage `HEAD`) | `robots.txt` fetches (200, VERIFIED) — a "Content-Signal" template disallowing AI training, allowing search; real pages 403 to both raw `curl` and the `WebFetch` tool (VERIFIED, this pass and prior pass, same result on a different exact URL) |
| Kia | `parts.kia.com` | Cloudflare, `cf-mitigated: challenge` (VERIFIED) | same Content-Signal `robots.txt` template as Audi, byte-for-byte opening (VERIFIED) |
| Mazda | `parts.mazdausa.com` | Cloudflare, `cf-mitigated: challenge` (VERIFIED) | same Content-Signal template (VERIFIED) |
| Lexus | `parts.lexus.com` | Cloudflare, `cf-mitigated: challenge` (VERIFIED) | same Content-Signal template (VERIFIED) |
| Volkswagen | `parts.vw.com` | Cloudflare, `cf-mitigated: challenge` (VERIFIED) | same Content-Signal template (VERIFIED) |
| Nissan | `parts.nissanusa.com` | Cloudflare, `cf-mitigated: challenge` (VERIFIED) | different `robots.txt` template — "Section 1: Public Crawler - Light Throttling," names ClaudeBot/GPTBot/PerplexityBot/etc. individually (VERIFIED) — but identical bot-challenge behavior to the Content-Signal group |
| Infiniti | `parts.infinitiusa.com` | Cloudflare, `cf-mitigated: challenge` (VERIFIED) | "Section 1" template (VERIFIED), same as Nissan |
| Mitsubishi | `parts.mitsubishicars.com` | Cloudflare, `cf-mitigated: challenge` (VERIFIED) | "Section 1" template (VERIFIED) |
| Mopar | `store.mopar.com` | Cloudflare, `cf-mitigated: challenge` (VERIFIED) | "Section 1" template (VERIFIED) |
| Subaru | `parts.subaru.com` | Cloudflare cluster — INFERRED from matching Content-Signal `robots.txt` text only; `cf-mitigated` header not independently re-tested this pass | Content-Signal template (VERIFIED fetch of the text; cluster membership INFERRED) |
| Honda | `dreamshop.honda.com` | Akamai (`server: AkamaiGHost`, VERIFIED) — explicit `Access Denied` / `errors.edgesuite.net` page, even for `robots.txt` (VERIFIED). URL shape (`/s/…`) matches Salesforce B2C Commerce storefront convention — INFERRED, not confirmed by any Salesforce-specific header (blocked before any page content was seen) | Not the Cloudflare cluster's signature. Marketing copy from a 2015 SimplePart blog post claims Honda/Acura as SimplePart clients; this pass's infra fingerprint does not match the other nine confirmed-SimplePart domains, so that claim reads as **stale** rather than current |
| Acura | routes through Honda's `dreamshop.honda.com` (per this pass's search results — no separate `parts.acura.com` resolves) | same Akamai/DreamShop platform as Honda (INFERRED, shared domain) | same posture as Honda |
| Toyota | `parts.toyota.com` → CNAME `national.autoparts.toyota.com` (VERIFIED via `dig`) | AWS CloudFront, `x-cache: Error from cloudfront`, 403 (VERIFIED) | Distinct from Lexus despite the shared corporate parent — Toyota is **not** in the Cloudflare/SimplePart cluster that Lexus is in, a real asymmetry between sibling brands, not a naming accident |
| Ford | `parts.ford.com` | Unknown vendor. TLS handshake completes (cert CN `support.ford.com`, SAN covers `parts.ford.com`, issued by DigiCert) but the HTTP/2 stream is then reset (`INTERNAL_ERROR`) before any response headers arrive — zero bytes of HTTP response, on two separate attempts with different User-Agents (VERIFIED, this pass) | No readable `robots.txt` — the same reset happens on that path too |
| GM | `parts.gmparts.com` | Akamai (`errors.edgesuite.net` "Access Denied" page, VERIFIED) — a different block shape than Ford's silent reset, and than Honda's (both say Akamai but the served pages differ, so "same vendor" is not "same configuration") | Explicit 403 deny page on every path tried |
| Porsche | `shop.porsche.com` | Vercel (`server: Vercel`, Next.js response headers, VERIFIED) | The only domain this pass found that does **not** challenge a bare `curl` GET — root `robots.txt` (200, VERIFIED) allows general crawling except `/cart`, `/checkout`, `/search*`, and disallows `/_next/` and `/api/` **only** for two named Meta bots, not for `*`. This implies the site has `/api/` routes (ordinary for a Next.js app) but this pass did not confirm their contents — a local tooling error lost the homepage body before it could be grepped for endpoint paths. **OPEN QUESTION**, not a confirmed-open backend |
| BMW | `shop.bmwusa.com` | Plain `HTTP/2 200` to a bare `curl` GET, no `cf-mitigated` header, no Cloudflare — robots.txt uses Adobe-AEM-shaped paths (`Disallow: /content/shopbmwusa-com/us/en/bmw…`) (VERIFIED) | Does not match the Cloudflare/SimplePart cluster's fingerprint, contradicting the same 2015 blog's claim that BMW is a SimplePart client. Homepage returning 200 does not mean a catalog/product page would; not tested further |
| Jaguar, Land Rover | no first-party catalog domain located | **OPEN QUESTION / not found.** `landroverusa.com`'s own "Genuine Parts" page is informational, not a catalog. Every purchase path found (`jaguarparts.com`, `landrover.oempartsonline.com`) is a third-party or RevolutionParts-branded storefront, not a JLR-operated domain | n/a — nothing to test |
| Hyundai, Volvo | no first-party catalog domain confirmed | **OPEN QUESTION.** `parts.hyundaiusa.com` and `parts.volvocars.com` do not resolve (VERIFIED, DNS failure); search turned up only third-party retailers and RevolutionParts-branded storefronts. The same 2015 SimplePart blog names both as clients, but with no live domain found to test, this is unverified, not confirmed | n/a |

**Reading the map.** At most 10 of the 21 makes (9 VERIFIED, Subaru INFERRED)
sit behind one shared piece of infrastructure — Cloudflare with bot-challenge
active — consistent with a single platform vendor (SimplePart, per its own
marketing) fronting all of them through the same CDN account. The other 11
split at least six further ways: Honda/Acura on a Salesforce-shaped storefront
behind Akamai, Toyota alone on AWS CloudFront despite Lexus sitting in the
Cloudflare cluster, Ford behind an unidentified connection-resetting block, GM
behind a differently-configured Akamai deny page, Porsche on Vercel with no
challenge observed, BMW plain-200 with an Adobe-AEM-shaped `robots.txt`, and
Jaguar/Land Rover/Hyundai/Volvo with no first-party catalog domain located at
all. **The premise holds directionally — one vendor plausibly covers roughly
half the list — but "one integration covers all 21" is false on this
evidence**, and for four makes there may be no first-party integration to
build against at all.

**Item 2, the decisive question: does any platform expose a reachable
frontend JSON API?** No. Every domain that resolved and was fetchable at all
either challenged the request (the 10-make Cloudflare cluster), served an
explicit deny page (Honda/Acura, GM), silently reset the connection (Ford), or
was never confirmed past a header check (Porsche, BMW). No `/api/`, `/graphql`,
or documented partner endpoint was reached with real content on any of the 21
makes this pass. Porsche's `robots.txt` is the one piece of positive evidence
that an `/api/` path *exists* on any of these sites — and it stops there.

**Item 3, variant data shape.** No new structured catalog data was obtained
this pass, on any make — every direct fetch of an actual product/catalog page
was blocked. This extends the prior subsection's Audi-specific 403 finding to
the cluster it sits in: the block is not Audi-specific, it is the platform's.
The only variant data this whole line of research has (the 8P/8V windshield
tables above) still comes from search-engine snippets of pages that
themselves 403, one notch below VERIFIED, exactly as already recorded.

**Item 4, robots.txt and terms.** Formal terms-of-service text was not read
this pass (OPEN QUESTION, not investigated) — but the operative access
control here is not the robots.txt file, it is the bot-management layer
sitting in front of it. A `cf-mitigated: challenge` response or an Akamai
`Access Denied` page is the site's answer to "may an automated client read
this," delivered before any terms page would even load, and this pass treated
each as a stop: no block was retried, scraped, or circumvented, consistent
with this project's access etiquette.

**Item 5, the honest recommendation.** **Not buildable against a clean
backend, on this pass's evidence, for any of the 21 makes.** Every make either
sits behind an active bot-management challenge (10), was never located as a
first-party catalog (4: Jaguar, Land Rover, Hyundai, Volvo), or returned only
a header-level 200 with its actual catalog content unverified (2: Porsche,
BMW) — and the remaining three (Honda/Acura, Toyota, Ford, GM — four makes,
five counting Acura with Honda) each sit behind their own explicit block. A
tool built to clear any of these would need a real browser defeating a WAF
(Cloudflare Turnstile, Akamai Bot Manager, or whatever silently resets Ford's
connections) — scraping past an access control, not calling an exposed API —
which is out of scope under this project's own etiquette (no scraper, no
circumvention, a handful of reads as a normal reader). If the maintainer
wants to go further, the next real move is not more fetching: it is a
manufacturer-affiliate or reseller-API relationship (SimplePart, RevolutionParts,
or a named OEM partner program), which is a business/legal step, not a
research one, and out of this pass's scope.

**The camera-in-glass-SKU method's reach.** Of the 21 makes, **one** has a
VERIFIED positive control (Audi — the 8P/8V windshield-catalog split, above)
and **one** has a VERIFIED negative control (Honda — the same search method
against Civic windshield SKUs found only supplier/tint splits, never a
camera-driven one, across the Honda Sensing camera's introduction). Acura
shares Honda's platform and, by extension, plausibly its engineering pattern
(badge-engineered Honda platforms), but this is INFERRED, not independently
checked. The other **19 makes are untested** for whether their windshield (or
any other single-part-family) catalog carries a structured camera/ADAS split
at all — and for at least 10 of them, this pass's own access findings above
mean establishing that positive control is gated on the same blocked read
access as the variant-enumeration tool itself, not merely an unstarted
research task. This is real, bounded, follow-on work — a per-make positive
control, one search-and-verify pass per make — not something this pass's
scope covered.

**Restated ceiling, unchanged by this pass.** Per `diagnosis.md`'s
confidence gate, only a high-confidence `never-offered` fact may license a
FAIL, and a variant-enumeration catalog — even a perfect one, even with a
readable backend — is manufacturer-specific (Audi yes, Honda no, 19/21
untested) and US-market only. It cannot, on its own, produce a VERIFIED
universal negative for any vehicle; at best it raises an already-`high`
confidence further, exactly as the prior subsection's Audi finding did.
