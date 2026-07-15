#!/usr/bin/env python3
"""Compare STT models on a captured audio file. Bounded, offline, deterministic.

Runs each model in MODELS over one audio file, writes verbatim transcripts,
and — once a human-authored reference transcript exists — scores word error
rate and emits a report with charts.

Two-step by design: transcription runs first and STOPS if the output dir has
no reference.txt, because ground truth comes from the person who spoke, not
from the best model's output (a model-derived reference would score that
model's family as better than it is — circular). Write reference.txt, re-run,
get the report.

Bounds: fixed model list, one audio file, no network, no retry. whisper-cli
inference is local and deterministic for a given model+audio. WER is
hand-rolled word Levenshtein rather than a library dependency: the algorithm
is textbook, and the normalization choices (the part that actually moves the
number) need to be explicit here either way. Normalization: lowercase, strip
punctuation except intra-word apostrophes, collapse whitespace.

Usage:
  python3 scripts/evals/eval-stt.py <audio.wav> <output-dir>
"""

import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

MODEL_DIR = Path.home() / ".cache/whisper-models"
MODELS = ["tiny.en", "base.en", "small.en", "medium.en"]

# Charts: single series -> one hue, no legend (dataviz skill; hue validated
# against the light surface with scripts/validate_palette.js).
HUE = "#3987e5"
INK = "#3d3d3a"
GRID = "#e6e4df"


def normalize(text: str) -> list[str]:
    text = text.lower()
    text = re.sub(r"[^a-z0-9' ]+", " ", text)
    text = re.sub(r"(?<![a-z])'|'(?![a-z])", " ", text)  # keep only intra-word '
    return text.split()


def wer(ref: list[str], hyp: list[str]) -> float:
    """Word error rate: Levenshtein distance over reference length."""
    if not ref:
        raise ValueError("empty reference")
    prev = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        cur = [i] + [0] * len(hyp)
        for j, h in enumerate(hyp, 1):
            cur[j] = min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r != h))
        prev = cur
    return prev[-1] / len(ref)


def transcribe(model: str, audio: Path) -> tuple[str, float]:
    t0 = time.perf_counter()
    out = subprocess.run(
        ["whisper-cli", "-m", str(MODEL_DIR / f"ggml-{model}.bin"), "-f", str(audio), "-nt"],
        capture_output=True,
        text=True,
        timeout=600,
        check=True,
    )
    elapsed = time.perf_counter() - t0
    # whisper-cli prints the transcript to stdout, logs to stderr
    text = " ".join(line.strip() for line in out.stdout.splitlines() if line.strip())
    return text, elapsed


def bar_chart(path: Path, title: str, labels: list[str], values: list[float], fmt: str) -> None:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    fig, ax = plt.subplots(figsize=(6, 2.6), dpi=160)
    y = range(len(labels))
    ax.barh(y, values, height=0.55, color=HUE)
    ax.set_yticks(list(y), labels)
    ax.invert_yaxis()
    ax.set_title(title, loc="left", color=INK, fontsize=11)
    # Direct-label the extreme (the best = smallest) only; the report table
    # carries every number.
    best = min(range(len(values)), key=lambda i: values[i])
    ax.text(
        values[best],
        best,
        f"  {fmt.format(values[best])}",
        va="center",
        color=INK,
        fontsize=9,
    )
    ax.tick_params(colors=INK, labelsize=9)
    ax.xaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    for side in ("top", "right", "left"):
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color(GRID)
    fig.tight_layout()
    fig.savefig(path, facecolor="white")
    plt.close(fig)


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    audio, outdir = Path(sys.argv[1]), Path(sys.argv[2])
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "transcripts").mkdir(exist_ok=True)
    shutil.copy(audio, outdir / audio.name)

    results = []
    for model in MODELS:
        tfile = outdir / "transcripts" / f"{model}.txt"
        if tfile.exists():
            text = tfile.read_text().strip()
            elapsed = json.loads((outdir / "results.json").read_text())[model]["seconds"]
            print(f"{model:10} (cached) {text[:80]}")
        else:
            text, elapsed = transcribe(model, audio)
            tfile.write_text(text + "\n")
            print(f"{model:10} {elapsed:5.1f}s  {text[:80]}")
        results.append((model, text, elapsed))

    (outdir / "results.json").write_text(
        json.dumps(
            {m: {"seconds": round(s, 2), "transcript": t} for m, t, s in results}, indent=2
        )
    )

    ref_file = outdir / "reference.txt"
    if not ref_file.exists():
        print(f"\nNo {ref_file} yet. Ground truth comes from the speaker:")
        print("write what was ACTUALLY said into that file, then re-run this")
        print("command; transcription is cached and only scoring will run.")
        sys.exit(0)

    ref = normalize(ref_file.read_text())
    scored = [(m, wer(ref, normalize(t)), s) for m, t, s in results]

    bar_chart(
        outdir / "wer.png",
        f"Word error rate vs reference ({len(ref)} words) — lower is better",
        [m for m, _, _ in scored],
        [w for _, w, _ in scored],
        "{:.0%}",
    )
    bar_chart(
        outdir / "runtime.png",
        "Transcription wall time (s) — lower is better",
        [m for m, _, _ in scored],
        [s for _, _, s in scored],
        "{:.1f}s",
    )

    rows = "\n".join(
        f"| {m} | {w:.0%} | {s:.1f}s |" for m, w, s in scored
    )
    (outdir / "report.md").write_text(
        f"""# STT model comparison — {audio.name}

One audio file, {len(ref)} reference words. **This is a probe on a small
sample, not a benchmark** — treat the ranking as a hypothesis to re-test on
longer captures, per the anecdote rule in docs/probes.md.

Reference transcript: `reference.txt` (authored by the speaker, not by a
model — a model-derived reference scores its own family as better than it is).
Audio: real telephony capture, 8kHz mulaw off the wire. Figures below are read
from `results.json`, produced by `scripts/evals/eval-stt.py`.

| model | WER | wall time |
|---|---|---|
{rows}

![WER](wer.png)

![Runtime](runtime.png)

Per-model verbatim output is under `transcripts/`.
"""
    )
    print(f"\nreport: {outdir}/report.md")
    for m, w, s in scored:
        print(f"  {m:10} WER {w:5.0%}   {s:5.1f}s")


if __name__ == "__main__":
    main()
