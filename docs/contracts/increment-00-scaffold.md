# Increment 0 — Scaffold contract

What this increment locked in. Later increments may rely on these without
re-checking; if one needs to *change* an entry, raise it with the maintainer
first.

Frozen 2026-07-15.

## Name

**callbench**. Package scope `@callbench/*`, debug dir `/tmp/callbench-debug`,
env prefix `CALLBENCH_`. One name, used consistently — retiring it later means
finding it in its constructed forms too, not just its literal ones.

## Stack

- pnpm monorepo, workspaces `packages/*` and `apps/*`. (`apps/*` was **added at
  Increment 5** for the web app — see the amendment note under the checkout
  gate.)
- TypeScript 5.9.3, `module: ESNext`, `moduleResolution: bundler`, strict,
  `erasableSyntaxOnly`. `@types/node` 24.x.
- Biome 2.x (lint + format): tabs, single quotes, semicolons, width 100.
  `.svelte` files are **not** linted by Biome (its Svelte support does not parse
  template markup, so it false-flags script bindings used only in markup as
  unused); svelte-check validates them instead.
- Vitest 4.x, node environment. Test glob: `packages/**/*.test.ts`,
  `scripts/**/*.test.mjs`, and (added at Increment 5) `apps/web/src/**/*.test.ts`
  — the web app's server-side logic is plain Node and runs under the same node
  environment; its tested modules import shared types by relative path, never
  `$lib/*`, so no SvelteKit alias is needed here.
- Runtime dependencies arrive with their increments; the web app (Increment 5)
  adds SvelteKit + Svelte 5 under `apps/web` only.

### Two version pins that look stale and are not

Both are the kind of thing a "use the latest packages" pass silently breaks, so
the reasons live here rather than in anyone's memory. Re-verify before changing
either — these were measured on 2026-07-15, not recalled.

- **TypeScript stays on 5.x even though 7.x is `latest`.** SvelteKit's peer range
  is `^5.3.3 || ^6.0.0` — TypeScript 7 is not in it, and the web app is a planned
  increment. Measured separately: 7.0.2 also fails this repo's typecheck outright
  (it no longer auto-includes `@types/*`; it needs an explicit `types` field),
  so the upgrade is two changes, not one. The move to make when it comes is
  5.x → 6.x, and only once the toolchain's peer range says so.
- **`@types/node` tracks the *runtime*, not `latest`.** We run Node 24 (an LTS
  line); the types are 24.x deliberately, and this was a downgrade from 25.x.
  Types ahead of the runtime let you call an API that typechecks and then throws
  at runtime — the failure lands on whoever runs the code, not whoever compiled
  it. When the runtime moves, the types move with it, in that order.

## Workspace layout

```text
packages/shared/       DEBUG module; core types arrive with their increments
scripts/               bounded operator entry points (empty at Increment 0)
docs/                  brief, architecture, plan, probes, drivers
docs/contracts/        this directory
data/                  gitignored — recordings, transcripts, reports, retros
.agents/               skills, references, chimes (canonical)
.claude/               symlinks into .agents + AGENTS.md
```

**Packages arrive when an increment needs them.** No empty package directories;
inventory is not scaffolding. `packages/shared` exists at Increment 0 only
because the one-debug-module policy requires it.

## The checkout gate

`pnpm typecheck && pnpm lint && pnpm vitest run` — green as of this contract.
Every increment ends here, plus a red-team pass.

`typecheck` names each package's `tsconfig.json` explicitly. **Each new package
must add its own `tsc -p` to the root `typecheck` script.** A package that isn't
in that list is not typechecked, and nothing will tell you.

### Amendment (Increment 5) — the gate widened for the web app

This frozen contract was amended, deliberately and with the maintainer's
request to build the UI in view, not silently:

- The workspace gained `apps/*`; the web app lives at `apps/web`.
- `typecheck` now ends with `pnpm --filter @callbench/web check`, which runs
  `svelte-kit sync && svelte-check` — the UI's typecheck equivalent (plain `tsc`
  cannot see `.svelte` files or the generated route types).
- The Vitest glob gained `apps/web/src/**/*.test.ts`. Vitest also gained a second
  project (Increment 6): a `dom` project (environment `jsdom`, the Svelte plugin)
  running `apps/web/src/**/*.dom.test.ts` for the runes-based audio engine; the
  `node` project excludes `*.dom.test.ts` so it never runs them without the
  compiler.
- Biome ignores `**/.svelte-kit` (generated) and `**/*.svelte` (see Stack).

What the widening protects, restated so it is not lost: a package or app outside
the typecheck list and the Vitest glob is green by omission — nothing checks it,
and its absence looks identical to passing. The web app is now inside both.

## The DEBUG contract (`@callbench/shared`)

- `DEBUG(...)` and `DEBUG_DIR` are the public surface.
- All output converges on `/tmp/callbench-debug/debug-YYYY-MM-DD.log`, ISO
  timestamp as the first token of every line, so concurrent components can be
  cat'd together and sorted. The interleaving is the diagnostic.
- Enabled outside `NODE_ENV` production/test. `DEBUG_LOGGING=true|false`
  overrides. **The flag is re-read on every call** — a running process is
  toggleable without restart, which matters because a call lasts minutes.
- Data factories are lazy and are not invoked when disabled.
- A throwing factory is recorded, not propagated. A logging failure must never
  end a live call.
- Line stamp and filename derive from **one** `Date` instance (midnight-rollover
  regression, inherited with its test).
- `ensureDir` rechecks every call — no cache (tmp-reaper regression, inherited
  with its test).

Five behaviors, five tests, five seeded mutations in the trickster catalog.

## What is deliberately NOT frozen here

The seams — transport, stt, tts, scenario, assertions, transcript — are named in
[../architecture.md](../architecture.md) and designed by their own increments.
Increment 0 does not pre-empt them with speculative types. `.env.example` shows
a placeholder shape, not a contract; Increment 1 settles what the transport
actually needs.

## Inherited scaffolding, and what was left behind

From `~/Projects/job-hunter` and `~/Projects/job-hunter-video`:

- **Taken:** the `AGENTS.md` spine (principles-only, with a placement rule), the
  `.agents/` + `.claude`-symlink layout, `anti-slop.md`, the conventions
  reference, both chimes, the three red-team skills, `self-improve`, and the
  Biome/Vitest/TypeScript/pnpm configuration. The DEBUG module came across with
  its regression tests intact — the bugs those tests pin are real and were paid
  for once already.
- **Left:** every domain skill (cover-letter, keyword-review, scrape-jobs,
  screener-answer, form-fill, video, edl-drafting, qa-demo-video), the LaTeX and
  profile assets, `adam-voice.md`, SQLite/Drizzle, Turbo, Patchright.
- **Added:** the `live-call` skill, which has no sibling equivalent. It exists
  because this is the first of the three repos whose actions reach a stranger's
  business.

No code, data, or state is shared with either repo. callbench must not import
from them.

## Standing constraints this increment establishes

These are in [../../AGENTS.md](../../AGENTS.md) as invariants; recorded here as
the things the scaffold was shaped around, so a later increment doesn't
rediscover them as obstacles:

- **The suite never dials and never needs a credential.** Every network-touching
  seam is a contract precisely so this holds. A test that wants a token is
  misplaced by construction.
- **There is no code path from a failed call to a new call.** Retry, redial, and
  scheduled runs are not features. This is why the repo has no scheduler and
  why `.claude/settings.json` is a candidate for denying the dial script
  outright.
- **Three-state outcomes.** PASS / FAIL / INCONCLUSIVE, everywhere a result is
  produced. The third state is not an error case.
