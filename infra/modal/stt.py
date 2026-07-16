"""Speech-to-text on Modal — faster-whisper behind an OpenAI-compatible endpoint.

The authoritative transcript pass. It runs OFFLINE over a frozen recording
(docs/models.md § latency split), so this is the batch shape: the whole
recording exists, POST it, get the transcript. Latency across the ~455ms link
is irrelevant here; a live turn-taking STT (a WebSocket endpoint) is a separate,
later concern — turn-taking stays local in the 20ms path.

Route: POST /v1/audio/transcriptions (OpenAI's audio API), so the client is the
same `openai:` runner the rest of the bench uses — base URL points here.

The confidence signal is load-bearing: INCONCLUSIVE is built on "the model
wasn't sure it heard that" (docs/plan.md, Increment 2). faster-whisper exposes
`avg_logprob` and `no_speech_prob` per segment; the response carries both, per
segment and word, verbatim — the bench decides the abstain threshold, not this
endpoint.

Model note: whisper-large-v3 is the best whisper, but whisper is weak on 8kHz
telephony (docs/speech.md). It is the right FIRST model because it works and is
swappable; if measured telephony WER is poor, change MODEL — that is the whole
point of the seam.

  Deploy:  modal deploy infra/modal/stt.py
  URL:     printed on deploy; the OpenAI base is <url> (route below is /v1/...)
"""

import modal

from common import (
    GPU,
    REGION, HF_CACHE, HF_CACHE_PATH, MAX_CONTAINERS, SCALEDOWN_WINDOW, WARM_CONTAINERS, app, cuda_image,
)

# large-v3-turbo: the 809M pruned-decoder Whisper — ~2.7x faster inference
# than large-v3 at neutral WER (SYSTRAN faster-whisper #1030), half the VRAM.
# The single highest-latency-won-per-effort STT change (docs/latency.md).
MODEL = "large-v3-turbo"
# medium (L4), not small (T4): turbo FITS a T4, but decode speed is the live
# turn's third-biggest block (measured ~1.0-1.5s/turn, 2026-07-16) and the L4
# roughly halves it for ~$0.21/hr more while warm.
GPU_TIER = GPU["medium"]

app = app("stt")
# faster-whisper 1.1.0 imports `requests` at load but doesn't pull it as a
# resolved dep under uv here — added explicitly (log-confirmed, not guessed).
image = cuda_image("faster-whisper==1.1.0", "fastapi[standard]==0.115.6", "requests")


@app.cls(
    gpu=GPU_TIER,
    region=REGION,
    image=image,
    volumes={HF_CACHE_PATH: HF_CACHE},
    scaledown_window=SCALEDOWN_WINDOW,
    min_containers=WARM_CONTAINERS,  # 1 under CALLBENCH_WARM=1 — no cold start
    max_containers=MAX_CONTAINERS,
    timeout=10 * 60,
)
@modal.concurrent(max_inputs=4)
class STT:
    @modal.enter()
    def load(self) -> None:
        from faster_whisper import WhisperModel

        # Weights land in the shared HF-cache volume on first cold start, then
        # persist across scale-downs — the second deploy is warm.
        self.model = WhisperModel(MODEL, device="cuda", compute_type="float16")

    @modal.asgi_app()
    def api(self):
        from fastapi import FastAPI, File, Form, UploadFile

        web = FastAPI(title="callbench-stt")

        @web.get("/health")
        def health() -> dict:
            return {"status": "ok", "model": MODEL}

        # OpenAI-compatible transcription. We return OpenAI's `verbose_json`
        # shape PLUS the raw confidence fields the abstain logic needs, which
        # OpenAI's own response omits — a superset, so a plain OpenAI client
        # still reads `.text` and ours reads the rest.
        #
        # PLAIN `def`, not `async def`: faster-whisper's decode is synchronous
        # and GPU-blocking. On the ASGI event loop it would freeze every other
        # request (including GET /health) for the whole decode, making the
        # declared max_inputs concurrency a lie. A sync handler runs in
        # FastAPI's threadpool, so concurrent requests actually progress.
        @web.post("/v1/audio/transcriptions")
        def transcriptions(
            file: UploadFile = File(...),
            model: str = Form(default=MODEL),  # accepted for OpenAI-compat; ignored
            response_format: str = Form(default="verbose_json"),
        ) -> dict:
            import tempfile

            data = file.file.read()  # sync read — this handler runs in the threadpool
            with tempfile.NamedTemporaryFile(suffix=".wav") as tmp:
                tmp.write(data)
                tmp.flush()
                segments, info = self.model.transcribe(
                    tmp.name, word_timestamps=True, beam_size=5
                )
                segs = list(segments)

            return {
                "text": " ".join(s.text.strip() for s in segs).strip(),
                "language": info.language,
                "language_probability": info.language_probability,
                "duration": info.duration,
                "provider": f"faster-whisper:{MODEL}",
                "segments": [
                    {
                        "id": s.id,
                        "start": s.start,
                        "end": s.end,
                        "text": s.text,
                        # The confidence signal. avg_logprob near 0 = confident;
                        # very negative = unsure. no_speech_prob high = probably
                        # not speech. Both carried raw; the bench sets the bar.
                        "avg_logprob": s.avg_logprob,
                        "no_speech_prob": s.no_speech_prob,
                        "words": [
                            {
                                "word": w.word,
                                "start": w.start,
                                "end": w.end,
                                "probability": w.probability,
                            }
                            for w in (s.words or [])
                        ],
                    }
                    for s in segs
                ],
            }

        return web
