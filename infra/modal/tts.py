"""Text-to-speech on Modal — Kokoro-82M behind an OpenAI-compatible endpoint.

The bench's voice. Kokoro is Apache-2.0 (commercial-safe), tiny (~4GB, the
`small` tier), and good enough — naturalness matters less than being reliably
heard by the target's STT (docs/speech.md).

Route: POST /v1/audio/speech (OpenAI's TTS API), so the client is the same
`openai:` family the rest of the bench uses.

Output is **raw 16-bit PCM at 8000 Hz, mono, little-endian** — Kokoro's native
24kHz downsampled here. The client turns that into mulaw frames with the
transport's own encodePcm (already verified byte-identical to ffmpeg's G.711),
so the wire format lives in one place. Not WAV: the transport wants headerless
frames, and a header would be one more thing to strip.

Scripted utterances are pre-rendered before a call (docs/models.md § latency
split), so the ~455ms link is paid before the call, not during it.

  Deploy:  modal deploy infra/modal/tts.py
"""

import io

import modal

from common import GPU, HF_CACHE, HF_CACHE_PATH, MAX_CONTAINERS, SCALEDOWN_WINDOW, app, cuda_image

VOICE = "af_heart"  # a clear American-English preset; swappable per request
GPU_TIER = GPU["small"]
OUT_RATE = 8000  # the transport's rate; Kokoro's 24kHz is resampled to this

app = app("tts")
# espeak-ng is Kokoro's G2P fallback (apt, not pip); soxr does the resample.
image = cuda_image(
    "kokoro>=0.9.4",
    "soundfile==0.13.1",
    "soxr==0.5.0.post1",
    "numpy<2.2",
    "fastapi[standard]==0.115.6",
    apt=("espeak-ng",),
)


@app.cls(
    gpu=GPU_TIER,
    image=image,
    volumes={HF_CACHE_PATH: HF_CACHE},
    scaledown_window=SCALEDOWN_WINDOW,
    max_containers=MAX_CONTAINERS,
    timeout=10 * 60,
)
@modal.concurrent(max_inputs=4)
class TTS:
    @modal.enter()
    def load(self) -> None:
        from kokoro import KPipeline

        # 'a' = American English. Weights land in the shared HF-cache volume.
        self.pipeline = KPipeline(lang_code="a")

    @modal.asgi_app()
    def api(self):
        import numpy as np
        import soxr
        from fastapi import FastAPI
        from fastapi.responses import Response
        from pydantic import BaseModel

        web = FastAPI(title="callbench-tts")

        class SpeechRequest(BaseModel):
            input: str
            voice: str = VOICE
            model: str = "kokoro"  # accepted for OpenAI-compat; ignored

        @web.get("/health")
        def health() -> dict:
            return {"status": "ok", "voice": VOICE, "out_rate": OUT_RATE}

        @web.post("/v1/audio/speech")
        def speech(req: SpeechRequest) -> Response:
            # Kokoro yields 24kHz float32 chunks per sentence; concatenate, then
            # resample the whole utterance once to the transport's 8kHz.
            chunks = [audio for _, _, audio in self.pipeline(req.input, voice=req.voice)]
            if not chunks:
                return Response(content=b"", media_type="audio/L16")
            audio24 = np.concatenate([np.asarray(c, dtype=np.float32) for c in chunks])
            audio8 = soxr.resample(audio24, 24000, OUT_RATE)
            pcm16 = np.clip(audio8 * 32767.0, -32768, 32767).astype("<i2")
            buf = io.BytesIO()
            buf.write(pcm16.tobytes())
            # audio/L16 = linear 16-bit PCM; rate in the header for honesty.
            return Response(
                content=buf.getvalue(),
                media_type=f"audio/L16; rate={OUT_RATE}; channels=1",
                headers={"x-sample-rate": str(OUT_RATE), "x-provider": "kokoro-82m"},
            )

        return web
