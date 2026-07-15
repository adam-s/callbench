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
MODAL_LLM_URL=https://<workspace>--callbench-llm-serve.modal.run   # +/v1 for the OpenAI base
```

STT's transcription route returns OpenAI's `verbose_json` **plus** the raw
`avg_logprob` / `no_speech_prob` / per-word `probability` fields — a superset, so
a plain OpenAI client reads `.text` and the bench reads the confidence that
INCONCLUSIVE is built on.

## Deployed state (2026-07-15)

- **stt** — deployed, verified: transcribed real 8kHz telephony audio correctly,
  confidence fields meaningful (a novel word scored 0.54 where real words scored
  0.99). Idles to zero.
- **llm** — written, **not yet deployed**. A direct adaptation of the
  maintainer's proven `serve_qwen.py`; deploy when the persona (Increment 6) or a
  bootstrap judge needs it, to avoid spending ahead of need.

## When a deploy misbehaves

Read the container logs first — `./manage.sh logs <role>`. Both failures during
the first STT deploy were named exactly in the logs (a missing bundled module, a
missing pip dep) and fixed in one pass each; neither was diagnosable by staring
at the source. A silent empty HTTP response is a re-probe signal, not a fact
(AGENTS.md) — the log is where the fact is.
