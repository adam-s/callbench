"""Score NEURAL endpointing candidates on the frozen take corpus.

Companion to replay.ts (which scores the energy sweep): same reference
utterances (energy runs merged across gaps <=1.5s), same metrics (splits,
misses, median endpoint wait), so the two tables concatenate into one
decision. Reference implementations only — silero-vad's own wrapper and
Whisper's own feature extractor — because both models silently mis-score on
hand-rolled frontends (pipecat#3844).

Candidates:
  silero/<confirm>ms   Silero VAD v6 speech timeline + the same two-stage
                       window machine the live detector runs.
  smart-turn-gate      energy provisional 300ms -> smart-turn v3.2 on the last
                       <=8s (upsampled 8k->16k): complete -> endpoint now;
                       incomplete -> confirm at 1200ms.

Run:  uv run --with silero-vad,onnxruntime,transformers,numpy \
        python3 experiments/endpointing/neural_gate.py [--takes N]
"""

import struct
import sys
import wave
from pathlib import Path

import numpy as np

FRAME_MS = 20
SR = 8000
FRAME = SR * FRAME_MS // 1000
MERGE_GAP_MS = 1500
SPEECH_ENERGY = 500  # DEFAULT_TURN_CONFIG.speechEnergy
MIN_SPEECH_MS = 200
CONFIRMS = [300, 450, 600, 750, 900]
GATE_PROVISIONAL_MS = 300
GATE_FALLBACK_MS = 1200
ROOT = Path(__file__).resolve().parents[2]


def channels(path: Path) -> tuple[np.ndarray, np.ndarray] | None:
    w = wave.open(str(path))
    if w.getnchannels() != 2 or w.getframerate() != SR:
        return None
    data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return data[0::2], data[1::2]


def energy_timeline(pcm: np.ndarray) -> np.ndarray:
    n = len(pcm) // FRAME
    return np.abs(pcm[: n * FRAME].astype(np.float32)).reshape(n, FRAME).mean(axis=1)


def reference(energy: np.ndarray) -> list[tuple[int, int]]:
    runs, cur = [], None
    for f, e in enumerate(energy):
        if e < SPEECH_ENERGY:
            continue
        at = f * FRAME_MS
        if cur and at - cur[1] <= MERGE_GAP_MS:
            cur[1] = at
        else:
            if cur:
                runs.append(cur)
            cur = [at, at]
    if cur:
        runs.append(cur)
    return [(a, b) for a, b in runs if b - a >= MIN_SPEECH_MS]


def turn_ends(speech: np.ndarray, confirm_ms: int) -> list[int]:
    ends, spoke, last = [], 0, None
    for f, s in enumerate(speech):
        at = f * FRAME_MS
        if s:
            spoke += FRAME_MS
            last = at
            continue
        if last is None:
            continue
        if at - last >= confirm_ms:
            if spoke >= MIN_SPEECH_MS:
                ends.append(at)
            spoke, last = 0, None
    return ends


def score(ends: list[int], refs: list[tuple[int, int]]) -> dict:
    s = {"utt": len(refs), "splits": 0, "miss": 0, "waits": []}
    for a, b in refs:
        s["splits"] += sum(1 for e in ends if a <= e < b)
        after = next((e for e in ends if b <= e <= b + 5000), None)
        if after is None:
            s["miss"] += 1
        else:
            s["waits"].append(after - b)
    return s


def main() -> None:
    take_limit = (
        int(sys.argv[sys.argv.index("--takes") + 1]) if "--takes" in sys.argv else 10**9
    )
    takes_dir = ROOT / "data/live-sim"
    takes = sorted(
        (d for d in takes_dir.iterdir() if d.name.isdigit() and (d / "twilio-recording.wav").exists()),
        reverse=True,
    )[:take_limit]

    from silero_vad import load_silero_vad  # noqa: PLC0415 — heavy import after arg parse

    silero = load_silero_vad(onnx=True)
    import torch  # silero's wrapper API is tensor-in even for the onnx backend  # noqa: PLC0415

    import onnxruntime as ort  # noqa: PLC0415
    from transformers import WhisperFeatureExtractor  # noqa: PLC0415

    fe = WhisperFeatureExtractor(chunk_length=8)  # smart-turn: 8s window
    st = ort.InferenceSession(str(ROOT / "experiments/endpointing/models/smart-turn-v3.2-cpu.onnx"))

    def silero_speech(pcm: np.ndarray) -> np.ndarray:
        """Per-20ms-frame speech bools from Silero, 256-sample chunks @8k."""
        silero.reset_states()
        x = pcm.astype(np.float32) / 32768.0
        probs = []
        for i in range(0, len(x) - 256 + 1, 256):
            p = silero(torch.from_numpy(x[i : i + 256]), SR).item()
            probs.append(p)
        n_frames = len(pcm) // FRAME
        frame_probs = np.zeros(n_frames)
        for f in range(n_frames):
            c = min(len(probs) - 1, (f * FRAME) // 256)
            frame_probs[f] = probs[c] if probs else 0.0
        return frame_probs >= 0.5

    def smart_turn_complete(pcm: np.ndarray, end_ms: int, start_ms: int) -> bool:
        """Classify the turn-so-far (<=8s tail) as complete at end_ms."""
        a = max(start_ms, end_ms - 8000) * SR // 1000
        b = end_ms * SR // 1000
        seg8 = pcm[a:b].astype(np.float32) / 32768.0
        if len(seg8) < SR // 2:
            return False
        seg16 = np.repeat(seg8, 2)  # crude 2x upsample; the model needs 16k
        feats = fe(seg16, sampling_rate=16000, return_tensors="np", padding="max_length")
        logits = st.run(None, {"input_features": feats["input_features"].astype(np.float32)})[0]
        prob = 1 / (1 + np.exp(-float(logits.reshape(-1)[-1])))
        return prob >= 0.5

    def gate_ends(pcm: np.ndarray, speech: np.ndarray) -> list[int]:
        """Provisional at 300ms; smart-turn says complete -> end now, else
        wait for the 1200ms fallback."""
        ends, spoke, last, start, asked = [], 0, None, None, False
        for f, s in enumerate(speech):
            at = f * FRAME_MS
            if s:
                spoke += FRAME_MS
                if last is None or start is None:
                    start = at if start is None else start
                last = at
                asked = False
                continue
            if last is None or start is None:
                continue
            silence = at - last
            if spoke < MIN_SPEECH_MS:
                continue
            if silence >= GATE_FALLBACK_MS:
                ends.append(at)
                spoke, last, start, asked = 0, None, None, False
            elif silence >= GATE_PROVISIONAL_MS and not asked:
                asked = True
                if smart_turn_complete(pcm, last, start):
                    ends.append(at)
                    spoke, last, start, asked = 0, None, None, False
        return ends

    totals: dict[str, dict] = {}

    def add(name: str, s: dict) -> None:
        t = totals.setdefault(name, {"utt": 0, "splits": 0, "miss": 0, "waits": []})
        t["utt"] += s["utt"]
        t["splits"] += s["splits"]
        t["miss"] += s["miss"]
        t["waits"] += s["waits"]

    n_channels = 0
    for take in takes:
        ch = channels(take / "twilio-recording.wav")
        if ch is None:
            continue
        for pcm in ch:
            energy = energy_timeline(pcm)
            refs = reference(energy)
            if not refs:
                continue
            n_channels += 1
            sil = silero_speech(pcm)
            eng = energy >= SPEECH_ENERGY
            for c in CONFIRMS:
                add(f"silero/{c}ms", score(turn_ends(sil, c), refs))
            add("smart-turn-gate", score(gate_ends(pcm, eng), refs))

    print(f"takes={len(takes)} channels={n_channels}")
    print("candidate         utterances  splits  split-rate  miss  median-wait")
    for name in sorted(totals):
        t = totals[name]
        rate = 100 * t["splits"] / max(1, t["utt"])
        wait = int(np.median(t["waits"])) if t["waits"] else 0
        print(
            f"{name:<17} {t['utt']:>10} {t['splits']:>7} {rate:>9.1f}% {t['miss']:>5} {wait:>9}ms"
        )


if __name__ == "__main__":
    main()
