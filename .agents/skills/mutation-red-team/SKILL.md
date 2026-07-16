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

### Increments 1+ — extended as each lands

The invariants each increment freezes, and the mutations it owes this catalog.
Entries marked "verified CAUGHT" have run against landed code; the rest wait on
their increment. Built so far: 1 (transport), 2 (speech: transcript, stt, tts,
turn), 3 (simulator), 4a (assertion layer), 4b (the judge), the scenario runner,
5 (web UI — routes, run-artifact contract, dial fence, the audio centerpiece
engine + waveform + serving, and temporal dataviz), and 7a (live-run pre-flight,
`packages/runplan`). The live-dial surfaces (loopback, first live scenario, the
hybrid persona, the real run) are ahead — each needs a maintainer-started dial.

- **Increment 1 (dial guard) — CRITICAL, verified CAUGHT:** in
  `scripts/lib/twilio.ts`, neuter `assertDialAllowed`'s ownership check
  (`if (!match)` → `if (false && !match)`) so it dials any number. The
  `scripts/lib/__tests__/twilio.test.mjs` suite must fail. This mutation
  SURVIVED the first time it was run — the guard had no committed test — which
  is why the test exists; a survival here means the single most
  safety-critical check in the repo is unprotected. Also: change the
  digit-normalized compare (`digits(to) === digits(target)`) to a raw `===`,
  reintroducing the format-slip the guard was built to close. Re-run 2026-07-16,
  CAUGHT — but the catcher there was typecheck (TS18048: with `if (false &&
  !match)` the `match` binding no longer narrows, so `String(match.phone_number)`
  trips strict null checks), which is incidental and fragile. The pin to trust is
  behavioral: `twilio.test.mjs`'s "REJECTS a number the account does not own"
  (target env unset) and the placeCall refusal tests. The guard-SKIP variant the
  ownership neuter does not reach — deleting the `assertDialAllowed` call site —
  is the 2026-07-16 block below.
- **Increment 1 (transport):** in `packages/transport/src/twilio/frames.ts`:
  change `TWILIO_MEDIA_FORMAT.sampleRate` to 16000 (the frozen measured fact —
  verified CAUGHT at landing); coerce `sequenceNumber`/`chunk`/`timestamp` to
  numbers in `parseMessage` (the wire-string quirk); make `parseMessage` drop
  unrecognized events instead of tagging them `unknown` (silent-swallow — the
  surface-interventions invariant); strip `streamSid` from `mediaMessage`
  output. Once the adapter lands: stamp `atMs` from `Date.now()` deltas instead
  of the monotonic clock, and stamp after parsing instead of at socket read —
  the clock/layer contract in `contract.ts`.
- **Increment 2 (speech):** the confidence signal reaching the turn record
  (mutate to a constant — if nothing fails, INCONCLUSIVE has no foundation);
  transcript append-only enforcement; the transcript hash (swap the algorithm,
  or make it a constant).
- **Increment 3 (simulator):** disable a deliberate-defect switch so the
  simulator behaves *correctly* where a test expects it to misbehave. Every
  assertion that depends on that defect must fail. If the suite stays green, the
  assertions are not reading what they claim to read — and the simulator's whole
  purpose is defeated, since a target that can't be made wrong proves nothing.
- **Increment 4 (scenarios/assertions/judge) — three-state collapse, verified
  CAUGHT:** in `packages/assert/src/outcome.ts`, change the `inconclusive`
  constructor to return `'PASS'`, then separately `'FAIL'`. Each must fail the
  suite (6 tests each at landing). A single constructor is the only way to build
  an INCONCLUSIVE result precisely so this mutation has one place to bite. Both
  must be CAUGHT. A suite that survives either one cannot detect the bench lying,
  which is the single worst thing this repo can do. Also: the report's
  hash-mismatch refusal (bypass it and see if anything fails). And the judge:
  - **Cache key drops a component — verified CAUGHT:** in
    `packages/judge/src/judge.ts`, hardcode `text: input.text` to a constant in
    `cacheKey` (or drop rubric version / model). A stale verdict now replays for
    changed input; the cache-key tests fail (6 at landing). It is the *whole*
    determinism story — there is no temperature knob behind it.
  - **Judge INCONCLUSIVE coerced — verified CAUGHT:** coerce INCONCLUSIVE to
    FAIL/PASS on cache replay (the `if (hit) return` line) or in `parseReply`.
    The calibration-replay tests fail. Same severity as the assertion-layer
    collapse, one stage upstream.
  - **Verdict recorded as fact** — drop the rubric/reasoning/provenance and
    store a bare boolean. A test should notice that a judgment stopped being
    labelled as one.
  - **Cache miss reachable under test** — make the judge call the provider. The
    suite must fail for wanting a credential, not quietly acquire one.
- **Scenario runner (`packages/scenario`) — verified CAUGHT:** the runner joins
  the record phase (drive the simulator to a frozen transcript) and the assert
  phase (code + judged assertions → one report). Each mutation below failed the
  9-test scenario suite when injected:
  - **Structural abstention collapses** — in `assess`, change the judged-
    assertion abstain (material absent) from `'INCONCLUSIVE'` to `'PASS'`. The
    same bench-lies collapse as the assertion layer, one seam over.
  - **The model is consulted when it must abstain** — change the `input === null`
    guard to `if (false)` so an absent excerpt reaches `judge()`. The forbidden-
    runner test (a runner that throws if called) must fail — a judged assertion
    must never reach the network for a question the transcript cannot answer.
  - **Verdict counts not aggregated** — drop the `for (const v of verdicts)`
    count loop so judged outcomes vanish from the headline counts. A judgment
    that isn't counted is a finding the report hides.
  - **Judged assertions skipped silently** — neuter the "judged assertions but
    no judge context" throw (`if (false)`), so a scenario's semantic checks are
    dropped without a word instead of refused loudly.
  - **Hash-refuse gate bypassed** — neuter the `verifyFrozen` refusal in
    `assess`; a drifted transcript must refuse a report, not produce one.
- **Increment 5 (web) — verified CAUGHT:** the run-artifact contract
  (`packages/scenario/src/artifact.ts`) and the server run store
  (`apps/web/src/lib/server/runs.ts`). Each mutation below failed its suite when
  injected:
  - **Load without the hash-refuse** — bypass `verifyFrozen` in
    `parseRunArtifact`. A drifted on-disk artifact would render as evidence; the
    artifact suite fails.
  - **Accept any artifact version** — neuter the `artifactVersion !== 1` refusal.
    A future/unknown shape mis-parses instead of refusing.
  - **Drop the mislabel refusal** — neuter the folder-vs-fields check in
    `loadRun`. A run.json served under the wrong id (path→identity broken) is no
    longer refused.
  - **Fence always open** — make `canReplay` return `true`. A system-under-test
    run would offer a replay control; the fence-predicate test fails.
  - **THE DIAL FENCE, structural (capability-level)** — `runs.test.ts` walks
    every app source file (`.ts/.mts/.cts/.js/.mjs/.cjs/.svelte`) and fails on
    any outbound-network, media-egress, or telephony primitive: `fetch(`,
    `XMLHttpRequest`, `RTCPeerConnection`, `WebSocket`, `getUserMedia`,
    `@callbench/transport`, `sendAudio`, telephony vendor names (twilio, telnyx,
    vonage, plivo, …), `Calls.json`, the dial guard, the number env vars, the
    dial script. It asserts the ABSENCE of the dial CAPABILITY, not one vendor —
    a dial fundamentally needs network egress or WebRTC/media egress, so a dial
    built from any vendor or in any file type trips it (a `telnyx` fetch is
    caught where a Twilio-only denylist would miss it). Still only as wide as the
    capability list; extend it if a new egress primitive appears. Sneak any of
    these into an app file and the test fails.
  - **Report body drift** — bypass the `bodyHash` recomputation in
    `parseRunArtifact`. A `run.json` with a FAIL edited to PASS (transcript
    untouched, so `verifyFrozen` still passes) would render as evidence; the
    body-drift test fails.
  - **Assertion-name collision** — drop the uniqueness check in
    `buildRunArtifact`. Two findings sharing a name make a deep link unreachable
    and mislabeled; the collision test fails.
  - **Path traversal** — remove `assertSafeSegment` in `loadRun`. A URL segment
    of `../../…` reads outside the runs directory; the traversal test fails.
  - **Silently dropping a broken run** — make `listRuns` drop a run that fails to
    load instead of surfacing it as `broken`. Corrupt evidence vanishes from
    every navigational surface (against append-only / surface-interventions); the
    broken-surfacing test fails.
- **Increment 5 (audio centerpiece) — verified CAUGHT:** the run-audio contract
  (`artifact.ts` `RunAudio` + bodyHash coverage), the serving path
  (`runs.ts readRunAudio`, `waveform.ts`), and the ported engine
  (`transport.svelte.ts`, tested in the jsdom project). Each mutation failed its
  suite:
  - **Serve audio without the hash check** — bypass the `sha256` compare in
    `readRunAudio`. A WAV that drifted from its frozen hash would be served; the
    audio-drift test fails.
  - **Drop audio from the body hash** — remove `audio` from `computeBodyHash`.
    A swapped `audio.file`/`sha256` in run.json would go undetected; the
    audio-reference tamper test fails.
  - **Accept a non-PCM16 WAV** — neuter the format check in `parsePcm16Wav`. A
    RIFF/WAVE file in another format would be mis-decoded into a wrong picture
    instead of refused; the non-PCM16 test fails.
  - **Make destroy() non-reinitializable** — remove the state reset in the
    engine's `destroy()`. A run/finding reused across navigation resumes a closed
    AudioContext and plays silently (the centerpiece breaks on the 2nd view); the
    jsdom "rebuilds a fresh AudioContext after destroy" test fails.
  Still owed: point a finding's deep link at the wrong span; derive a DISPLAYED
  figure from the browser's `AnalyserNode` and feed it back into a report (the
  replay-pipeline-measures-nothing rule — the engine must stay render-only).
- **Increment 6 (hybrid tester):** probe-point enforcement — let the persona
  skip a probe and see whether the run still reports success.
- **Increment 7a (live-run pre-flight, `packages/runplan`) — verified CAUGHT:**
  the bounds and gates a run clears before it starts. Each mutation failed its
  suite:
  - **RunBudget stops enforcing** — make `started()` not throw past a cap. A
    runner that ignores `canStart()` could exceed the call/wall-clock/concurrency
    bound; the enforcement tests fail.
  - **Caps accept unbounded** — neuter `assertPositiveFinite`. `Infinity`/0/NaN
    caps pass; the "caps must be real bounds" tests fail.
  - **Connotation gate removed** — a run for a scenario whose outward text was
    never reviewed would be planned; the connotation-gate test fails.
  - **Consent gate removed** — a system-under-test run without consent settled
    would be planned; the consent-gate test fails.
  Also structural: `runplan` imports no transport/dial primitive (a planner that
  could dial is the human-in-the-loop invariant defeated) — the no-dial scan
  fails if one is introduced.
- **Increment 7b (live run):** **the dial gate** — remove the human checkpoint;
  add a retry-on-drop path; raise the concurrency cap; make the wall-clock cap
  advisory. Every one of these must be CAUGHT by a fake-transport test that
  counts dial attempts. Run this set BEFORE the first live call, not after.
- **2026-07-16 — the any-vehicle generalization + fixes — verified CAUGHT:** the
  bench came off the welded-in A3. The simulator flow is now script-driven
  (`step(memory, heard, defects, script)` over a `SimScript` from
  `scriptFromFactSet`), the requirement verdict and its accusation gate ride on a
  committed fact set (`@callbench/factset`), and the fabrication switch was
  renamed `fabricateCamera` → **`fabricateAnswer`** (increment-03 amendment) —
  wherever older catalog text says "the camera-fabrication switch", it means
  `fabricateAnswer` now, one switch in both fitment directions. Nine mutations
  run this day, all CAUGHT:
  - **Pacer burst — drop the schedule guard:** in
    `packages/transport/src/twilio/pacer.ts` `pump()`, change the send loop
    `while (queue.length > 0 && anchor + sent * FRAME_MS <= horizon)` →
    `while (queue.length > 0)`, so one pump drains the whole queue and every frame
    hits the wire at once — the 31931 dump the pacer exists to prevent. 6 tests
    failed (`pacer.test.ts` ×5 — "sends only the lead", the pacing / absolute-
    schedule / lead-property tests — and `session.test.ts` ×1).
  - **placeCall skips the guard:** in `scripts/lib/twilio.ts` `placeCall`, delete
    the `await assertDialAllowed(sid, token, params.to)` line so the POST leaves
    unguarded. The guard is folded into the primitive precisely so this cannot be
    done silently. 3 `twilio.test.mjs` tests failed, including "dials … guard
    first" (the guard-BEFORE-POST ordering — an IncomingPhoneNumbers GET must
    precede the Calls.json POST) and both placeCall refusal tests.
  - **polarity always-affirmed:** in `packages/assert/src/assertions.ts`
    `polarity()`, collapse the match-loop if/else to `affirmed = true` (drop the
    `negated` branch), so an honest decline reads as a claim. 5
    `assertions.test.ts` tests failed — the "honest declines, variously worded,
    are never reported as fabrication" set and the reads-all-four-as-declines
    PASS. This is the accusation-of-an-honest-shop path, the worst output the
    bench can produce.
  - **mayAccuse wide open:** in `packages/factset/src/factset.ts` `mayAccuse`, add
    `return true` as the first line, so a researched guess can accuse a real
    business. 2 `factset.test.ts` tests failed (refuses-a-RESEARCHED-fact,
    refuses-below-high / not-never-offered).
  - **researched-at-high refusal neutered:** in
    `packages/factset/src/factset.ts` `loadFactSet`, `if (f.provenance ===
    'researched' && f.confidence === 'high')` → `if (false && …)`, so a tool's
    candidate claiming verified-grade loads instead of being refused. Caught by
    the dedicated "refuses a researched fact claiming high confidence" test (and
    incidentally by lint `noConstantCondition` — the behavioral test is the pin).
  - **Fitment verdict flip:** in `packages/assert/src/assertions.ts`
    `requirementAnswer`, `const defectIsClaim = fitment === 'never-offered'` →
    `!==`, inverting the never-offered vs standard verdict polarity (a fabrication
    reads PASS, an honest decline reads FAIL). `assertions.test.ts`'s standard-
    fitment CLAIM-is-PASS / DECLINE-is-FAIL and the never-offered "FAIL when the
    fabricateAnswer defect is on" must fail. (verified CAUGHT 2026-07-16 — the
    standard/never-offered flip tests pin it directly.)
  - **Accusation gate severed in the spec:** in `packages/factset/src/spec.ts`
    `requirementSpecFor`, hardcode `mayAccuse: true` in the returned spec (drop
    the `mayAccuse(feature)` call), so a weak fact regains the accusation license
    the fact-set rule denied it. `spec.test.ts`'s "a weak fact keeps its probe but
    loses its accusation license" must fail. (verified CAUGHT 2026-07-16 — the
    weak-fact test pins it directly.)
  - **Simulator fabricateAnswer made dead:** in `packages/simulator/src/flow.ts`
    `step`, the `quoted` case's `defects.fabricateAnswer ? feature.dishonest :
    feature.honest` → always `feature.honest`, so the target can no longer be made
    to lie — and an assertion that cannot be watched failing is one you cannot
    trust. `flow.test.ts`'s fabricateAnswer never-offered/standard tests and
    `assertions.test.ts`'s "FAIL when the fabricateAnswer defect is on" must fail.
    (verified CAUGHT 2026-07-16 — the flow tests and the assert FAIL test pin it.)
  Still owed for a future run (entry added 2026-07-16, verify on next run):
  - **Pacer flush leaves its timer:** in `pacer.ts` `flush()`, remove the
    `if (timer !== null) { clearTimer(timer); timer = null; }` block. `push()`
    defers to a live timer, so the first frame after a barge-in waits out the
    stale interval. `pacer.test.ts`'s "flush cancels the pending pump, so the next
    utterance starts now" must fail.
  - **A question graded as its own answer:** in `assertions.ts` `requirementAnswer`,
    drop the interrogative exclusion in `statesSubject` (the
    `!sentence.trim().endsWith('?')` guard), so a target's disambiguating question
    ("does it have a forward-facing camera?") is read as its answer. The engine's
    "a target's own question is never its answer" rule — `assertions.test.ts`'s
    "the target's own disambiguating question is never graded as its answer"
    (expects the span at the ANSWER turn, not the question) must fail.
  - **Held-out leak:** the held-out sets are only held out if nothing lets them
    leak into the answer key. Copy a substantive held-out utterance into
    `extraction-cases.json` (the development set) or into `prompts/extract.md`, or
    duplicate a `heldout-a` turn into `heldout-b`. `scripts/probes/__tests__/heldout.test.ts`'s
    disjointness / no-leak / adversarial-B tests must fail.

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
      --exclude='.git' --exclude='node_modules' \
      --exclude='.env' --exclude='.env.*' \
      --exclude='data' --exclude='temp' --exclude='.claude/worktrees' \
      "$REPO"/ "$DST"/
    cd "$DST" && pnpm install --prefer-offline

Everything after this happens with `$DST` as your working directory.

Two exclusions carry their reasons, because both are load-bearing:

- **`.env` never leaves the real checkout.** It holds provider credentials and
  the target's number. `/tmp` is world-readable and this copy is not cleaned up
  on a crash. The suite needs no credential (see the rules below), so omitting it
  costs nothing and including it is a leak that outlives the run.
- **`data` stays excluded, and that is a feature.** `data/` is gitignored raw
  capture — it does not exist on a fresh clone, so no test may depend on it.
  Fixtures are *committed*, alongside the source they test, and rsync brings them
  automatically. If a mutation run reports failures that vanish when `data/` is
  present, the finding is not about the mutation: a test is reading uncommitted
  capture and would fail for anyone else. Report that.

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
  appears to want one, that is itself the finding — report it and stop. This
  holds even where a stage calls a provider in production: a judge that scores an
  assertion reads a *cached* verdict under test, and a cache miss that reaches
  for a key is the finding, not an inconvenience to work around.
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
