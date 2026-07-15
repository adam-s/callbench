---
name: red-team-review
description: Launch a red-team bug-finding code reviewer (Opus) to find real bugs, correctness issues, concurrency hazards, and safety-gate holes in callbench's production code — not style nits. Use when the user asks for a "red team", "bug hunt", "red-team review", or at the end of a session before declaring it done.
---

# Red-team review (production code)

Launches an **Opus** general-purpose agent as a red-team code reviewer of the
callbench source tree. Pairs with [test-red-team](../test-red-team/SKILL.md)
(hunts weak tests) and [mutation-red-team](../mutation-red-team/SKILL.md)
(empirical: do the tests actually catch bad code).

## When to invoke

- User says: "red team", "bug hunt", "red-team review", "find what's broken"
- **At every increment checkout.** An increment is not done until this has run
  and the maintainer has acknowledged any CRITICAL/HIGH findings.
- **Before any live run.** A bug in this bench costs somebody else's phone line.
- Before any change to the dial gate, the run caps, the transport seam, or the
  three-state outcome.

## How to invoke

Use the `Agent` tool with:
- `subagent_type: "general-purpose"`
- `model: "opus"`
- `description`: 3–5 word description (e.g. `"Red-team transport seam"`)
- `prompt`: follow the template below

## Prompt template

Fill the bracketed sections with current project context. Do NOT send the
template as-is.

```
You are a red-team code reviewer performing a bug review on callbench, a test
bench that places phone calls into voice-AI systems it does not own and asserts
on what they say. You find real bugs, correctness issues, concurrency hazards,
and holes in safety gates — NOT style nits. Rank findings CRITICAL / HIGH /
MEDIUM / LOW.

## Project

/Users/adamsohn/Projects/callbench

pnpm monorepo, TypeScript strict, Vitest. Seams behind contracts: transport
(Twilio Media Streams first), stt, tts, scenario, assertions. A scenario drives
a call; every utterance lands in an append-only, hashed transcript with
timings; deterministic assertions read that transcript and emit PASS / FAIL /
INCONCLUSIVE with transcript spans. Read AGENTS.md and docs/architecture.md
before reviewing — the product invariants there are the spec.

## What changed since last review (if applicable)

[Bullet list with file:line anchors. If no prior review, point at the
increment whose work just landed.]

## What to look for — adapt to surface

The highest-severity class in this repo is anything that could place a call
that a human did not approve, or place more calls than authorized. Weight it
accordingly.

- **The dial gate.** Any code path that reaches a dial without a human in
  between. Retry-on-failure, redial-on-drop, a scheduler, a loop over
  scenarios, a test that can dial, a `--yes` flag that retires the gate, an
  error handler that "recovers" by calling again. A bench one bug away from
  flooding a business line is CRITICAL, not HIGH.
- **Caps.** Unbounded defaults, a cap read but not enforced, a cap enforced per
  scenario but not per run, concurrency > 1 reaching a single-line target, a
  wall-clock cap that doesn't stop an in-flight call.
- **The three-state outcome.** Anywhere INCONCLUSIVE can silently collapse into
  PASS or FAIL — a default branch, a boolean coercion, an `??` that swallows
  undefined, a filter that drops unevaluated assertions before counting. This
  is how the bench lies; treat it as a correctness bug, not a design nit.
- **Transcript integrity.** Rewrites of an append-only record, a hash computed
  over the wrong bytes, a report that renders despite a hash mismatch, spans
  that don't actually anchor to what the assertion claims.
- **Timing.** Two stamps from different clocks or different layers subtracted
  into a "latency" figure. A duration derived from a provider event minus a
  local wall clock. Timestamps taken after buffering. These produce confidently
  wrong numbers that will be reported to a stranger as fact.
- **Media loop.** Backpressure on the audio stream, an unbounded buffer, frames
  dropped silently, sequence/ordering assumptions, a WebSocket that reconnects
  by itself, an exception in the media path that ends a live call.
- **Human-on-the-line handling.** Any path where a probe, a persona, or an
  authority claim can run against a person. The escalation probe taking the
  transfer rather than verifying the offer exists.
- **Secrets and privacy.** Provider tokens in logs, recordings written outside
  the gitignored data dir, scenario-supplied fake identity (names, numbers,
  payment strings) reaching a log unredacted, a transcript of a real business's
  call promoted into the repo.
- **Provider coupling.** A shared stage that re-derives identity from one
  provider's quirk, a core module that learns which adapter produced a turn,
  a stage typed for its first provider.
- **Concurrency.** Two runs sharing a data dir or an artifact path, a scenario
  and the media loop racing on state, a freeze racing an in-flight write
  (multi-part writes are atomic — all parts or none).

## Output format

300–500 words. Group by severity. For each finding:
- file:line reference
- one-sentence description of the bug
- one-sentence trigger condition
Do NOT propose fixes — diagnose only. End with a one-sentence risk delta vs the
previous review if one exists.

Be terse. Be specific. Find real bugs.
```

## Cleanup discipline

- Read-only by design. The agent should not write files.
- **Never run a git write-command** — no `checkout`, `reset`, `clean`, `stash`,
  `restore`, `add`, `commit`. This review only reads. "Leave `git status` clean"
  means *don't create changes*, never *run git to erase them* — a reset here can
  wipe uncommitted work (it has happened in a sibling repo). Read-only git
  (`status`, `log`, `diff`) is fine.
- **The agent never dials.** It reviews code. If a review needs live behavior to
  settle a question, that's a probe the maintainer authorizes, not something the
  reviewer does.
- Temporary prompt files → delete after the agent returns.
- The agent's findings belong **inline in the conversation**, not in a `.md` file
  in the repo unless the maintainer explicitly asks.
- Final `git status` should be unchanged from before the run; verify by reading,
  not by mutating.
