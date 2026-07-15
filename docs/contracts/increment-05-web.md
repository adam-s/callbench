# Increment 5 — The web UI (frozen)

What this increment froze. Built server-side over the frozen record; the app
places no call. See [../ui.md](../ui.md) and [../plan.md](../plan.md) Increment 5.

## The on-disk run artifact (`@callbench/scenario` `artifact.ts`)

`RunArtifact` (version 1): `scenario`, `runId` (= the transcript hash), `target`
(`simulator` | `system-under-test`), `transcript`, `report`, `createdEpochMs`,
optional `audio`, and `bodyHash`. Stored at `<runsDir>/<scenario>/<runId>/run.json`.

`parseRunArtifact` REFUSES (throws) — never renders-with-warning — on: a missing
transcript/report/bodyHash, an unknown version, a transcript that drifted from
its turns, a report hash ≠ transcript hash, a **bodyHash mismatch** (covers every
displayed figure + the audio reference, so a FAIL edited to PASS is caught even
though the transcript still verifies), a duplicate assertion name, and a
mislabeled recording (see audio below). `buildRunArtifact` enforces the same at
write time.

`RunAudio`: `file`, `sampleRate`, `channels`, `durationMs`, `sha256`, and
`synthetic` provenance (`null` = a real capture; a string = synthesized, e.g.
`macos-say`). Coherence is frozen: a `simulator` run's audio is always synthesized
(`synthetic != null`); a `system-under-test` run's audio is always a real capture
(`synthetic == null`).

## Routes (path-based, server-rendered)

```
/                             test list
/tests/[test]                 one scenario: assertion matrix + runs
/tests/[test]/[run]           transcript, findings, waveform, turn ribbon, meter
/tests/[test]/[run]/[finding] deep link — lands on the cited span, plays it
/tests/[test]/[run]/audio     serves the frozen WAV (hash-verified)
```
`[run]` is the artifact's own id; `[finding]` is an assertion name (unique per
run, enforced). Every load re-verifies the hash; a missing run is 404, a
corrupt/drifted one is 500 with a fixed message (detail logged, never leaked).

## The dial fence (highest-severity)

The app builds NO path that could place a call. A structural test walks every app
source file and fails on any outbound-network / media-egress / telephony
primitive (fetch, XHR, WebSocket, RTCPeerConnection, getUserMedia, child_process
/ spawn / exec, `@callbench/transport`, telephony vendor names, the number env
vars, the dial script). It asserts the absence of the CAPABILITY, not one vendor.

`canReplay(target)` gates a re-RUN/dial control (simulator only) — which the UI
does not have. It does NOT gate playback: playing back a frozen recording is
EVIDENCE and is offered for any run with audio, including a real call. Server-only
fs access lives under `$lib/server` (bundler-fenced off the client).

## The waveform, measuring nothing

Peaks are computed server-side from the frozen WAV (`$lib/server/waveform.ts`,
PCM16 mono; refuses other formats) and passed to the page as data — the browser
never `fetch`es audio to draw it (the fence). The live meter reads the
`AnalyserNode` of the already-loaded `<audio>` during playback. Neither produces a
figure in any report.

## Gate

The gate widened for the app (a flagged amendment in
[increment-00-scaffold.md](increment-00-scaffold.md)): `apps/*` workspace,
`pnpm --filter @callbench/web check` in typecheck, `apps/web/src/**/*.test.ts` in
the Vitest node project, a `jsdom` project for the runes audio engine
(`*.dom.test.ts`), and Biome ignoring `.svelte-kit` + `.svelte`.

Pinned: `apps/web/src/lib/server/__tests__/*.test.ts`,
`packages/scenario/src/__tests__/artifact.test.ts`,
`apps/web/src/lib/audio/__tests__/transport.dom.test.ts`, and the catalog's
Increment 5 entries.
