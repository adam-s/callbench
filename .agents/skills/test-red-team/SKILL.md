---
name: test-red-team
description: Launch a red-team reviewer (Opus) to find bugs IN callbench's TEST SUITE — tautological assertions, weak oracles, fixtures that lie about real call audio, coverage gaps around the dial gate and the three-state outcome. Use when the user says "red team the tests", "audit the tests", "find weak tests", or after an increment adds a batch of tests.
---

# Test-suite red-team review

Launches an **Opus** general-purpose agent to find bugs *in the tests
themselves*, not the production code. Tests create false confidence in three
ways: tautological assertions, fixtures that lie about the real surface, and
coverage that looks broad but skips the hard paths.

This repo has a specific hazard the sibling repos don't: **the suite cannot dial,
so every test of call behavior runs against a recorded fixture.** That's the
right design and it's also the biggest available source of lies. A fixture is a
claim about what a live call sounds like, and claims drift.

Complementary to [red-team-review](../red-team-review/SKILL.md) (production
code) and [mutation-red-team](../mutation-red-team/SKILL.md) (empirical: does
the suite actually catch bad code).

## When to invoke

- User says: "red team the tests", "audit the tests", "are our tests rigorous",
  "find weak tests"
- After any increment that adds tests — fresh batches hide tautologies
- After a `red-team-review` finds a prod bug the tests didn't catch — ask "why
  didn't our tests find this?" and run this skill
- Before declaring an increment done if it shipped contract tests

## How to invoke

Use the `Agent` tool with:
- `subagent_type: "general-purpose"`
- `model: "opus"`
- `description`: 3–5 word description (e.g. `"Red-team transcript tests"`)
- `prompt`: follow the template below

## Prompt template

Fill the bracketed sections. Do NOT send as-is.

```
You are a red-team code reviewer performing a bug review on the TEST SUITE of
callbench. Your target is the correctness and rigor of the tests themselves —
NOT the production code. You find tautological assertions, weak oracles,
fixture lies, and coverage gaps. Rank CRITICAL / HIGH / MEDIUM / LOW.

## Setup

Repo: /Users/adamsohn/Projects/callbench
Stack: pnpm monorepo, TypeScript strict, Vitest. Tests live in `__tests__/`
directories alongside their source. The suite NEVER touches the network — every
seam that would (transport, stt, tts) sits behind a contract and is tested
against recorded fixtures. Read AGENTS.md and docs/architecture.md first.

## Target surface

[tree -L 4 of every __tests__/ directory + paths to fixtures and harnesses]

## What's worth checking — the "how tests lie" checklist

1. **Tautological assertions.** Pick 3-5 assertions per file. Ask: "if the
   production code were replaced with `return null` / `return []` / a no-op,
   would this test fail?" If no, the test is vacuous.

2. **Weak oracles.** Length-only checks where contents matter.
   `.toBeDefined()` where shape matters. Hash checks that don't pin the input.
   A transcript assertion that checks a turn exists but not what it says or
   when.

3. **Fixture lies — the big one here.** Recorded audio and transcript fixtures
   are hand-trimmed stand-ins for a live call. Do they carry the real frame
   format, the real timing jitter, the real partial/interim STT results, the
   real silences? An adapter that passes against a clean fixture and fails
   against a live stream is the exact failure this repo exists to avoid
   inflicting on others. Check especially: is any fixture hand-authored rather
   than captured?

4. **Fixture drift.** Fixtures captured from a provider that has since changed
   its frame shape or event sequence. Does the current adapter still produce
   requests matching the captured payload, or has the code drifted while the
   fixture stayed?

5. **The dial gate is untestable-by-construction — is it tested anyway?** The
   suite can't dial, so the gate's enforcement must be proven with an injected
   fake transport that RECORDS dial attempts. Is there a test that fails if a
   retry path, an error handler, or a loop reaches a second dial? If not, the
   single most important invariant in the repo has no test.

6. **Caps.** Same shape: a test that asserts a run stops at its cap needs a fake
   transport counting calls. Is the wall-clock cap tested at all, or only the
   count cap?

7. **The three-state outcome.** Is there a test where an assertion legitimately
   cannot be evaluated, asserting the result is INCONCLUSIVE and NOT
   pass-or-fail? A suite that only tests PASS and FAIL leaves the state that
   exists to prevent lying completely uncovered.

8. **Timing math.** Are latency derivations tested with fixed synthetic
   timestamps and a known expected duration, or only with "is a number"? A
   timing function that returns a constant would pass a weak test and produce a
   confidently wrong figure reported to a stranger.

9. **Transcript integrity.** Is append-only actually asserted (attempt a rewrite,
   expect refusal)? Is the hash pinned input→output, or only checked for
   length? Does a test prove the report REFUSES on hash mismatch, rather than
   just that it renders on match?

10. **Coverage gaps.** Error branches: provider 500, malformed frame, WebSocket
    drop mid-call, unintelligible audio, a scenario whose probe point is never
    reached. Each maps to a reported outcome; each needs a test.

11. **Assertion granularity.** Order matters or doesn't, depending on the
    surface — turns in a transcript are ordered and that ordering is load-
    bearing. Was ordering actually asserted where it matters?

## Output

300-600 words. Severity-grouped. For each finding:
- file:line reference
- one-line description of why the test is weak
- concrete trigger: "an implementation that does X would still pass this"

No fixes — diagnose only. "No CRITICAL issues found" is valuable signal; say so
explicitly.
```

## Cleanup discipline

Same rules as [red-team-review](../red-team-review/SKILL.md) — read-only, agent
never dials, findings inline in the conversation. **Never run a git
write-command** (`checkout`, `reset`, `clean`, `stash`, `restore`, `add`,
`commit`); "leave `git status` clean" means don't create changes, not run git to
erase them. Verify the tree is unchanged by reading, not mutating.
