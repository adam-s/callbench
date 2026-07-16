---
name: bench-live-call
description: Run a bounded set of live calls against the real voice agent — the system under test. Walk the pre-flight gates, prepare one call at a time, hand each dial to the maintainer who listens live, freeze the evidence, grade offline, curate keepers. Use when the user says "run the calls", "dial the target", "do a live run", "call it for real", or when an increment needs evidence from the system under test. Never dials by itself; the owned-loop batch procedure is bench-live-campaign.
---

# Live call — the real target

The procedure for a phone ringing in somebody's business. Scenarios arrive
already built and rehearsed ([bench-author-scenario](../bench-author-scenario/SKILL.md));
this skill spends them, one human-started call at a time.

## Prerequisite the code makes honest: the dial primitive does not exist

`placeCall` (`scripts/lib/twilio.ts`) refuses any number the account does not
own, and refuses `CALLBENCH_TARGET_NUMBER` by name — BY DESIGN. There is no
target-mode dial in the repo today. Building it is this skill's first
prerequisite, and it goes in `scripts/lib/twilio.ts` and nowhere else: a
structural fence test pins that file as the single dial site (no other file
under `scripts/` may name `CALLS_ENDPOINT` or `Twiml`). The target-mode
primitive must require an interactive typed confirmation at the moment of the
dial — a human typing the go-ahead into the terminal, not a flag, not an env
var, nothing a loop can supply. Raise the design with the maintainer before
writing it; the fence and the guard are published contracts.

## Pre-flight — all of it, every run

Stop and ask if any item is unmet; these are maintainer-gated and not
routable-around.

1. **Consent and recording settled for THIS target** (docs/plan.md, Increment
   7). Re-settled when the target changes; a person on the line is the case
   the determination does not cover.
2. **`scripts/preflight.ts` passes.** It plans the reviewed intersection —
   only scenarios with a committed `docs/connotation/<name>.md` — enforces
   caps (calls, wall-clock, concurrency 1) through `@callbench/runplan`, and
   STOPS without dialing. Anything it excluded stays excluded.
3. **The static gate is green** — `pnpm typecheck && pnpm lint && pnpm vitest
   run`. A bench with a red suite has no standing to report anybody's bugs.
4. **Every scenario in the plan rehearsed**: assertions watched failing on the
   simulator, live owned takes clean
   ([bench-live-campaign](../bench-live-campaign/SKILL.md)).
5. **Business hours considered** — the maintainer picks the window.

## The dial

**GATE — the maintainer starts every dial, one at a time, listening live.**
Prepare one call: the scenario, the probe points, the target number read back
explicitly, the remaining budget, where the evidence lands. Then stop and hand
over (`afplay .agents/assets/chime.wav`). The maintainer on the line is the
human-on-the-line mechanism: **a person answering means identify the call as a
test and end it** — never run a probe, a persona, or an authority claim
against a person. A payment solicitation is recorded and supplied nothing. A
call that goes off the rails is INCONCLUSIVE, which is a real result. None of
these is a retry trigger; there is no path from a bad call to another call.

**First real-target call is scripted — reviewed text only.** Every word spoken
comes verbatim from lines that passed the connotation gate. `--persona`
(model-improvised conversation) is for later calls only, and only after the
maintainer settles how the connotation gate applies to generated lines — a
line invented mid-call was never reviewed, and that question is the
maintainer's to answer, not this skill's to optimize away.

## After each call — freeze, then iterate offline

1. **Freeze** — audio, transcript, timings, hashed (the driver does this; the
   artifact refuses on mismatch).
2. **Grade offline, against the frozen take.** The record/assert split is
   proven live: `scripts/publish-live-run.ts <take-dir>` re-assesses a frozen
   take with zero calls. When an assertion misfires, fix the assertion and
   re-run it against the same take — **never redial to re-grade.** One
   recording backs a thousand assert runs.
3. **Report every outcome** — PASS, FAIL, INCONCLUSIVE, with spans. Figures
   come from the run's output, never memory.
4. **One call is an anecdote.** No finding without a rate and its denominator,
   or determinism across runs.
5. **Stop at the budget.** Interesting is a reason to tell the maintainer, not
   to dial again.

## Curation — a separate, deliberate act

Working takes live under gitignored `data/live-sim/`. A keeper becomes a
committed fixture only through `scripts/publish-live-run.ts` (into
`apps/web/fixtures/runs/`) — never automatically; the fixture-count pins exist
to catch exactly that (auto-publish tripped them the first time a batch ran).
Publish the takes worth citing; leave the rest where they fell.

## Findings

Observed behavior plus the input that produced it; every claim traces to a
transcript span. Never characterize the system or its builder — a finding that
cannot survive being read aloud to its author is written wrong. The prose is
the maintainer's, in the maintainer's voice, after the connotation pass
([AGENTS.md](../../../AGENTS.md)). Propose; don't ship.
