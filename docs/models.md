# Models — how they run, how the bench reaches them

Sibling to [drivers.md](drivers.md) (how a call is placed) and
[speech.md](speech.md) (which STT/TTS). This file is the cross-cutting layer:
**where models run, and the one seam the bench talks to them through** — the
same shape whether the model is speech-to-text, synthesis, the persona that
holds a conversation, or the judge that scores an assertion.

## The decision

**Everything runs on Modal**, served behind OpenAI-compatible HTTP endpoints,
reached through one provider seam. Maintainer decision, 2026-07-15: there is
budget, and one hosting story beats four. The operational side — deploy,
manage, cost — lives in [infra/modal/](../infra/modal/); this file is the why
and the shape.

Two facts make Modal the right host rather than a compromise:

- **A model that doesn't fit a laptop fits a rented GPU**, and Modal scales it
  to zero when idle — a served endpoint costs nothing between calls and
  pay-per-second while running. The pattern is proven in the maintainer's other
  repos (`car-diagnosis`, `goldseam`, `detect-study`): a vLLM OpenAI-compatible
  endpoint, `min_containers=0`, a warm `scaledown_window`.
- **The latency it adds lands where it doesn't hurt.** Measured 2026-07-15: a
  request from the maintainer's location to Modal's US edge floors at ~455ms.
  That would wreck a 20ms-frame live path — but the record/assert split means
  almost nothing latency-critical crosses it. See the split below.

## The one seam: a provider runner

Adopted from `goldseam`'s runner pattern (see
[references.md](references.md)): **a runner maps an input to an output, and the
core never learns which model — or which host — produced it.** Selection is a
`provider:model` string, and the host is a base-URL override, so Modal, a local
process, and `claude -p` are three adapters behind one contract, swapped by
config, never by code.

This is the concrete form of the one-interface-per-source invariant in
[AGENTS.md](../AGENTS.md) and the seam named in
[architecture.md](architecture.md). The shapes:

| selector | reaches | used for |
|---|---|---|
| `openai:<model>` + base URL | any OpenAI-compatible endpoint — **Modal** first | STT, TTS, persona, judge (bootstrap) |
| `claude:<model>` | `claude -p` (Claude Code CLI, print mode) | the judge, once it works — see below |
| `ollama:<model>` | a local Ollama daemon | offline fallback, cheap iteration |
| `cmd:<exe>` | a subprocess: input on stdin, output on stdout | the escape hatch |

OpenAI-compatible is the spine because the audio APIs are part of it —
`/v1/audio/transcriptions` (STT), `/v1/audio/speech` (TTS), `/v1/chat/completions`
(LLM) — so a Modal endpoint, a hosted provider, and a local server all wear one
client. Identity still travels with the record: every produced turn or verdict
carries an explicit `provider:model` tag, so a shared stage never re-derives it
from one host's quirk.

## The latency split — why Modal's 455ms is a non-issue

The record/assert architecture already separates the live path from the
offline path. Put each model stage on the side where its latency is free:

| stage | path | host | why the 455ms is fine |
|---|---|---|---|
| **STT** (authoritative) | offline, over the frozen recording | Modal | the transcript is asserted offline; no live budget |
| **TTS** (scripted) | pre-rendered before the call | Modal | a scenario knows its lines; synthesize to mulaw ahead, play from a buffer |
| **turn-taking** | live, in the 20ms path | **local**, cheap | energy / VAD / a small on-Mac model — never crosses the network |
| **persona** (improvised) | live, Increment 6 | Modal, streamed | the one genuinely live model call; streaming hides first-token latency, and a persona turn tolerates a beat |
| **judge** | offline, over frozen artifacts | Modal → `claude -p` | batch scoring; no live budget at all |

The rule that falls out: **the live 20ms path holds only local, cheap logic.**
Anything that crosses to Modal is either offline (latency irrelevant) or
pre-rendered (latency paid before the call). This is what makes "everything on
Modal" and "~455ms to Modal" both true at once.

## Streaming

**Prefer streaming wherever the endpoint offers it** — the principle in
[AGENTS.md](../AGENTS.md). OpenAI-compatible endpoints stream: chat via SSE
token deltas, `/v1/audio/speech` via audio chunks, STT via a WebSocket for the
live case. Take those.

Where it applies here: the persona streams tokens so the first audio goes out
before the whole reply exists; TTS streams chunks so playback starts before
synthesis finishes; the UI streams its render. Where it does **not** reach: the
frozen artifact is still assembled whole and hashed once complete — streaming
is an edge behavior, the record is atomic.

## The judge, and the `claude -p` migration

The judge starts on a Modal-served OpenAI-compatible LLM (the same endpoint the
persona uses — one deploy, `openai:` runner). **Once it works, it moves to
`claude -p`** (Claude Code CLI print mode, the `claude:` runner) — maintainer
decision, 2026-07-15. Reasons: it is a stronger judge, it needs no GPU deploy,
and swapping the runner selector is the whole change — the judge stage, its
cache key, and its verdict schema do not move. Modal-served LLM stays as the
bootstrap and the offline fallback.

This is exactly what the runner seam buys: the judge's determinism story (a
verdict frozen against a content hash, [architecture.md](architecture.md)) is
independent of which runner produced it, so the migration is a config line, not
a rewrite.

## Cost

Scale-to-zero is the whole cost model: idle endpoints bill nothing, and a run
pays per-second of GPU only while a container is warm. GPU tier is per-endpoint
config (STT needs far less than a 14B LLM). Concrete numbers and the guardrails
that enforce them live in [infra/modal/README.md](../infra/modal/README.md).
