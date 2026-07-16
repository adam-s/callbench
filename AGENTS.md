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

## Language & voice

- Do not use "kill" except for the Unix `kill` command. Use stop / end / halt /
  exit / close / cancel / interrupt / terminate / abort.
- **Frame with positive language over negative.** Make the subject of a sentence
  the capability and the good it produces, not the harm it prevents. Negative or
  violent imagery reads as motiveless menace to a reader who arrives cold, and
  it casts the writer's own work as the villain. Swap the charged word, keep the
  candor — reframing is not sanitizing.
- **Every phrase an outside reader will see gets a connotation pass before it
  ships.** Read each phrase three ways: what it literally claims (true, precise,
  verifiable?), what it implies about the writer, and every second parse a fast,
  uncharitable skimmer could take. The worst reasonable reading is the reading.
  The pass is context-dependent — an approved phrase is never safe by default in
  a new situation. **It is a gate with a visible artifact**: before outward text
  ships, produce and SHOW the phrase→readings and run the AI-register checklist
  (no "not-X-but-Y", no rule-of-three padding, no throat-clearing, plain words).
  A draft not shown with its readings is not finished — this pass gets silently
  skipped under task pressure, so the readings must exist as output where their
  absence is visible.
- **Write for a skimmer who rejects on sight.** Plain words, short sentences,
  lead with the point, cut every sentence that isn't a concrete fact, and never
  write a phrase that sounds good but says nothing. Shorter and plainer wins.
- Explanatory prose: constraint first, then why the naive approach fails, then
  the actual mechanism — plain declarative sentences. Reference-shaped content
  (contracts, schemas) is rigid, predictable, and enthusiasm-free. See
  [.agents/reference/](.agents/reference/).

## Orientation

What this project is, how it's structured, and its plan of work live in
[docs/](docs/) — read them before building. Work ships in numbered increments;
each takes the previous one's frozen output as its only input and ends by
passing the project's checkout gate.

## Iteration

1. **Plan first.** Scope the work and its "done when" gate before starting.
   Don't build what the maintainer hasn't asked for.
2. **Probe before building.** When behavior is uncertain, write an empirical
   probe and observe — facts, then code. Unverified assumptions stay labelled
   until a probe confirms them; a claimed *limit* or *blocker* is an assumption
   too (measure before asserting the ceiling — received wisdom is usually
   looser than claimed). When extracting from an external surface, capture its
   real shape before writing the parser, and treat a silent empty result as a
   re-probe signal, not "nothing there". When a pipeline contains an expensive,
   hard-to-repeat step, everything cheaply verifiable beforehand is verified
   automatically, every run — a failed precondition must never be discovered by
   the expensive step failing.
3. **Pin what you fix.** Every fixed behavior gets a regression test; every
   locked-down interface gets a contract test.
4. **Red-team at checkpoints.** Review the production code, then the tests, then
   mutate to confirm the suite actually bites.
5. **Record, generalized.** Accepted tradeoffs are recorded where the knowledge
   lives (a code comment, a doc). A rule added here must generalize — if you can
   name the failing instance in the rule, it's a fact, not a rule.
6. **Pinned lessons are re-probeable.** A pin records what a probe showed then,
   not eternal truth. When new evidence contradicts one, re-probe and UPDATE the
   pin; the corrected pin says what changed and when.
7. **A decision that supersedes a recorded rule retires the record in the same
   breath.** Update or banner every place the old rule is written before the work
   moves on — a superseded rule left standing will be faithfully obeyed by the
   next agent that reads it.
8. **Close the loop on yourself.** At a cycle's end, evaluate the cycle from its
   evidence and fix the instructions, docs, and utilities that caused friction —
   each fix in its correct home, pruning at least as much guidance as it adds.

## Durable knowledge — no memory systems

Do not use assistant memory for anything about this project. Durable knowledge
lives only in version-controlled, reviewable files: this file
(principles/policy), the docs, the skills/references, or code comments (a
constraint the code can't show). If something is worth keeping, put it in the
right file before the session ends; if it only matters to the current
conversation, it doesn't need keeping. Pasted context (handoffs, roadmaps,
briefs) is briefing, not a work order — the maintainer directs what gets built,
and briefs age: verify the target's current state against its own record before
building from one.

## Tools we don't use

- **Self-scheduling.** Recurring or future-dated work is handled inline or by
  the maintainer asking — never by an agent scheduling itself, even when a task
  has a natural cadence.
- **Assistant memory** — as above.

## Principles

- **Read the concrete thing before theorizing about a failure.** When something
  fails, returns empty, or looks impossible, inspect the actual referent — the
  generated file, the live DOM, the read-back value, the full option list —
  before hypothesizing about the environment. A generated artifact that fails
  *instantly* is a generation bug, not a runtime one. Most wasted effort traces
  to guessing at a cause instead of looking at the thing.
- **Run unsupervised.** When multiple paths work, pick the best, take it, keep
  going.
- **A maintainer-gated prerequisite is load-bearing — surface it, don't route
  around it.** When a procedure names a step only the maintainer can perform, that
  step gates the work: if it isn't done, stop and ask. A blocked prerequisite is
  a reported blocker, not a cue to improvise; "run unsupervised" applies to paths
  that all work, not to skipping the one gate the maintainer holds.
- **Default to the lighter thing.** Justify any heavier choice — a hard
  constraint, a safety issue, or a concrete failure the rule responds to.
- **Generalize over specify.** Write the principle, not the recipe. Recipes age;
  judgment doesn't.
- **Simplicity over complexity.** Reach for complexity only when the problem
  genuinely requires it.
- **Deterministic at runtime; the agent discovers, code runs.** An agent's job is
  one-time discovery — the selector, the endpoint, the shape — codified into
  deterministic code that runs with no model in the loop. A recurring runtime task
  is a plain script, never a step that re-invokes an LLM, except where model
  judgment is the explicit product (then an isolated, named stage, never
  load-bearing plumbing). Hand-doing at runtime what a probe already taught you is
  the signal to move that knowledge into code.
- **Separate reusable from specific.** Code any use of the tool would want lives
  as a reusable library; content specific to one target lives in its own place and
  is treated as a template that scales to many instances. Entry points stay thin —
  they wire libraries together, they don't hold logic. A cross-cutting concern
  belongs in one place with one API, never re-implemented per caller.
- **Capture ground truth; don't reconstruct it.** When a later step needs a fact —
  a timestamp, a rate, a schedule — record it at the source, in-band, so it is a
  property of the data rather than something inferred afterward. A derived
  artifact cannot yield up a timing the capture never wrote down, and a guessed
  correction only approximates it. Prefer the architecture where the fact holds by
  construction.
- **Meet the house standard at the source, not the seam.** When independently
  produced artifacts join, each one arrives already conforming to the shared
  standard. A downstream stage that quietly corrects an upstream shortfall is
  working blind on material whose provenance it cannot see, and the correction
  itself becomes the defect. At the seam, verify and refuse — never compensate.
- **A remedy reaches past its target; measure the cost against ground truth.** A
  step added to correct one flaw can carry off good signal with it, and a fix that
  masks a symptom leaves the cause to resurface. Before adopting a corrective
  step, A/B its output against a known-good reference to see what it costs, not
  only what it cures; keep the reference so the comparison is repeatable.
- **Keep the answer out of the exam paper.** When an artifact will be read by a
  model or person whose independent judgment is the thing being demonstrated, the
  artifact must not contain the expected outcome. The demonstration's value is
  exactly the independence it forfeits.
- **Bind to identity, not ordinal.** A positional index into an external, mutable
  collection is not a stable handle. Resolve by intrinsic identity and fail loudly
  when it is absent, rather than trusting a slot that held last time.
- **A constrained target takes only its own current values — resolve, never assume
  the spelling.** When you write into something that defines its own valid set, a
  value is correct only relative to that target's live set; a value outside it is
  silently dropped or stored as garbage. Discover the actual set, resolve the
  intent to a real member, then confirm by reading the value back. An intent that
  resolves to no member is a reported gap, never free text forced in.
- **Drive a stateful system through its own realm, not around it.** When something
  owns its state through private bookkeeping, a write made from outside that realm
  can look like it succeeded and be silently reverted on the system's next pass. A
  change that "applies" but doesn't stick is this failure, not flakiness. Codify
  the working path *and* write down why the obvious one fails.
- **Act on the thing where it lives, not by its container's address.** What you
  need may arrive embedded, wrapped, or proxied, so its outer address can mislead.
  Before building machinery to resolve an identifier, check whether you can
  operate on the referent directly.
- **Retire a name everywhere it's constructed.** A retired path or identifier
  survives a literal-string sweep in its built forms — search for its parts too,
  and prefer single-sourcing it in one constant so retiring it is one edit.
- **A mirror reconciles.** A store derived from a source of truth prunes what the
  source no longer derives — an upsert-only mirror serves deleted entries forever.
  Where pruning is wrong, record that decision at the code site.
- **A capture from a live, uncontrolled surface is a take, not a render.**
  Nondeterminism there is inherent: rerun until a take is clean, keep the keeper
  with its provenance, and never let take-thinking leak into deterministic render
  paths — a render that differs run-to-run is a bug; a take that differs is
  expected.
- **No holds barred.** Anything in the repo can change in service of the task —
  rewrite tests, delete components, rename APIs, restructure. No backwards
  compatibility, no external caller to apologize to; a teardown is fair game.
- **Leave no mess.** Every artifact has one deliberate home and a lifecycle: it
  follows the naming convention of the folder it lives in, and it is deleted the
  moment its purpose ends. Probe output and scratch work never linger next to real
  material — clean up before checkout.

## Product invariants

Load-bearing to the product, not any one module; breaking one is a regression
regardless of what else improves. The specific mechanisms and rationale live in
the docs.

- **Gate irreversible or outward-facing actions behind a human checkpoint.** No
  unattended send.
- **An overridden gate is restated, not skipped.** When a maintainer instruction
  bypasses a coded safety gate, restate what the gate protects against at the
  moment of the bypass and get the go-ahead with that warning in view. Relaying
  the instruction without the warning converts a designed safety into a silent
  failure.
- **Surface interventions; never silently retry.** An auth prompt, challenge,
  failed encode, or expiry is reported to the operator, not papered over with a
  blind retry or a false success.
- **Give-up / abstain is a first-class, reported outcome** — never hidden behind a
  fabricated success.
- **Freeze and hash what was actually delivered** so a historical record never
  drifts; refuse the action on a hash mismatch.
- **Multi-part writes are atomic** — all parts or none. A half-write is
  corruption.
- **Source material is never mutated.** Raw input is read-only; every
  transformation writes a new derived artifact, reproducible from source plus
  committed decisions.
- **Model judgment lives in committed, reviewable artifacts; the steps that
  consume them are deterministic.** An agent may decide, but the decision is
  written to a diffable file the maintainer can inspect, and a script with no
  model in the loop turns that file into the output.
- **History is append-only.** Nothing is deleted from the record; the *current*
  selection shifts as evidence comes in.
- **One interface per source or sink.** Adapters differ only in how they fetch and
  map; the core never learns which adapter produced what. Adding a source is
  additive — a new adapter plus a registration — never an edit to the shared core.
  Identity travels *with* the record: carry an explicit source tag and a stable id
  as fields, and never re-derive identity inside a shared stage from one source's
  quirk. A stage named for its first source hides that coupling until a second
  arrives, so pay the cost when the seam is first drawn.
- **Widening reach re-opens trust boundaries.** When code starts running in more
  places, its safety assumptions do not follow for free. On any change that
  broadens where code runs or what can talk to it, re-audit every
  who-can-reach-this boundary.
- **A published contract is frozen.** Changing it is a flag to raise with the
  maintainer, not a silent edit.

## Correctness-critical facts

The specific keys, formats, constants, and invariants a fresh agent could break
each get a pinned regression test and live at the code site (a comment,
contract, or test) — not in this file. A silent break of one is exactly what
red-teaming exists to catch.

## Tests + build

- **Static green is the floor** — types, lint, and unit tests all clean before
  any checkout. The exact gate command lives with the code.
- **Contract tests** pin whatever each increment locks down.
- **Dynamic scripts** (probe / chaos / smoke / render) are bounded — a hard cap on
  requests, wall time, output size, or scenarios — and write deterministic,
  diffable output. No model judgment inside a script.
- **Live-network and outward-facing scripts stay deliberate** — kept out of any
  unattended loop, and behind the human checkpoint.
- **Figures come from output.** A count or metric written into the record (a
  commit message, a report) is read off the final run's output, never recalled
  from memory or relayed from a sub-agent's report.
- **Large binaries stay out of git history** unless they are the deliberately
  committed deliverable. Working media is gitignored and reproducible.
- **A build step that downstream consumers read is not optional.** Passing
  type-check is not the same as the built output reflecting the edit.

## Debug and logging

One debug module, one API, file-and-console output. A lazy data factory keeps
off-mode free; a leading timestamp sorts logs across components; an env-var
toggle makes a running process debuggable without a recompile. When stuck:
hypothesize → targeted logging at the hot spot → reproduce → narrow → fix →
remove the logs (or downgrade them to permanently useful ones) — none left stale.

## Skills

Reusable agent playbooks live at `.agents/skills/<name>/SKILL.md` — any coding
agent can follow them as documented procedures. `.claude/skills` is a symlink to
that directory for auto-discovery; add skills only under `.agents/skills/` so the
canon stays in one place. Never replace the symlink with a real directory.
Red-team skills are read-only against production code (a mutation skill works in
an isolated copy).

### Cross-model red-team

The in-repo red-team skills spawn a sub-agent in one model family; for a
cross-family check, the maintainer runs the same prompt template out-of-band and
pastes the findings back unedited — never edit a tuned template to make the
external review easier. A different-family finding is not automatically more
authoritative — verify against the actual code, and read closely where the
reviewers disagree.

## Deferred findings

A review or red-team finding is either fixed-and-pinned with a regression test,
or accepted with reasoning — never quietly dropped. Accepting is an explicit act
recorded where the knowledge lives (a comment at the code site, or the relevant
doc), so the next agent neither "fixes" it ad hoc nor builds on it unaware.

## Noise

Don't chase cosmetic churn. Generated files (build-tool ambient types, framework
internals) and doc-linter nits are not action items.

## Naming

Match the project's canonical name and casing consistently — across package
scopes, script prefixes, and artifact directories.
