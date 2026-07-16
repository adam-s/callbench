# Contender: self-hosted streaming, all on Modal

Everything on your Modal account, no per-minute API, full control. Modal's own
measured stack of this exact shape (Parakeet + Qwen-4B-vLLM + Kokoro,
co-located) hits **~1s median voice-to-voice** — the target this contender aims
to reproduce. Sources inline.

## The recipe (from research, 2026-07-16)

**STT — NeMo FastConformer cache-aware streaming** (or Parakeet-TDT + VAD, the
Modal-proven choice). The load-bearing knob is `att_context_size`:

| att_context_size | lookahead | WER (RNNT) |
|---|---|---|
| `[70,0]` | 0ms | 7.0% |
| `[70,1]` | **80ms** | **6.4%** ← sweet spot |
| `[70,16]` | 480ms | 5.7% |

- Model trained at **16kHz** — upsample our 8kHz telephony at ingest (no native
  8kHz path). GPU A10G/L4, ~2–3GB, `@modal.concurrent(max_inputs=14)`.
- Serve over WebSocket (`@modal.asgi_app()` → FastAPI `/ws`, `receive_bytes` /
  `send_text`), model loaded in `@modal.enter()`.
- Modal's [streaming_parakeet example](https://modal.com/docs/examples/streaming_parakeet)
  uses `parakeet-tdt-0.6b-v2`, `a10g`, VAD-segmented 1s chunks — they chose it
  over open-source streaming because "final transcript time proved faster."
  [FastConformer card](https://huggingface.co/nvidia/stt_en_fastconformer_hybrid_large_streaming_multi).

**LLM — Qwen3-4B-Instruct on vLLM** (Modal's bot choice: "as small and fast as
possible while producing quality answers"). CUDA graphs ON (do NOT
`--enforce-eager`), chunked prefill on by default (V1), `--gpu-memory-utilization
0.92`, trim `--max-num-seqs`. L4/A10G 24GB. TTFT tens-of-ms warm.
[vLLM optimization](https://docs.vllm.ai/en/stable/configuration/optimization/).

**TTS — Kokoro-82M streaming** (already built: `infra/modal/tts.py`
`/v1/audio/speech/stream`, clause-flush, 8kHz mulaw out). Flush at `.?!` or a
~64-token buffer; kokoro-onnx first-audio ~28–45ms warm.

**The two configs that matter most** (bigger than any model/flag tuning):
1. **Regional co-location + Modal Tunnels** — put STT/LLM/TTS in one region,
   connect via Tunnels to bypass the input-plane hop. This is what separates
   Modal's ~1s stack from a 2–3s one. [Modal voice bot](https://modal.com/blog/low-latency-voice-bot).
2. **Clause-level LLM→TTS overlap** — `async for token in llm_stream` feeding a
   clause detector that `await tts_queue.put(clause)` on first punctuation while
   a second task drains TTS to the socket. LLM decode and TTS synth run
   concurrently. [RealtimeVoiceChat](https://news.ycombinator.com/item?id=43899029).

**Cold start:** keep-warm (`CALLBENCH_WARM=1` → `min_containers=1`, already
wired in `common.py`), or GPU memory snapshots (alpha,
`enable_memory_snapshot=True` + `enable_gpu_snapshot`) — measured Parakeet
20s→2s, vLLM 45s→5s. [GPU snapshots](https://modal.com/blog/gpu-mem-snapshots).

## To run this contender
1. `CALLBENCH_WARM=1 modal deploy infra/modal/{stt,llm,tts}.py` (turbo Whisper +
   streaming Kokoro already committed; a NeMo streaming STT endpoint is the one
   new build this recipe adds).
2. Set the three Modal URLs in `.env` (`MODAL_STT_URL`, `MODAL_LLM_URL`,
   `MODAL_TTS_URL`).
3. `adapter.ts` (this folder) implements `TurnPipeline` against them.

**Expected warm voice-to-voice: ~1s median.** Best if it can hit sub-1s once
co-located; the STT `att_context_size` right-context sets the transcript-final
floor.
