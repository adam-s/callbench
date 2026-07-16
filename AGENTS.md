# AGENTS.md

Canonical instructions for coding agents in this repo. Agent-specific entry
points (e.g. [CLAUDE.md](CLAUDE.md)) reference this file; shared resources
(skills, references) live under [.agents/](.agents/).

**This file holds generalized principles and policy only — never a specific fact,
path, constant, name, or recipe.** Project specifics live where they can be
verified: [docs/](docs/), per-increment contracts, tests, and code comments. A
rule here that names a particular instance is in the wrong place — rewrite it as a
principle, or move the fact to the code. Any example is one illustration, not a spec.

## Language & voice

- Do not use "kill" except for the Unix `kill` command. Use stop / end / halt /
  exit / close / cancel / interrupt / terminate / abort.
- **Frame positive over negative.** Make the sentence's subject the capability and
  the good it produces, not the harm it prevents — charged imagery reads as
  motiveless menace to a cold reader and casts your own work as the villain. Swap
  the word, keep the candor; reframing is not sanitizing.
- **Two kinds of text are outward-facing and both get a connotation pass before
  they ship**: what a scenario SAYS on a live call, and the findings a human reads.
  Read each phrase three ways — its literal claim (true? verifiable?), what it
  implies about the writer, and the worst parse a fast, uncharitable reader could
  take; the worst reasonable reading is the reading, and an approved phrase is
  never safe by default elsewhere. **The pass is a gate with a visible artifact** —
  SHOW the phrase→readings and the AI-register checklist (no "not-X-but-Y", no
  rule-of-three padding, no throat-clearing, plain words), or it gets silently
  skipped under pressure.
- **A finding is a claim about someone else's system, read by the person who built
  it.** Give the observed behavior and the input that produced it; let the reader
  conclude — never characterize the system's quality or the builder's competence. A
  finding that can't survive being read aloud to its author is written wrong.
- Explanatory prose: constraint first, then why the naive approach fails, then the
  mechanism — plain declarative sentences. Reference-shaped content (contracts,
  schemas) is rigid, predictable, enthusiasm-free. See [.agents/reference/](.agents/reference/).

## Orientation

What this project is, how it's structured, and its plan of work live in
[docs/](docs/) — read them before building. Work ships in numbered increments; each
takes the previous one's frozen output as its only input and ends by passing the
project's checkout gate.

## Iteration

1. **Plan first.** Scope the work and its "done when" gate before starting. Don't
   build what the maintainer hasn't asked for.
2. **Probe before building.** When behavior is uncertain, probe empirically —
   facts, then code. Unverified assumptions stay labelled until a probe confirms
   them, and a claimed limit or blocker is an assumption too. Capture an external
   surface's real shape before writing the parser; a silent empty result is a
   re-probe signal, not "nothing there". Ahead of an expensive, hard-to-repeat step,
   everything cheaply checkable is checked automatically, every run — a failed
   precondition must never be discovered by the expensive step failing.
3. **Pin what you fix.** Every fixed behavior gets a regression test; every
   locked-down interface gets a contract test.
4. **Red-team at checkpoints.** Review the production code, then the tests, then
   mutate to confirm the suite actually bites.
5. **Record, generalized.** Accepted tradeoffs go where the knowledge lives (a code
   comment, a doc). A rule added here must generalize — if you can name the failing
   instance in it, it's a fact, not a rule.
6. **Pinned lessons are re-probeable.** A pin records what a probe showed then, not
   eternal truth. When new evidence contradicts one, re-probe and UPDATE it, saying
   what changed and when.
7. **A decision that supersedes a recorded rule retires the record in the same
   breath** — update or banner every place the old rule is written before the work
   moves on, or the next agent will faithfully obey it.
8. **Close the loop on yourself.** At a cycle's end, evaluate the cycle from its
   evidence and fix the instructions, docs, and utilities that caused friction —
   each in its correct home, pruning at least as much guidance as it adds.

## Durable knowledge — no memory systems

Do not use assistant memory for anything about this project. Durable knowledge
lives only in version-controlled, reviewable files: this file (principles/policy),
the docs, the skills/references, or code comments (a constraint the code can't
show). Worth keeping goes in the right file before the session ends; what only
matters to the current conversation doesn't need keeping. Pasted context
(handoffs, roadmaps, briefs) is briefing, not a work order — the maintainer directs
what gets built, and briefs age: verify the target's state against its record first.

## Tools we don't use

**Self-scheduling** (recurring or future-dated work is handled inline or by the
maintainer asking, never by an agent scheduling itself) and **assistant memory**
(as above).

## Principles

- **Read the concrete thing before theorizing about a failure.** Inspect the actual
  referent — the generated file, the recorded audio, the read-back value — before
  hypothesizing about the environment. Most wasted effort is guessing at a cause
  instead of looking at the thing.
- **Run unsupervised, and default to the lighter, simpler thing.** When multiple
  paths work, pick the best and keep going. Justify any heavier choice — a hard
  constraint, a safety issue, or a concrete failure the rule responds to — and
  write the principle, not the recipe: recipes age, judgment doesn't.
- **A maintainer-gated prerequisite is load-bearing — surface it, don't route
  around it.** A step only the maintainer can perform gates the work: if it isn't
  done, stop and ask. A blocked prerequisite is a reported blocker, not a cue to
  improvise; "run unsupervised" covers paths that all work, not skipping the one
  gate the maintainer holds.
- **Deterministic at runtime; the agent discovers, code runs.** An agent's job is
  one-time discovery — the endpoint, the shape, the timing — codified into code that
  runs with no model in the loop. A recurring runtime task is a plain script, never
  a step that re-invokes an LLM, except where model judgment is the explicit product
  (then an isolated, named stage, never load-bearing plumbing).
- **A capture from a live, uncontrolled surface is a take, not a render.** A real
  call is nondeterministic by nature: rerun until a take is clean and keep the
  keeper as evidence with its provenance. Never let take-thinking leak into
  deterministic paths — a render that differs run-to-run is a bug.
- **Capture ground truth; don't reconstruct it.** A fact a later step needs — a
  timestamp, a rate, a schedule — is recorded at the source, in-band, as a property
  of the data. A derived artifact cannot yield up a timing the capture never wrote
  down; prefer the architecture where the fact holds by construction.
- **Meet the house standard at the source, not the seam.** When independently
  produced artifacts join, each arrives already conforming to the shared standard —
  level, format, rate, whatever the contract names. A stage that quietly corrects an
  upstream shortfall works blind on provenance it can't see, and the correction
  becomes the defect. At the seam, verify and refuse.
- **A remedy reaches past its target; measure its cost against ground truth.** A
  corrective step can carry off good signal with the flaw, and one that masks a
  symptom leaves the cause to resurface. A/B it against a kept known-good reference
  for what it costs, not only what it cures.
- **Keep the answer out of the exam paper.** An artifact read by a model whose
  independent judgment is the thing being measured must not contain the expected
  outcome — its value is exactly the independence it forfeits.
- **Separate reusable from specific.** Code any use of the bench would want is a
  reusable library; content specific to one target lives in its own place, as a
  template that scales. Entry points stay thin — they wire libraries together.
- **No holds barred.** Anything in the repo can change in service of the task —
  rewrite tests, delete components, rename APIs, restructure. No backwards
  compatibility, no external caller to apologize to; a teardown is fair game.
- **Leave no mess.** Every artifact has one deliberate home and a lifecycle: it
  follows its folder's naming convention and is deleted the moment its purpose ends.
  Probe output and scratch work never linger next to real material.

## Product invariants

Load-bearing to the product, not any one module; breaking one is a regression
regardless of what else improves. Mechanisms and rationale live in the docs.

- **Gate irreversible or outward-facing actions behind a human checkpoint.** The
  system under test is somebody's live business line. No unattended dial.
- **An overridden gate is restated, not skipped.** When a maintainer instruction
  bypasses a coded safety gate, restate what the gate protects against at the moment
  of the bypass and get the go-ahead with that warning in view. Relaying the
  instruction without the warning turns a designed safety into a silent failure.
- **Surface interventions; never silently retry.** A failed connection, an auth
  challenge, or an expiry is reported to the operator, not papered over with a blind
  retry or a false success. Give-up / abstain is likewise a first-class, reported
  outcome — never hidden behind a fabricated success.
- **Freeze and hash what was actually delivered** so a historical record never
  drifts; refuse the action on a hash mismatch. Multi-part writes are atomic — all
  parts or none, since a half-write is corruption.
- **Source material is never mutated.** A recording is read-only input; every
  transformation writes a new derived artifact, reproducible from source plus
  committed decisions.
- **Model judgment lives in committed, reviewable artifacts; the steps that consume
  them are deterministic.** An agent may decide, but the decision is written to a
  diffable file the maintainer can inspect, and a script with no model in the loop
  turns it into the output.
- **One interface per source or sink.** Adapters differ only in how they fetch and
  map; the core never learns which produced what, so adding one is additive — a new
  adapter plus a registration. Identity travels *with* the record (an explicit source
  tag, a stable id), never re-derived from one source's quirk.
- **A published contract is frozen.** Changing it is a flag to raise with the
  maintainer, not a silent edit.

## Correctness-critical facts

The keys, formats, constants, and invariants a fresh agent could break each get a
pinned regression test and live at the code site (a comment, contract, or test) —
not in this file. A silent break of one is what red-teaming exists to catch.

## Tests + build

- **Static green is the floor** — types, lint, and unit tests all clean before any
  checkout. The exact gate command lives with the code.
- **Contract tests** pin whatever each increment locks down.
- **Dynamic scripts** (probe / chaos / smoke) are bounded — a hard cap on requests,
  wall time, output size, or scenarios — write deterministic, diffable output with
  no model judgment inside, and live-call scripts stay deliberate: out of any
  unattended loop, behind the human checkpoint above.
- **Figures come from output.** A count or metric written into the record (a commit
  message, a report) is read off the final run's output, never recalled from memory
  or relayed from a sub-agent's report.
- **Large binaries stay out of git history** unless they are the deliberately
  committed deliverable. Working audio is gitignored and reproducible.

## Debug and logging

One debug module, one API, file-and-console output. A lazy data factory keeps
off-mode free; a leading timestamp sorts logs across components; an env-var toggle
makes a running process debuggable without a recompile. When stuck: hypothesize →
targeted logging at the hot spot → reproduce → narrow → fix → remove the logs (or
downgrade them to permanently useful ones), none left stale.

## Skills

Reusable agent playbooks live at `.agents/skills/<name>/SKILL.md`, followed as
documented procedures. `.claude/skills` is a symlink to that directory for
auto-discovery; add skills only under `.agents/skills/` so the canon stays in one
place. Red-team skills are read-only against production code (a mutation skill works
in an isolated copy). Format conventions: [.agents/reference/](.agents/reference/).

**Review and red-team skills run in a fresh subagent (Opus), never inline.** The
orchestrating agent invokes the skill and receives findings; it does not open the
skill file or perform the procedure itself. A reviewer that shares the author's
context inherits the author's blind spots — the independence is the value, and
reading the playbook contaminates it.

## Deferred findings

A review or red-team finding is either fixed-and-pinned with a regression test, or
accepted with reasoning — never quietly dropped. Accepting is an explicit act
recorded where the knowledge lives (a comment at the code site, or the relevant
doc), so the next agent neither "fixes" it ad hoc nor builds on it unaware.

## Noise & naming

Don't chase cosmetic churn — generated files (build-tool ambient types, framework
internals) and doc-linter nits are not action items. Match the project's canonical
name and casing consistently across package scopes, script prefixes, and artifact
directories.
