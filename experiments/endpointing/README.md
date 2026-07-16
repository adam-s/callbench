# Endpointing replay — score turn-end candidates on frozen call audio

The question: how long must the bench wait after silence before believing a
speaker is DONE — and can a smarter detector wait less without splitting a
mid-sentence pause? Live A/B answered "not by shrinking the window" (900 vs 600
was a wash, takes `1784207852425`/`1784208362852`); real-shop audio answered
"pauses are routine" (17 of 40 provisional endpoints re-attached on the warm-up
call). This replay decides the detector on EVERY frozen take at once instead of
one noisy live call at a time.

## Method

- Input: each take's `twilio-recording.wav` (8kHz stereo — caller and target on
  separate channels), replayed as the live path sees audio: 20ms mulaw frames.
- Reference utterances (ground truth, detector-independent): energy speech runs
  on a channel, merged across internal gaps ≤1500ms. A gap a human left inside
  1.5s is a pause; past it, a new utterance.
- Each candidate detector runs continuously per channel (re-armed after each
  `turn-end`), and is scored per reference utterance:
  - **splits** — turn-ends fired before the utterance's true last speech frame
    (a reply would have interrupted a human mid-sentence);
  - **endpoint wait** — turn-end time minus the utterance's true last speech
    frame (what a caller hears as dead air before the reply pipeline even starts);
  - **misses** — utterances that produced no turn-end at all.
- Output: one diffable table, a row per candidate. No model judgment inside;
  deterministic over the same takes.

## Candidates

- `energy/<confirm>ms` — the production `EnergyTurnDetector` at a sweep of
  confirm windows (provisional stays 300ms).
- `silero-v6` (planned) — Silero VAD v6 ONNX as the speech/silence layer, same
  two-stage windows on top.
- `smart-turn-v3.1` (planned) — semantic gate at the provisional endpoint:
  *complete* → confirm immediately, *incomplete* → stretch. Needs 8k→16k
  upsample (the model silently misreads 8kHz — pipecat#3844).

## Results (2026-07-16, decision recorded)

Energy sweep, 42 takes / 84 channels / 407 utterances (replay.ts):

| candidate | split-rate | median wait |
|---|---|---|
| energy/300ms | 91.9% | 300ms |
| energy/600ms | 24.8% | 600ms |
| energy/900ms (production) | 10.1% | 900ms |
| energy/1200ms | 0.2% | 1200ms |

Neural, newest 6 takes / 80 utterances (neural_gate.py, reference impls):

| candidate | split-rate | median wait |
|---|---|---|
| silero/900ms | 11.2% | 1040ms |
| smart-turn-gate | 137.5% | 300ms |

**Verdict:** on this (mostly synthetic-voice) corpus Silero ≈ energy — a better
VAD buys nothing where there is no line noise. The smart-turn gate's number
says the INTEGRATION is wrong (a >100% split rate means it fired on most
pauses), not that the model is — the mel frontend and logit readout here are
unverified against a reference; validate the classifier standalone on known
complete/cut-off clips before trusting any gate built on it. The first real
call ships on the proven config — energy@900 + provisional/re-attach +
speculative STT + barge-in yield — which produced the best-graded takes
(`1784207852425`, run #7). The semantic gate stays the follow-up, with this
harness as its scorecard.

## Run

```sh
node --env-file=.env experiments/endpointing/replay.ts            # all takes
node --env-file=.env experiments/endpointing/replay.ts --takes 5  # newest N
```
