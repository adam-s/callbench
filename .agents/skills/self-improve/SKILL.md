---
name: self-improve
description: End-of-cycle recursive improvement pass for callbench — evaluate the cycle's own performance from evidence (commits, run reports, gate history, friction), then fix the instructions (AGENTS.md, .agents/, docs/*.md) and the utilities that caused friction, each fix landing in its correct home with tests where code changed. Use at the end of an increment, after a live run, or when Adam says "self-improve", "retro", or "improve your instructions".
---

# Self-improve — the end-of-cycle recursive pass

The iteration loop fixes the *product*; this skill fixes the *system that
produced it* — instructions, guidance docs, and utilities. An agent runs it
against evidence from the cycle just finished, then lands improvements in their
correct homes. It is the codified form of AGENTS.md's "close the loop on
yourself."

## Evidence first (never improve from vibes)

Assemble the cycle's record before proposing anything:

1. `git log` for the cycle's commits — what was built, reworked, or fixed twice
   (a two-commit fix signals the first understanding was wrong).
2. Run artifacts: frozen transcripts, reports, probe dumps, punch lists —
   especially items tagged deferred or INCONCLUSIVE.
3. Gate history: what broke the gate mid-cycle and why.
4. Friction log: where an agent (including you, reading this cycle's transcript
   context) was misled by an instruction, rediscovered something a doc should
   have said, hand-did what a utility should do, or found a utility's output
   wrong or awkward.
5. **After a live run, the INCONCLUSIVE rate is the headline metric.** It's the
   bench grading itself: a probe that couldn't be evaluated is a bench defect
   before it's a target defect. Trends, not snapshots.

## The pass, in order

1. **Instruction audit.** For each friction item, classify its correct home
   (this repo's placement rule): generalized principle → AGENTS.md; fact,
   contract, or runbook → docs/ or the relevant SKILL.md; constraint code can't
   show → a code comment; behavior → code + test. A rule that names a specific
   instance is a fact in the wrong clothes — generalize it or file it as a fact.
2. **Drift check.** Verify every claim your edits touch against the repo as it
   stands (paths, scripts, exports, contracts). Never write an improvement that
   is itself drift. `docs/drivers.md` is the usual suspect — it was written from
   reasoning, not probes, and its labelled assumptions are supposed to get
   replaced by measurements as increments land. An assumption still labelled
   after the increment that should have settled it is a finding.
3. **Utility improvements.** Tools and scripts that caused friction get fixed or
   sharpened — with the full bar for production code: regression test for every
   fixed behavior, bounded/deterministic for scripts, gate green.
4. **Prune ≥ add.** Instruction edits should delete or tighten at least as much
   as they insert; guidance that grows monotonically stops being read.
   Superseded guidance is removed, not stacked on.
5. **Trace.** Write the cycle trace to `data/retros/<date>.md`: evidence items →
   decision (fixed where / accepted with reasoning / rejected why). Applied
   changes live in the commit; the trace is the reasoning record. A finding is
   fixed-and-pinned or accepted-with-reasons — never silently dropped.
6. **Gate + hand to the maintainer.** `pnpm typecheck && pnpm lint && pnpm
   vitest run` green. Instruction changes are diffs the maintainer reviews like
   any other change — self-improvement is not self-approval.

## Hard limits

- **No self-scheduling.** This skill runs when invoked at a cycle's end — never
  on a timer, never by an agent deciding to re-run itself.
- **Frozen surfaces stay frozen**: `docs/contracts/`, published contracts, and
  product invariants in AGENTS.md are flags to raise, not edits to make.
- **The safety invariants are not a self-improvement surface.** The dial gate,
  the run caps, the human-on-the-line rule, and consent are the maintainer's,
  and a cycle that found them inconvenient has found exactly what they're for.
  Propose in the conversation; never edit them as part of a retro.
- **Findings prose** written for an outside reader belongs to Adam's judgment
  loop, not this one — propose, don't write.
- One cycle per invocation; the improvements it lands should make the next cycle
  measurably smoother, not restructure the world.
