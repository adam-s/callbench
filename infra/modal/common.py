"""Single source of truth for every callbench Modal endpoint.

Nothing under infra/modal/ hard-codes an app name, a GPU, a volume, or a
scale-to-zero window — it all comes from here, so "a consistent way to manage
the models, containers, and API" is enforced by construction rather than by
discipline. Change a default here and every endpoint that adopts it moves
together; a new endpoint that reaches for `app(...)` and the shared image
inherits the whole convention for free.

Conventions borrowed from the maintainer's proven Modal repos (car-diagnosis,
goldseam, detect-study): CUDA base image + uv-installed vLLM, an HF-cache
Volume so weights download once, min_containers=0 with a warm scaledown_window
so idle costs nothing.
"""

import modal

# --- naming -----------------------------------------------------------------
# Every app is `callbench-<role>`, so `modal app list` reads as an inventory
# and manage.sh can find them by prefix. The role is the endpoint's job, not
# its model — the model is swappable underneath a stable name.
PREFIX = "callbench"


def app_name(role: str) -> str:
    return f"{PREFIX}-{role}"


def app(role: str) -> modal.App:
    return modal.App(app_name(role))


# --- GPU tiers --------------------------------------------------------------
# Named by job size, not by hardware, so an endpoint asks for what it needs and
# the mapping to Modal's catalog lives in ONE place. Costs are order-of-
# magnitude, USD/hr while a container is warm; idle is $0 (scale-to-zero).
GPU = {
    "small": "T4",  # ~$0.59/hr — STT (whisper), small TTS, models < ~8B
    "medium": "L4",  # ~$0.80/hr — mid TTS, 7-8B LLMs
    "large": "L40S",  # ~$1.95/hr — 14B+ LLMs (the persona / bootstrap judge)
}

# --- scale-to-zero ----------------------------------------------------------
# The cost model. A container releases its GPU this long after the last
# request, so back-to-back use never re-pays the cold start but an idle
# endpoint bills nothing. max_containers caps blast radius: a bug that spams
# the endpoint cannot spin up an unbounded GPU fleet.
SCALEDOWN_WINDOW = 5 * 60
MAX_CONTAINERS = 1
STARTUP_TIMEOUT = 10 * 60  # first cold request waits up to here for model load

# --- shared caches ----------------------------------------------------------
# One HF-cache volume across every endpoint, so a model pulled by one deploy is
# already present for the next. Named volumes persist across deploys and
# scale-downs — the weights survive an idle window.
HF_CACHE = modal.Volume.from_name("callbench-hf-cache", create_if_missing=True)
HF_CACHE_PATH = "/root/.cache/huggingface"


def cuda_image(*pip: str) -> modal.Image:
    """CUDA + Python base with hf_transfer enabled, plus the given pip installs.

    The base pins match the maintainer's proven-working combo (CUDA 12.8.1);
    endpoints add their own model runtime (vllm, faster-whisper, a TTS lib).

    `add_local_python_source("common")` bundles THIS module into every image, so
    an endpoint's `from common import ...` resolves inside the container. Modal
    1.5.2 mounts only the entrypoint file by default; the single-source-of-truth
    split means the shared module has to travel explicitly, and the shared image
    builder is exactly the one place that guarantees it for every endpoint.
    """
    return (
        modal.Image.from_registry("nvidia/cuda:12.8.1-devel-ubuntu22.04", add_python="3.12")
        .entrypoint([])  # drop the base image's entrypoint so Modal runs ours
        .uv_pip_install("huggingface_hub[hf_transfer]", *pip)
        .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
        .add_local_python_source("common")
    )
