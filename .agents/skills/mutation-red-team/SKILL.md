---
name: mutation-red-team
description: Launch a red-team mutation-testing agent (Opus) that injects targeted regressions into callbench's production code, runs the test suite, and reports which mutations SURVIVED — surviving mutations are direct evidence of test-coverage gaps. Use when the user says "trickster", "mutation test", "break the code", "grade the tests", or to verify a load-bearing invariant has real test coverage.
---

# Mutation red-team (the trickster)

Launches an **Opus** general-purpose agent that does what a mischievous reviewer
would do if handed a *disposable copy of the repo* and told "try to break this
without the tests catching it." It picks a load-bearing invariant, silently
mutates it **in the copy**, runs `pnpm typecheck && pnpm lint && pnpm vitest
run` there, and reports the verdict.

> **Why a /tmp copy, not a git worktree.** A worktree branches off the last
> *commit*, so it can't see uncommitted work — a mutation against code that
> hasn't been committed finds nothing to mutate, and an agent that improvises
> (rsync into the worktree, then `git checkout`/`reset` to "revert") can run a
> destructive git command against the **main checkout** and wipe uncommitted
> changes. That actually happened in a sibling repo. The rule: **copy the
> working tree (uncommitted changes included) into `/tmp`, work only there, and
> never run a git write-command anywhere.** The copy is thrown away with
> `rm -rf`; the main checkout is read-only reference the agent never mutates.

**Surviving mutations are the finding.** A SURVIVED mutation means the suite
cannot distinguish broken code from working code — a concrete coverage gap
pointing at a specific invariant no test enforces. Complementary to
[test-red-team](../test-red-team/SKILL.md) (static read of tests) and
[red-team-review](../red-team-review/SKILL.md) (static read of prod code).

## When to invoke

- User says: "trickster", "mutation test", "break the code", "grade the tests"
- After a `red-team-review` finds a prod bug — mutate that invariant to confirm
  the regression test you just added actually catches future recurrences
- After any increment adds production code
- **Before the first live run**, against the dial gate and the caps
  specifically. Those two invariants are the ones whose failure costs somebody
  else something, and "we're pretty sure it's covered" is not the bar.

## How to invoke

Use the `Agent` tool with:
- `subagent_type: "general-purpose"`
- `model: "opus"`
- **Do NOT set `isolation: "worktree"`.** The agent isolates itself by copying
  the repo into `/tmp` (see the prompt template). A worktree can't see
  uncommitted work and invites the destructive-revert failure above.
- `description`: 3–5 word description (e.g. `"Mutate the dial gate"`)
- `prompt`: follow the template below — it makes copying-into-/tmp the mandatory
  first step.
- **One agent invocation per mutation.** For N mutations, issue N parallel Agent
  calls in a single message — each agent makes its **own** uniquely-named `/tmp`
  copy (include the mutation label + a unique suffix in the path) so parallel
  runs never share a directory.

## Curated mutations

Hand-pick from load-bearing invariants. Random line mutations have terrible
signal-to-noise.

**This catalog is a living artifact, not a snapshot.** Every increment that
ships production code MUST extend it with at least 2–3 mutations targeting the
invariants it locked down. An increment that adds none is claiming it froze
nothing.

### Increment 0 set (scaffold)

1. **DEBUG default inverts.** In [packages/shared/src/debug.ts](../../../packages/shared/src/debug.ts),
   change `isDebugEnabled` so it returns true under `NODE_ENV=production`. A
   test pinning the prod-default must fail.
2. **DEBUG snapshots the env at module load.** Hoist the `DEBUG_LOGGING` read to
   module scope. The runtime-toggle contract breaks — a running call can no
   longer be made debuggable without a restart.
3. **ensureDir caches.** Reintroduce a `dirCreated` boolean so the reaper test's
   mid-run directory removal permanently disables file logging.
4. **Timestamp derived twice.** Compute `new Date()` separately for the line
   stamp and the filename. The midnight-rollover test must fail. (This is the
   original bug the test was written for; it should be CAUGHT.)
5. **Data factory runs when disabled.** Move the `isDebugEnabled()` check to
   after the factory invocation. Off-mode stops being free.

### Increments 1+ — to be written as they land

The invariants each increment is expected to freeze, and therefore the
mutations it owes this catalog. Do not run these until the code exists.

- **Increment 1 (transport):** the frame parser's format assumptions; the clock
  and layer that timestamps are taken from (mutate to stamp at a different
  layer and see whether any test notices the number moved).
- **Increment 2 (speech):** the confidence signal reaching the turn record
  (mutate to a constant — if nothing fails, INCONCLUSIVE has no foundation);
  transcript append-only enforcement; the transcript hash (swap the algorithm,
  or make it a constant).
- **Increment 3 (scenarios/assertions):** **the three-state collapse** — make
  INCONCLUSIVE return FAIL, then separately make it return PASS. Both must be
  CAUGHT. A suite that survives either one cannot detect the bench lying, which
  is the single worst thing this repo can do. Also: the report's hash-mismatch
  refusal (bypass it and see if anything fails).
- **Increment 4 (hybrid tester):** probe-point enforcement — let the persona
  skip a probe and see whether the run still reports success.
- **Increment 5 (live run):** **the dial gate** — remove the human checkpoint;
  add a retry-on-drop path; raise the concurrency cap; make the wall-clock cap
  advisory. Every one of these must be CAUGHT by a fake-transport test that
  counts dial attempts. Run this set BEFORE the first live call, not after.

## Prompt template

Fill the bracketed sections. Send ONE mutation per agent invocation.

```
You are a trickster. Your job is to introduce a specific regression into
production code, run the test suite, and report whether the tests caught you.
You work ONLY inside a disposable copy of the repo under /tmp — the real
checkout is read-only reference you must never modify.

## Step 0 — make your disposable copy FIRST (before anything else)

The real repo is at REPO=/Users/adamsohn/Projects/callbench. Copy its working
tree (uncommitted changes included) into a unique /tmp directory, then work only
there:

    DST="/tmp/mutation-<label>-$(date +%s)-$$"
    rsync -a \
      --exclude='.git' --exclude='node_modules' --exclude='data' \
      --exclude='temp' --exclude='.claude/worktrees' \
      "$REPO"/ "$DST"/
    cd "$DST" && pnpm install --prefer-offline

Everything after this happens with `$DST` as your working directory.

## Rules — READ CAREFULLY

- **Never modify the real checkout.** Every edit, and every command that writes,
  happens inside `$DST`. If any tool blocks an edit because it resolved to the
  real REPO path, STOP — you are in the wrong directory.
- **Never run a git write-command anywhere** — no `checkout`, `reset`, `clean`,
  `stash`, `restore`, `rm`, `add`, `commit`. They are how the main checkout gets
  wiped. You don't need git at all: reverting means deleting `$DST`. Read-only
  git (`git status`, `git log`) is fine only inside `$DST`.
- **Never place a phone call.** This repo dials real businesses. Nothing you do
  touches the network, and no credential is needed for the test suite. If a test
  appears to want one, that is itself the finding — report it and stop.
- Apply EXACTLY the mutation specified below (in `$DST`). Do not invent other
  mutations.
- Do not touch any test file, fixture, or unrelated source. If the mutation is
  in constants, change ONLY the specified line.
- After applying, run (in `$DST`):
    pnpm typecheck && pnpm lint && pnpm vitest run
  Capture stdout+stderr. Note which step (if any) failed.
- When done, delete the copy: `rm -rf "$DST"`. That is the entire revert.

## Mutation

File: [ABSOLUTE PATH]
Change: [EXACT BEFORE → AFTER]
Reasoning-for-humans: [one sentence — which invariant this probes]

## Verdict

Report exactly:
- CAUGHT if any of the three commands failed after the mutation
- SURVIVED if all three passed

For CAUGHT: name the failing test(s). One-to-three sentence summary — specific
to the invariant, or incidental?

For SURVIVED (the interesting case): state what the mutated code now does
incorrectly, and speculate on what test would have caught it. No fix —
diagnosis only.

## Output

~150-300 words. Lead with one-word verdict. Then failing-test names (if CAUGHT)
or coverage-gap description (if SURVIVED).

Before exiting, confirm you deleted `$DST` and never wrote to the real checkout.
Report both.
```

## Reading the results

Aggregate across all mutations:

- **Mutation score** = CAUGHT / total. Under 80% is a weak suite; under 50% is
  dangerous.
- **Surviving mutations** are your prioritized list of missing tests. Every
  SURVIVED ⇒ one regression test to add.
- **Compare to prior runs** — a previously-CAUGHT mutation that now SURVIVES
  means a recent change weakened a test.
- **The safety mutations are not scored, they are gates.** A SURVIVED on the
  dial gate, the caps, or the three-state collapse is not a percentage point; it
  blocks the live run until it's CAUGHT.

Don't chase 100% — equivalent mutants exist. The point: find the
*should-be-observable* invariants that aren't.

## Cleanup discipline

**Stricter than the other red-team skills** because this agent writes code.

- The agent works in a `/tmp` copy and reverts by `rm -rf`-ing it. There is no
  git worktree and there must be no git write-command — ever, anywhere.
- Mutation output belongs **inline in the conversation**, not in a `.md` file in
  the repo.
- Before returning control: verify the real checkout is untouched — `git status`
  in `/Users/adamsohn/Projects/callbench` should show exactly what it showed
  before the run (no new/reverted files, HEAD unmoved), and no `mutation-*`
  directory should linger in `/tmp`. If the main checkout changed at all, a run
  went rogue — surface it loudly rather than papering over it.
- If you must confirm the main checkout is unharmed, read it; do not run
  anything that writes to it.
