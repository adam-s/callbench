# Fixture provenance

`messages.json` holds four messages **captured from a real Twilio Media Stream**
(2026-07-15, `scripts/probes/probe-media-stream.ts`, one live call to the
maintainer-owned loopback number) — not hand-authored. A hand-authored fixture
would have gotten the surface wrong in at least one way these are right:
`sequenceNumber`, `chunk`, and `timestamp` are **strings**, and `streamSid`
appears both at the top level and inside `start`.

Edits from the raw capture, and nothing else:

- Account/call/stream SIDs replaced with same-length, same-prefix placeholders
  (`AC000…`, `CA000…`, `MZ000…`) — real identifiers don't belong in the repo.
- Only four messages kept: `connected`, `start`, the first `media` frame (mulaw
  digital silence, all `0xFF`), and one voiced `media` frame. Each media payload
  is 160 bytes = 20ms of 8kHz audio — unintelligible as speech by construction.

`capturedAtEpochMs` is the probe's own socket-read stamp, kept so tests can
exercise stamp plumbing with real values. If Twilio's wire format drifts, the
fix is a fresh capture with the probe — never editing these by hand.

## What the capture does NOT cover, and where those shapes come from

The 3.5-minute probe call produced only `connected`, `start`, and `media`
events — no `stop`, `dtmf`, or `mark`. Tests that need those deliver
hand-authored messages built to Twilio's **documented** shapes (see
`docs/references.md`), not to a capture:

- `stop` carries a nested `stop: { accountSid, callSid }` object — the tests use
  that real shape, and the codec type reflects it. An earlier version modeled a
  bare `{event, sequenceNumber, streamSid}` stop; that was an assumption pinned
  to itself, which catches no drift.
- `dtmf` and `mark` likewise follow the documented nested shapes.

These are the one place in the suite where a fixture rests on documentation
rather than measurement. The honest way to close it is a capture that actually
contains a hangup, a keypress, and a played mark — worth doing when a loopback
run naturally produces them (a bidirectional stream with `mark` playback does).
Until then, the shapes are documented-not-measured, and that is flagged here so
the next agent knows which fixtures are which.
