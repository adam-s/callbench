# callbench on Modal — devops

Every model callbench runs lives here: served on Modal, behind OpenAI-compatible
HTTP, managed by one script. The *why and the shape* are in
[docs/models.md](../../docs/models.md); this file is how you operate it.

## Layout — one convention, enforced in one place

```
common.py    single source of truth: app naming, GPU tiers, the shared CUDA
             image, the HF-cache volume, scale-to-zero windows. Nothing else
             hard-codes any of these — change a default here, everything moves.
stt.py       speech-to-text (faster-whisper), OpenAI /v1/audio/transcriptions
tts.py       text-to-speech (Kokoro-82M), OpenAI /v1/audio/speech
llm.py       persona + bootstrap judge (vLLM), OpenAI /v1/chat/completions
manage.sh    deploy / status / urls / logs / down — over the whole fleet
```

A new endpoint reaches for `app(...)` and `cuda_image(...)` from `common` and
inherits the entire convention — naming, GPU catalog, caching, scale-to-zero —
for free. Add its role to the `ROLES` list in `manage.sh` and it joins the
managed fleet.

## Manage

```sh
cd infra/modal
./manage.sh deploy         # deploy every endpoint (or: deploy stt)
./manage.sh status         # modal app list
./manage.sh urls           # the base URL per endpoint, for .env
./manage.sh logs stt       # tail one endpoint's logs — READ THESE when a deploy misbehaves
./manage.sh down           # stop everything (idle is already $0; this is a deliberate stop)
```

`modal` is the uv-tool CLI already on PATH; `manage.sh` wraps it so operations
run over the fleet, not one file at a time.

## Cost — scale-to-zero is the whole model

- **Idle bills nothing.** `min_containers=0` + a `scaledown_window` (5 min):
  a container releases its GPU that long after the last request. Between calls,
  $0.
- **A run pays per-second of GPU while warm.** Order-of-magnitude, USD/hr:
  `small`=T4 ~$0.59, `medium`=L4 ~$0.80, `large`=L40S ~$1.95. STT runs on
  `small`. A minute of transcription is single-digit cents.
- **`max_containers=1`** caps the blast radius: a bug that hammers an endpoint
  cannot spin up an unbounded fleet.
- **Cold start** is the tradeoff for scale-to-zero: the first request after an
  idle window waits for the GPU to spin and the model to load (~45s measured for
  STT). Warm requests skip it. The `scaledown_window` keeps back-to-back use
  warm so a run pays the cold start once.

## Reaching it from callbench

Every endpoint is OpenAI-compatible, so the client is the `openai:` runner with
a base URL — the seam in [docs/models.md](../../docs/models.md). After a deploy,
`./manage.sh urls` (or the URL `modal deploy` printed) goes into `.env`:

```
MODAL_STT_URL=https://<workspace>--callbench-stt-stt-api.modal.run
MODAL_TTS_URL=https://<workspace>--callbench-tts-tts-api.modal.run
MODAL_LLM_URL=https://<workspace>--callbench-llm-serve.modal.run   # +/v1 for the OpenAI base
```

STT's transcription route returns OpenAI's `verbose_json` **plus** the raw
`avg_logprob` / `no_speech_prob` / per-word `probability` fields — a superset, so
a plain OpenAI client reads `.text` and the bench reads the confidence that
INCONCLUSIVE is built on.

## Deployed state (2026-07-16)

All three endpoints are deployed **warm** (`CALLBENCH_WARM=1`, maintainer
go-ahead 2026-07-16) and **region-pinned to `us-east`** (`REGION` in common.py) —
unpinned containers had landed far enough away to add ~600ms per request from
the driver; pinning measured the LLM's first frame from the driver at ~235ms.

- **stt** — faster-whisper `large-v3-turbo` on **L4** (bumped from T4: decode
  was the live turn's third-biggest block). Confidence fields verified
  meaningful on real 8kHz telephony.
- **tts** — Kokoro-82M on T4; `/v1/audio/speech/stream` (clause-flush, 8kHz)
  is consumed live by the sim leg's `speakStreaming`.
- **llm** — vLLM `Qwen/Qwen3-4B-Instruct-2507` on L4, prefix caching on, tool
  flags on (measured latency-neutral: 433ms vs 430–454ms in-Modal first frame).
  Serves the persona AND the shop imitation through the `openai:` streaming
  runner.

Warm fleet bills while held (T4+L4+L4 ≈ $3.6/hr order-of-magnitude): after a
campaign window, redeploy without `CALLBENCH_WARM` (or `./manage.sh down`) to
fall back to scale-to-zero.

## When a deploy misbehaves

Read the container logs first — `./manage.sh logs <role>`. Both failures during
the first STT deploy were named exactly in the logs (a missing bundled module, a
missing pip dep) and fixed in one pass each; neither was diagnosable by staring
at the source. A silent empty HTTP response is a re-probe signal, not a fact
(AGENTS.md) — the log is where the fact is.
