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
