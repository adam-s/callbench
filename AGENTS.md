# AGENTS.md

Canonical instructions for coding agents in this repo. Agent-specific entry
points (e.g. [CLAUDE.md](CLAUDE.md)) reference this file; shared resources
(skills, references) live under [.agents/](.agents/).

**This file holds generalized principles and policy only — never a specific
fact, path, constant, name, or recipe.** Project specifics live where they can
be verified and version-controlled: [docs/](docs/), per-increment contracts,
tests, and code comments. If a rule here names a particular instance, it's in
the wrong place — rewrite it as a principle, or move the fact to the code. Any
example below is one illustration of many, not a spec.

## What this is

A test bench for voice agents reached over the phone. The bench places a call
into a system it does not own, talks to it, and produces a deterministic,
diffable record of what happened — transcript, timings, and assertion results.
The system under test is somebody's live business line. That single fact drives
most of the policy below.

Orientation, architecture, and the plan of work live in [docs/](docs/); read
them before building. Work ships in numbered increments; each takes the
previous one's frozen output as its only input and ends by passing the checkout
gate.

## Language & voice

- Do not use "kill" except for the Unix `kill` command. Use stop / end / halt /
  exit / close / cancel / interrupt / terminate / abort.
- **Two kinds of text here are outward-facing, and both get a connotation pass
  before they ship**: the words a scenario SAYS on a live call, and the
  findings written up for a human reader. Read each phrase three ways: what it
  literally claims (true, precise, verifiable?), what it implies about the
  writer, and every second parse a fast, uncharitable reader could take. The
  worst reasonable reading is the reading. **The pass is a GATE with a visible
  artifact**: before outward text ships, produce and SHOW the phrase→readings
  and run the AI-register checklist (no "not-X-but-Y", no rule-of-three
  padding, no throat-clearing, plain words). A draft not shown with its
  readings is not finished — this pass gets silently skipped under task
  pressure, so the readings must exist as output where their absence is
  visible.
- **A finding is a claim about someone else's system, and it will be read by
  the person who built it.** Describe the observed behavior and the input that
  produced it; let the reader draw the conclusion. Never characterize the
  system's quality, the builder's competence, or what "should" have been
  obvious. A finding that cannot survive being read aloud to its author is
  written wrong, not brave.
- Explanatory prose: constraint first, then why the naive approach fails, then
  the actual mechanism — plain declarative sentences. Reference-shaped content
  (contracts, schemas) is rigid, predictable, and enthusiasm-free. See
  [.agents/reference/](.agents/reference/).

## Operator attention

Two chimes, two meanings — play the right one once, at the moment it applies:

- **Your move** — work blocks on the maintainer (an approval, a dial, a
  question): `afplay .agents/assets/chime.wav`
- **Done** — a substantial arc of work completes (an increment lands green, a
  call run finishes): `afplay .agents/assets/chime-done.wav`

No chime for routine status updates; a sound that fires constantly stops
meaning anything.

## Iteration

**The loop, in order.** Every iteration runs this cycle; the numbered rules
below are its steps in detail. Naming it here so no one has to reassemble it
from three separate rules:

> **search → probe → build → gate → red-team → mutation-check → record**

- **search** the prior art (§2) — don't re-derive a solved thing.
- **probe** what's uncertain (§3) — a claim from the search is settled by
  observation, not adopted on faith.
- **build** the scoped work (§1's "done when").
- **gate**: the static checkout gate green (types, lint, unit tests) — the
  floor. The exact command lives in the Tests + build section, not here.
- **red-team** at checkpoints (§4): production code, then tests.
- **mutation-check** (§4): mutate to confirm the suite actually bites; a
  surviving mutation is a coverage gap to close before the iteration ends.
- **record** what was frozen and learned (§5, §6) in its correct home — the
  contract, the references doc, a code comment — pruning as much as you add.

Not every step produces a large artifact every time, but every step is
*considered* every time; skipping one is a decision, not a default.

1. **Plan first.** Scope the work and its "done when" gate before starting.
   Don't build what the maintainer hasn't asked for.
2. **Search before you build — every feature, every time.** Before implementing
   anything new, look for how it has already been solved: the vendor's own
   documentation first (a platform primitive beats a mechanism you wrote because
   you didn't read the page), then **GitHub** — working repositories, the
   canonical sample, and the issue tracker, where the failure you are about to
   hit is often already described — then academic research, then the wider web.
   Record what you find in the references doc so the next agent inherits the
   search instead of repeating it.

   This is not a suggestion to be thorough; it is a rule because the cost is
   asymmetric. A day spent re-deriving a solved thing looks identical, from the
   inside, to a day spent working. The tell is that you are reasoning about
   behavior instead of reading about it.
3. **Probe before building.** When behavior is uncertain, write an empirical
   probe and observe — facts, then code. This outranks the rule above: someone
   else's documentation is a claim, and a claim is what a probe is for.
   Unverified assumptions stay labelled until a probe confirms them; a claimed
   *limit* or *blocker* is an assumption too (measure before asserting the
   ceiling). When extracting from an external surface (a media stream, an API,
   an audio frame), capture its real shape before writing the parser, and treat
   a silent empty/zero result as a re-probe signal — assumption drift, not
   "nothing there".
4. **Pin what you fix.** Every fixed behavior gets a regression test; every
   locked-down interface gets a contract test.
5. **Red-team at checkpoints.** Review the production code, then the tests,
   then mutate to confirm the suite actually bites.
6. **Record, generalized.** Accepted tradeoffs are recorded where the knowledge
   lives (a code comment, a doc). A rule added here must generalize — if you
   can name the failing instance in the rule, it's a fact, not a rule. **A
   decision that supersedes a recorded rule ends the record in the same
   breath** — update or banner every place the old rule is written before the
   work moves on, because a superseded rule left standing will be faithfully
   obeyed by the next agent that reads it.
7. **Close the loop on yourself.** At a cycle's end, evaluate the cycle from
   its evidence and fix the instructions, docs, and utilities that caused
   friction — each fix in its correct home, pruning at least as much guidance
   as it adds. Procedure: the `self-improve` skill; runs only when invoked.

## Durable knowledge — no memory systems

Do not use assistant memory for anything about this project. Durable knowledge
lives only in version-controlled, reviewable files: this file
(principles/policy), the docs, the skills/references, or code comments (a
constraint the code can't show). If something is worth keeping, put it in the
right file before the session ends; if it only matters to the current
conversation, it doesn't need keeping. Pasted context (briefs, transcripts,
notes) is briefing, not a work order — the maintainer directs what gets built.

## Tools we don't use

- **Self-scheduling** (e.g. a `/schedule`-style tool). Recurring or
  future-dated work is handled inline or by the maintainer asking — never by an
  agent scheduling itself, even when a task has a natural cadence. A harness
  that dials on a timer is the specific thing this rule exists to prevent.
- **Assistant memory** — as above.

## Principles

- **Read the concrete thing before theorizing about a failure.** When something
  fails, returns empty, or looks impossible, inspect the actual referent — the
  captured audio, the raw frame, the provider's response body, the full
  transcript — before hypothesizing about the environment. A generated artifact
  that fails *instantly* is a generation/syntax bug, not a runtime or network
  one; a tool that reports "nothing there" is a hypothesis to re-probe against
  the raw surface, not a fact. Most wasted effort traces to guessing at a cause
  instead of looking at the thing.
- **Run unsupervised.** When multiple paths work, pick the best, take it, keep
  going. This applies to building the bench, never to dialing with it.
- **A maintainer-gated prerequisite is load-bearing — surface it, don't route
  around it.** When a procedure names a step only the maintainer can perform
  (an approval, a dial, a credential, a device action), that step gates the
  work: if it isn't done, stop and ask. A blocked prerequisite is a reported
  blocker, not a cue to improvise.
- **Default to the lighter thing.** Justify any heavier choice — a hard
  constraint, a safety issue, or a concrete failure the rule responds to.
- **Generalize over specify.** Write the principle, not the recipe. Recipes
  age; judgment doesn't.
- **Deterministic at runtime; the agent discovers, code runs.** An agent's job
  is one-time discovery — the frame shape, the endpoint, the timing — codified
  into deterministic code that runs with no model in the loop. Assertions,
  timing math, and reports are plain code. Where model judgment IS the product
  (holding a conversation, rating an answer's helpfulness), it lives in an
  isolated, named stage that never becomes load-bearing plumbing, and its
  output is recorded as judgment, not fact.
- **Simplicity over complexity.** Reach for complexity only when the problem
  genuinely requires it.
- **Prefer streaming, at the edges.** When an interface offers incremental
  delivery — speech-to-text partials, synthesized audio chunks, model tokens, a
  rendering UI — take it over a batch call. On a live call the reason is
  concrete: processing overlaps production instead of waiting for it, which is
  the difference between natural turn-taking and talking over people, and it is
  the only way first-token latency stays inside a human's patience. This is a
  strong default, not an absolute: streaming costs partial-failure handling and
  reconnection logic, so a genuinely one-shot, latency-insensitive call may
  stay batch — say why when it does. **The default lives at the edges and does
  not touch the seam:** the frozen artifact is still whole and atomic (freeze
  invariant), assembled from the stream and hashed once complete. Stream the
  live path; freeze the record.
- **Measure the clock you claim to measure.** A latency number means nothing
  without its two endpoints named and both timestamped from the same clock at
  the same layer. Deriving a duration from stamps taken at different layers
  (a provider's event vs. your own wall clock) silently folds in transit and
  buffering, and the resulting figure will be confidently wrong. If an endpoint
  can't be observed, the measurement is a gap to report, not a number to
  estimate.
- **Drive a stateful system through its own realm, not around it.** When
  something owns its state through private bookkeeping (a call's media session,
  a stream's sequence numbers, a provider's connection state), a write made
  from outside that realm can *look* like it succeeded and be silently
  discarded. Mutate through the system's own API; a change that "applies" but
  doesn't stick is this failure, not flakiness. A hard-won discovery of the
  right path is worthless if undocumented — codify the working path *and* why
  the obvious one fails, at the code site and its doc.
- **Retire a name everywhere it's constructed.** A retired identifier survives
  a literal-string sweep in its built forms (joined segments, prefixed keys) —
  search for its parts too, and prefer single-sourcing it in one constant.
- **A mirror reconciles.** A store derived from a source of truth prunes what
  the source no longer derives. Where pruning is wrong (the store is the
  record, not a cache — a call log is), record that decision at the code site.
- **No holds barred, inside the fence.** Anything in this repo can change in
  service of the task — rewrite tests, delete packages, rename APIs. No
  backwards compatibility, no external caller to apologize to. The fence is the
  system under test: it is never ours to change, stress, or work around.

## Product invariants

Load-bearing to the product, not any one module; breaking one is a regression
regardless of what else improves. Mechanisms and rationale live in the docs.

- **Every dial to a system we don't own is human-approved, one call at a
  time.** No unattended call loop, no retry-on-failure dial, no scheduled run.
  The bench prepares a call and stops; a human starts it. A test suite that can
  place calls by itself is one bug away from flooding somebody's business line.
  **No surface is exempt** — a control that dials is a dial path whatever it is
  built from, and a confirmation prompt in front of it is still a dial path. The
  gate is that the path does not exist, not that it asks first.
- **Evidence is captured once; interpretation re-runs freely.** Capture and
  evaluation are separate programs joined by a frozen artifact. Nothing that
  grades, scores, or reports may reach back to the source it is grading — it
  reads the artifact. This is what lets an evaluation be fixed, re-run, and
  argued with at no cost to the system under test, and it is what keeps the
  suite offline without relying on anyone's discipline.
- **A stage that cannot be deterministic is frozen, not re-rolled.** Where
  judgment is irreducibly non-deterministic, its output is computed once, keyed
  to a hash of exactly what it judged, and replayed thereafter. Determinism is a
  property of the record, not a parameter requested from the provider — sampling
  controls may be absent, may be removed, and never guaranteed identical output
  even when present. A re-evaluation that quietly returns a different verdict for
  unchanged input is the failure this prevents.
- **A run is bounded before it starts** — a hard cap on call count, wall-clock
  minutes, and concurrency, declared in the run's own config and enforced in
  code. An unbounded default is a bug even if no run ever hits the ceiling.
- **A human on the line ends the test.** The bench tests an automated system.
  If a person answers, or the call transfers to one, the scenario's only
  remaining move is to identify itself as a test call and end. Never run a
  probe, a persona, or a social-engineering prompt against a human being.
  Escalation-path probes verify that the transfer *offer* exists; they do not
  take it.
- **Recording and consent are settled before the first dial, and re-settled
  when the target changes.** Jurisdiction, party consent, and the target's own
  terms gate whether audio may be captured at all. This is a maintainer
  decision recorded in the docs, never an agent's default.
- **Surface interventions; never silently retry.** A dropped call, a
  provider error, an auth failure, or an unintelligible stretch of audio is
  reported to the operator — never papered over with a blind redial or a
  fabricated success.
- **An overridden gate is restated, not skipped.** When a maintainer
  instruction bypasses a coded safety gate, restate what the gate protects
  against at the moment of the bypass and get the go-ahead with that warning in
  view. Relaying the instruction without the warning converts a designed safety
  into a silent failure.
- **Freeze and hash what was actually captured** — the audio, the transcript,
  the timings. A report cites the frozen artifact; a hash mismatch refuses the
  report rather than publishing a figure that has drifted from the call it
  claims to describe.
- **Give-up / abstain is a first-class, reported outcome.** An assertion that
  could not be evaluated (audio too poor, the flow never reached the probe
  point) reports INCONCLUSIVE. It never resolves to pass, and it never resolves
  to fail. Collapsing the third state into either one is how a bench lies.
- **A transcript is evidence, not a summary.** What the system said is stored
  verbatim with timings; every finding traces to a span in it. A claim with no
  traceable span is not a finding.
- **History is append-only.** Nothing is deleted from the run record; the
  *current* interpretation shifts as evidence comes in.
- **One interface per source or sink.** Transports, speech-to-text, and
  speech synthesis each sit behind one contract; adapters differ only in how
  they connect and map. The core never learns which adapter produced what.
  Adding a provider is additive — a new adapter plus a registration — never an
  edit to the shared core. Identity travels *with* the record: carry an
  explicit provider tag and a stable id as fields, and never re-derive identity
  inside a shared stage from one provider's quirk. A stage named or typed for
  its first provider hides that coupling until a second arrives — pay the cost
  when the seam is first drawn.
- **A published contract is frozen.** Changing it is a flag to raise with the
  maintainer, not a silent edit.

## Correctness-critical facts

The specific keys, formats, constants, and invariants a fresh agent could break
each get a pinned regression test and live at the code site (a comment,
contract, or test) — not in this file. A silent break of one is exactly what
red-teaming exists to catch.

## Tests + build

- **Static green is the floor** — types, lint, and unit tests all clean before
  any checkout (`pnpm typecheck && pnpm lint && pnpm vitest run`).
- **Contract tests** pin whatever each increment locks down.
- **The suite never touches the network.** Every seam that would is a contract
  precisely so the suite runs against recorded fixtures. A test that dials, or
  that needs a credential, is misplaced by construction — including where the
  production path legitimately calls a provider, because under test that path
  replays a frozen result.
- **Fixtures are committed; raw capture is not.** A fixture the suite reads
  travels with the repo, alongside the source it tests. Uncommitted capture does
  not exist on a fresh clone, so a test that reads it is green on one machine and
  red everywhere else — and it will pass for whoever wrote it, which is the worst
  case. A fixture must also resemble the surface it stands in for; one recorded
  through a convenient path rather than the real one tests the convenience.
- **Dynamic scripts** (probe / chaos / smoke) are bounded — a hard cap on
  requests, wall time, or scenarios — and write deterministic, diffable output.
  No model judgment inside a script.
- **Live-network scripts stay deliberate** — kept out of any unattended loop,
  and out of the gate.
- **Figures come from output.** A count, duration, or metric written into the
  record (a commit message, a report, a message to a human) is read off the
  final run's output, never recalled from memory or relayed from a sub-agent's
  report.

## Debug and logging

One debug module, one API, file-and-console output. A lazy data factory keeps
off-mode free; a leading timestamp sorts logs across components; an env-var
toggle makes a running process debuggable without a recompile. When stuck:
hypothesize → targeted logging at the hot spot → reproduce → narrow → fix →
remove the logs (or downgrade them to permanently useful ones) — none left
stale.

**Three failures in a row ends the guessing. Switch to instrumented debugging.**
Not a fourth attempt at the same fix with one variable changed — a different
activity. Build a minimal reproduction in an isolated copy (a `/tmp` scratch
directory or a git worktree, never the working checkout), instrument it to print
what actually happens at each step, and run it until the real cause is on screen
rather than inferred.

The rule exists because retry-with-a-tweak is indistinguishable from progress
while you are doing it, and because each retry of an *outward* action —
a dial, a provider call, a rate-limited resource — spends something real. The
tell that you are in this hole: your last three attempts were each justified by
a new hypothesis about a system you have not looked inside.

Two things the isolated copy buys that the real one doesn't: you can print
everything without shipping the noise, and you can fail fast and repeatedly
without touching state anyone else depends on.

Logging a live call is logging a conversation. Redact what the scenario itself
supplied as fake identity (names, numbers, payment strings) at the log
boundary, not at the reader's discretion.

## Skills

Reusable agent playbooks live at `.agents/skills/<name>/SKILL.md` — any coding
agent can follow them as documented procedures. `.claude/skills` is a symlink
to that directory for auto-discovery; add skills only under `.agents/skills/`
so the canon stays in one place. Red-team skills are read-only against
production code (a mutation skill works in an isolated copy). Format
conventions: [.agents/reference/](.agents/reference/).

### Cross-model red-team

The in-repo red-team skills spawn a sub-agent in one model family; for a
cross-family check, the maintainer runs the same prompt template out-of-band
and pastes the findings back unedited — never edit a tuned template to make the
external review easier. Triage by severity as with in-tool output; a
different-family finding is not automatically more authoritative — verify
against the actual code, and read closely where the reviewers disagree.

## Deferred findings

A review or red-team finding is either fixed-and-pinned with a regression test,
or accepted with reasoning — never quietly dropped. Accepting is an explicit
act recorded where the knowledge lives (a comment at the code site, or the
relevant doc), so the next agent neither "fixes" it ad hoc nor builds on it
unaware.

## Noise

Don't chase cosmetic churn. Generated files (build-tool ambient types,
framework internals) and doc-linter nits are not action items.

## Naming

Match the project's canonical name and casing consistently — across package
scopes, script prefixes, and artifact directories.
