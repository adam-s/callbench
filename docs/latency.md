# Latency — from an 8.7s turn toward a conversational one

Measured, not guessed: the first full LLM-vs-LLM rehearsal (take c41db469,
2026-07-16) ran a **median 8.7s per turn** (7.5–11.8s). That is the sum of a
strictly sequential loop — the caller finishes, THEN we POST the whole
utterance to STT, THEN await the full transcript, THEN a full LLM completion,
THEN synthesize the whole reply, THEN send. Nothing overlaps, and every stage
can also eat a serverless cold start.

This doc records what four parallel research passes (STT, LLM, TTS, pipeline —
2026-07-16, sources cited inline below) found, and the plan that follows from
it. The headline: **the sum collapses to three terms once the stages stream and
overlap** — voice-to-voice ≈ endpointing + LLM-first-token + TTS-first-audio,
with STT hidden inside listening time. Production stacks hit 500–900ms this way
(sayna.ai, smallest.ai, Modal's Pipecat+Kokoro bot at ~1s median); the same
stages summed sequentially are the 6–9s regime we sit in.

## Where the 8.7s goes, and what each leg can become

| Leg | Now | Streaming ceiling | The change |
|---|---|---|---|
| Endpointing | 900ms confirm (`vad.ts`) | ~400ms (semantic) | smart-turn-v3 behind `TurnDetector` |
| STT | POST-whole-WAV + await + cold start | ~150–500ms finalization, hidden in listening | streaming ASR fed from the 20ms frames |
| LLM | full `claude -p` subprocess completion | ~150–600ms first token | in-process streaming SDK, Haiku 4.5 |
| TTS | whole-utterance synth + cold start | tens of ms first-audio | clause-chunk into the existing pacer |

### Endpointing is latency (pipeline pass)
The loop can't start until it believes the caller is done, so `confirmSilenceMs:
900` is 900ms of every turn spent waiting. **smart-turn-v3** reads the waveform
for grammatical completeness in ~12ms CPU (daily.co) and `vad.ts` already names
it as the upgrade path behind the same `TurnDetector` shape — and already emits
`turn-maybe-end` / re-attaches on resume, which IS the EagerEndOfTurn/TurnResumed
substrate Deepgram Flux and LiveKit preemptive-generation are built on. Most of
the hard part is built; the confirm window is the thing to retire.

### STT hides inside listening time (STT pass)
Batch POST forfeits the biggest structural win: streaming ASR transcribes DURING
speech, so the transcript is ready the instant the VAD declares turn-end.
Self-hostable on Modal: NVIDIA Parakeet/Nemotron cache-aware streaming (~100ms
chunks, 8kHz-capable). Managed telephony ASR (Deepgram Nova, AssemblyAI, ~150–
300ms, trained on 8kHz) is the zero-ops alternative. Cheap pre-work first:
`large-v3` → **`large-v3-turbo`** is a config swap, ~2.7× faster at neutral WER
(SYSTRAN faster-whisper #1030), and `min_containers=1` kills the 2–4s cold-start
tail.

### The LLM leg's biggest cost is the subprocess (LLM pass)
`packages/judge/src/runner.ts` spawns `claude -p` per turn — it boots the whole
Claude Code harness (config, tools, MCP) before a NON-streaming call, on every
caller turn. One adapter fixes three things at once: a persistent in-process
streaming `@anthropic-ai/sdk` client on **`claude-haiku-4-5`** (~2–3× faster
first-token than Sonnet — the persona only needs one short sentence, a
register-and-facts task, not reasoning). Adaptive thinking stays OFF. Prompt
caching is a NON-STARTER here: the persona prefix is below Haiku's 4096-token
cache floor, so `cache_control` silently never triggers. This requires widening
the `Runner` seam from `run(): Promise<string>` to yield tokens; the judge keeps
a `.run()` that concatenates (it is offline and does not care).

### TTS first-audio is a clause, not an utterance (TTS pass)
Kokoro's `KPipeline` is a generator — feed it clause-by-clause and the first
chunk's audio emits while later clauses synthesize; resample each 24kHz chunk to
8kHz mulaw in-process and hand the first to the pacer we already have. Warm
Kokoro synthesizes a clause in tens of ms. **Kokoro runs real-time on CPU (RTF
0.16–0.5)** — so a keep-warm CPU container skips the 30–120s GPU cold start
entirely and the floor container is cheap. Switch to Cartesia Sonic (native
`pcm_mulaw@8000`, ~188ms P50) only if keeping a container warm is not worth it.

## Adopt a framework, or stream our own three stages?

**Build — borrow the components, not the runtime.** Adopting pipecat/LiveKit
hands over a proven 500–700ms loop, but it swallows the two things this bench
exists to guarantee: deterministic freeze/hash record-and-assert, and the
`placeCall` dial gate. Those frameworks are built for *takes* — nondeterministic
realtime — and AGENTS.md is explicit that a render differing run-to-run is a bug
and that an irreversible dial sits behind a human checkpoint. `pacer.ts` already
documents matching pipecat's pacing MECHANISM without ceding the loop; the same
posture applies here. Take pipecat's model choices and a streaming-STT client;
keep our event loop, our freeze, and our gate.

## The honest scope of the win

This latency is on the OWNED-LOOP rehearsal — the persona caller and the
sim-model shop, both ours. On the real-target call the bench measures the
*target's* latency and does not control its speed; our own caller's turn time
still matters (a slow caller makes a real agent re-prompt or give up), but the
8.7s→sub-1.5s win chiefly buys **rehearsal fidelity**: a sim leg that responds
like a real shop, so the persona is exercised against realistic timing before it
ever dials one.

## Ranked plan (latency won per effort)

1. **`large-v3` → `large-v3-turbo` + `min_containers=1` on STT** — config only,
   removes ~1–2s + the cold-start tail. Do first.
2. **Keep-warm Kokoro on CPU + clause-chunk into the pacer** — first-audio from
   1–3s to tens of ms, infra we already have.
3. **In-process streaming Haiku 4.5 runner** behind the `provider:model` seam
   (`docs/models.md`) — kills subprocess boot, drops the tier, unlocks
   streaming. Widen the `Runner` interface to yield tokens.
4. **Streaming STT fed from the 20ms frames** (turbo-Whisper streaming, or
   Parakeet/Deepgram) — transcription finishes at turn-end. The structural win;
   the real work.
5. **smart-turn-v3 behind `TurnDetector`** — retire the 900ms confirm for a
   ~400ms semantic verdict; wire speculation onto the existing `turn-maybe-end`.

1–3 are days of work on infrastructure we own and buy the bulk of the win; 4–5
are the deeper reworks that take the loop toward the sub-second regime. None
touches the record/assert seam or the dial gate.
