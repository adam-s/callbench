---
name: bench-live-campaign
description: Run a bounded overnight campaign of live owned-to-owned calls — bench number dialing the simulator's number — to harvest takes, measure variance and audio quality, and fix-and-pin what the takes reveal. Use when the user says "run a batch", "overnight takes", "variance run", "degradation gradient", "exercise it live", or when a scenario needs live rehearsal before the real target. Owned numbers only; the real target is bench-live-call, behind its own gate.
---

# Live campaign — the owned loop

Both legs of every call are numbers this account owns: the bench speaks a
scenario into the simulator over real Twilio audio, and the frozen take is
graded by the same offline assertion layer the suite uses. Unattended runs
here are sanctioned (maintainer decision, 2026-07-16 — the owned-loop
exception in [docs/architecture.md](../../../docs/architecture.md)), because
the protection is structural, not procedural: `assertDialAllowed`
(`scripts/lib/twilio.ts`) fetches the account's owned numbers on every dial
and refuses anything else, the system under test by name. No env var or bug
in a loop can point this path at a stranger's line.

**GATE — crossing to the real target is never this skill.** A take against
the simulator proves the bench; evidence about the system under test comes
only from [bench-live-call](../bench-live-call/SKILL.md), maintainer-dialed.
Scenarios arrive here already built and rehearsed offline
([bench-author-scenario](../bench-author-scenario/SKILL.md)).

## Before the night: declare the budget

The standing call-budget discipline: name the cap — takes, and roughly
minutes — before the first dial, in the plan you show or log, and spend inside
it. `live-batch` enforces its own ceilings, but a night that starts without a
declared budget has no overage to notice.

## The batch runner

```
node --env-file=.env scripts/live-batch.ts <scenario[:defect][xN]> …
```

Sequential, one child process and one tunnel per take — at unattended hours,
isolation beats throughput. Its bounds are code, not intent:

- `MAX_TAKES` (12) per invocation, whatever the plan says;
- a per-take wall clock (6 min; SIGTERM first so the child hangs up its call);
- **a failed take is recorded and the batch moves to the NEXT planned take —
  never a retry.** A retry is a new plan, made by a human or by tomorrow's
  session reading tonight's log;
- after 3 consecutive failures the batch PARKS itself: infrastructure failure
  at 3am is a report for the morning, not a loop.

Single takes and the knobs live in `scripts/live-scenario.ts`: `--scenario`,
`--defect fabricateAnswer|dropCorrection|goSilentAtQuote`, `--persona`,
`--judge`. Each take freezes to `data/live-sim/<epoch>/` — transcript
(hashed), `bench-heard.wav` (both voices), `events.jsonl`, `meta.json`, and
Twilio's own dual-channel recording as the known-good capture reference.

## Degradation — provenance travels with the take

`--degrade-snr <dB>` mixes seeded babble into the caller's outbound voice, so
the far end's STT hears what a bad line would carry. Deterministic per seed;
the clean render stays untouched (a take, never a mutation of source). The
SNR lands in `meta.json` — a degraded take must never masquerade as a clean
one, and `analyze-takes` reads meta to keep distributions honest.

## Reading the night

- **Variance** — `node scripts/analyze-takes.ts data/live-sim/<epoch> …`
  (≥2 comparable takes; defect and off-scenario dirs are skipped loudly).
  Confidence spread, latency distribution, every distinct transcription per
  turn position. Some findings only exist under repetition — a homophone that
  appears in take 7 is why the batch exists.
- **Audio** — `node scripts/audio-quality.ts <take>/bench-heard.wav
  <take>/twilio-recording.wav`. Advisory flags mean LISTEN THERE, not
  "defective"; the A/B against Twilio's capture localizes a defect to our
  receive path or the send path.
- **Assertions** — already graded per take (`report.txt`); re-assess any take
  free of charge with `scripts/publish-live-run.ts` pointed at its directory.

## Fix and pin

The loop the takes feed: a take exposes a bug (a turn detector that splits a
pausing year, a probe that fires into the goodbye, dead air that wedges a
leg) → fix it → **pin it with a regression test** → cite the take id in the
comment. A lesson that lives only in a take directory is deleted with it.
Iterate assertions against the frozen takes, never by re-dialing to re-grade.

## Curation is a separate, deliberate act

Every run auto-lands its working artifact under gitignored
`data/live-sim/runs/<scenario>/<runId>/` for the web UI (point it there with
`CALLBENCH_RUNS_DIR`). Committed fixtures are CURATED: only
`scripts/publish-live-run.ts` writes `apps/web/fixtures/runs/`, by hand, for
a keeper worth citing. Auto-publishing tripped the fixture-count pins the
first time a batch ran; the pins stay, the publish stays manual.

## Morning report

Read `data/live-sim/analysis/batch-log.txt` and the take reports; figures
come from that output, never from memory. Report takes attempted, parked or
completed, PASS/FAIL/INCONCLUSIVE per take, and what got pinned. A parked
batch is a first-class outcome, not a failure to explain away.
