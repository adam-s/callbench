"""LLM on Modal — vLLM behind an OpenAI-compatible endpoint.

Serves the persona (the hybrid tester's voice, Increment 6) and the judge's
BOOTSTRAP (Increment 4). The judge migrates to `claude -p` once it works
(docs/models.md § the judge migration); this endpoint stays as the persona's
host and the offline judge fallback. Because both are the `openai:` runner,
that migration is a base-URL/selector change, not a code change.

Streaming is native: vLLM's OpenAI server streams token deltas over SSE, which
the persona uses so the first synthesized audio goes out before the whole reply
exists (docs/models.md § streaming, AGENTS.md prefer-streaming).

Direct adaptation of the maintainer's proven serve pattern
(car-diagnosis/serve_qwen.py, goldseam/selfhost). Model is small by default so
the first deploy is cheap to prove; bump MODEL + GPU_TIER for production.

  Deploy:  modal deploy infra/modal/llm.py
  URL:     printed on deploy; the OpenAI base is <url>/v1
"""

import subprocess

import modal

from common import (
    GPU, HF_CACHE, HF_CACHE_PATH, MAX_CONTAINERS, SCALEDOWN_WINDOW, STARTUP_TIMEOUT,
    WARM_CONTAINERS, app, cuda_image,
)

# Small by default: proves the full GPU + vLLM + OpenAI + streaming path at
# minimal cost/time. The persona wants a bigger model — bump both together.
MODEL = "Qwen/Qwen2.5-3B-Instruct"
GPU_TIER = GPU["small"]
PORT = 8000

app = app("llm")
image = cuda_image("vllm==0.11.0", "transformers==4.57.0")


@app.function(
    image=image,
    gpu=GPU_TIER,
    volumes={HF_CACHE_PATH: HF_CACHE},
    min_containers=WARM_CONTAINERS,  # 1 under CALLBENCH_WARM=1 — the persona TTFT killer
    scaledown_window=SCALEDOWN_WINDOW,
    max_containers=MAX_CONTAINERS,
    timeout=20 * 60,
)
@modal.concurrent(max_inputs=8)
@modal.web_server(port=PORT, startup_timeout=STARTUP_TIMEOUT)
def serve() -> None:
    # vLLM fully loads before web_server routes traffic (the startup_timeout
    # window), so the first request never races an unloaded model. Tool-calling
    # on: structured judge/persona output rides tool calls.
    subprocess.Popen(
        f"vllm serve {MODEL} --host 0.0.0.0 --port {PORT} --max-model-len 8192 "
        "--enable-auto-tool-choice --tool-call-parser hermes",
        shell=True,
    )
