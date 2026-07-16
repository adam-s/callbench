# `.claude/` Anthropic conventions — quick reference

Distilled from Anthropic's official Claude Code docs and
`github.com/anthropics/skills`. **Authoritative source** is the official docs;
this file only exists so we don't reinvent formats. Re-research if formats
change.

- Skills: https://code.claude.com/docs/en/skills
- Hooks: https://code.claude.com/docs/en/hooks
- Sub-agents: https://code.claude.com/docs/en/sub-agents
- Settings: https://code.claude.com/docs/en/settings
- Settings JSON Schema: https://json.schemastore.org/claude-code-settings.json
- Examples: https://github.com/anthropics/skills

---

## Skills — `.claude/skills/<name>/SKILL.md`

Required: `name`, `description`. Everything else is optional.

```markdown
---
name: my-skill
description: What it does + when to use it. Description is keyword-matched for auto-discovery — front-load the trigger phrases ("red team", "live run", "dial the target"...).
allowed-tools: Bash(node *), Read, Write       # pre-approve specific tools/commands
disable-model-invocation: false                # true = user-invoked only (no auto-triggering)
user-invocable: true                            # false = Claude-only, hidden from slash menu
model: sonnet                                   # override session model for this skill's work
effort: high                                    # low | medium | high | xhigh | max
context: fork                                   # 'fork' = run in subagent, isolated context
agent: Explore                                  # which subagent type if context: fork
paths: src/**/*.ts                              # auto-load skill when files matching glob are touched
argument-hint: "[label]"                        # CLI autocomplete hint
arguments: [label, users]                       # named positional args (CLI)
---

# Skill body — the instructions Claude follows

Keep main SKILL.md focused (target ~500 lines max). For long supporting
material, bundle alongside and reference:

- `reference.md` — detailed docs, lazy-loaded
- `examples.md` — usage examples
- `scripts/<helper>.sh` — executable utilities
- `assets/<template>.md` — templates, icons, data
```

**Folder layout:**

```
.claude/skills/my-skill/
├── SKILL.md        # required
├── reference.md    # optional
├── examples.md     # optional
├── scripts/        # optional
└── assets/         # optional
```

**Two patterns:**
1. **Skill-as-prompt-template** (e.g. our red-team skills): the SKILL.md body is
   a template Claude fills in and sends to an `Agent`. No external scripts.
2. **Skill-as-procedure** (e.g. our `bench-live-call`): the SKILL.md body documents a
   sequence the agent walks, with the gates and stops made explicit.

---

## Hooks — configured in `settings.json`, NOT separate files

Hooks live in `.claude/settings.json` under the `hooks` key. The
`.claude/hooks/` directory holds *referenced* shell scripts (not config).

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "if": "Bash(rm *)",
            "command": "./.claude/hooks/block-rm.sh",
            "timeout": 10,
            "statusMessage": "Validating destructive command..."
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [{ "type": "prompt", "prompt": "Does this match style guide?", "model": "fast-model" }]
      }
    ]
  }
}
```

**Hook types:** `command` (shell), `http` (POST), `prompt` (Claude evaluates),
`agent` (spawn subagent).

**Event types:** `PreToolUse`, `PostToolUse`, `SessionStart`, `CwdChanged`,
`FileChanged`, `UserPromptSubmit`, `Stop`.

**Hooks are how you make automated behaviors stick** — prose in a skill or a
memory CAN'T make Claude run something deterministically; that's what hooks are
for.

---

## Sub-agents — `.claude/agents/<name>.md`

```markdown
---
name: code-reviewer
description: Reviews code for quality and best practices. Use after substantial changes.
tools: Read, Glob, Grep                      # whitelist
disallowedTools: Write, Edit                 # blacklist (read-only enforcement)
model: sonnet
maxTurns: 5
isolation: worktree                          # run in a fresh git worktree
permissionMode: default
---

You are a senior code reviewer. When invoked, analyze code for quality,
security, performance. Return specific, actionable feedback.
```

**When to use a custom agent vs `Agent` tool inline:** Use a custom agent for
*recurring* delegation patterns the user wants visible in the agent picker. Use
inline `Agent` calls for one-off delegation.

---

## Settings — `.claude/settings.json` (committed) and `settings.local.json` (gitignored)

```jsonc
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": ["Bash(pnpm vitest *)", "Bash(node scripts/*.mjs *)"],
    "deny":  ["Bash(curl *)", "Read(./.env*)"]
  },
  "env":     { "DEBUG_LOGGING": "true" },
  "hooks":   { /* see Hooks section */ },
  "model":   "opus",
  "effort":  "high"
}
```

**Scope precedence (higher wins):**
1. `~/.claude/settings.json` (user, all projects)
2. `.claude/settings.json` (project, committed)
3. `.claude/settings.local.json` (project, gitignored — local overrides)
4. Org/managed settings (above all)

---

## Drift check — what's in this repo

This repo keeps agent-shared content in `.agents/` (canonical) so it works
across coding agents: root `AGENTS.md` holds the project instructions, root
`CLAUDE.md` imports it via `@AGENTS.md`, and `.claude/skills` is a symlink to
`.agents/skills` so Claude Code auto-discovery still works.

Rows are claims. Re-verify against the tree before relying on any of them.

| Artifact | Status | Notes |
|---|---|---|
| `AGENTS.md` (root) | ✓ aligned | Canonical project instructions, cross-agent |
| `CLAUDE.md` (root) | ✓ aligned | Thin `@AGENTS.md` import + entry-point note |
| `.claude/CLAUDE.md` | ✓ aligned | Symlink → `../AGENTS.md` |
| `.claude/skills` → `.agents/skills` | ✓ aligned | Symlink; skill folders keep the standard `SKILL.md` shape |
| `.agents/skills/bench-live-call/` | ✓ aligned | The dial procedure — pre-flight gate, one call at a time, never dials itself |
| `.agents/skills/red-team-review/` | ✓ aligned | Red-team bug review of production code |
| `.agents/skills/test-red-team/` | ✓ aligned | Red-team audit of the test suite (fixture lies are the local hazard) |
| `.agents/skills/mutation-red-team/` | ✓ aligned | Injects regressions in a `/tmp` copy; catalog carries Increments 0–7. The `/tmp` copy excludes `.env` — it now holds live credentials and the target's number |
| `.agents/reference/` | ✓ aligned | `anti-slop.md`, `anthropic-conventions.md` (this file) |
| `.agents/assets/` | ✓ aligned | `chime.wav` (your move), `chime-done.wav` (done) |
| `.claude/settings.json` | not used | No committed permissions/env yet. Candidate: a `deny` on the dial script as a second, harness-level layer. Less urgent since 2026-07-16: `dialSystemUnderTest` (scripts/lib/twilio.ts) enforces the target gate structurally — TTY-typed confirmation at the moment of the dial. |
| `.claude/agents/` | not used | Skills spawn Opus sub-agents inline via the `Agent` tool |
| `.claude/hooks/` | not used | Increment checkout is enforced by prose. Candidate: a typecheck-after-edit hook once churn justifies it |

## Deliberate divergence from the sibling repos

`job-hunter` pins its skill rows with a `conventions-drift.test.mjs`. This repo
has no such test yet — the table above is unpinned prose and can rot. Worth
adding once the skill set stops moving; noted here rather than silently
diverging.

## When to update this file

- A skill, hook, agent, or settings field doesn't behave the way this doc says
- Anthropic ships a new artifact type or deprecates one
- A pattern in this repo diverges from the canonical shape and needs to be
  documented as a deliberate exception

If in doubt, re-fetch the official docs URLs at the top.
