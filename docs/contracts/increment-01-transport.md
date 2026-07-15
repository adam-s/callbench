# Increment 1 — Transport contract

What this increment locked in. Later increments may rely on these without
re-checking; changing an entry is a flag to raise with the maintainer, not a
silent edit.

Frozen 2026-07-15. Evidence: two loopback runs (`data/loopback/1784136375739`,
`data/loopback/1784136765947`), the frame capture (`data/probes/media-*`), and
the contract tests in `packages/transport`.

## The transport contract

`packages/transport/src/contract.ts` — `TransportSession`, `TransportEvent`,
`MediaFormat`. Provider identity travels as data (`provider`, `sessionId`).
Adapters differ only in how they connect and map; nothing downstream may learn
which adapter produced a record except by reading those fields.

## The frame format (measured, not documented)

Twilio Media Streams, measured off a live call on this account:

```json
"mediaFormat": { "encoding": "audio/x-mulaw", "sampleRate": 8000, "channels": 1 }
```

- Event sequence `connected → start → media…`; `stop` on hangup.
- `sequenceNumber`, `media.chunk`, `media.timestamp` are **strings** on the
  wire and stay strings in the codec.
- 160 bytes = 20ms. `0xFF` = digital silence. Payloads are headerless base64.
- One `<Connect><Stream>` with no `track` attribute forks the **inbound**
  track only.
- Outbound media must be headerless base64 mulaw at 8000; `mark` is the only
  honest playback-complete signal; `clear` is the barge-in primitive.

Pinned by `packages/transport/src/twilio/__tests__/` against fixtures cut from
the real capture (provenance in the fixtures README). The adapter refuses a
`start` that declares any other format.

## The clock and its layer

- `atMs` = monotonic milliseconds (`performance.now()` deltas) from the
  session's zero, **stamped in the adapter's socket-message handler, before
  parsing**. `anchorEpochMs` = wall-clock epoch at `atMs = 0`.
- A session's zero defaults to its creation instant. **Cross-session
  subtraction requires a shared zero**, which adapters accept as an option and
  a runner hosting both legs of one call must pass. This rule was earned: the
  first cross-leg subtraction without it produced a negative 43-second
  "latency".
- A provider's own timestamps (`media.timestamp`, provider events) are data,
  never timing endpoints.

## The timing baseline (measured)

One process hosting both legs, one clock, one layer. The harness+provider
overhead floor — **not** anybody's response latency:

| figure | run 2 | run 1 (salvage) |
|---|---|---|
| round trip, sim spoke → sim heard bench's reflex answer | 362.2 ms | ~358 ms |
| one-way, sim greeting → bench ear | 177.6 ms | — |
| one-way, bench tone → sim ear | 184.0 ms | — |

Any future latency figure reported about a target must be read against this
floor. Media packet cadence at our socket: ~20ms between frames.

## Adapter behaviors under contract test

- Handshake-first: no session exists until `connected → start` completes and
  the declared format matches; otherwise reject + close.
- A socket drop without `stop` is an `error` event, never a clean `stopped`.
- Malformed mid-call messages end the session with a reason.
- Unknown-but-well-formed events are DEBUG-logged and skipped (a benign new
  Twilio event must not end a live call, and must not vanish).
- The inbound buffer is bounded; overflow surfaces as an `error` that is
  itself delivered past the cap (`pushTerminal` — the terminal event must
  never be what the full buffer drops).

## Operational facts the next agent needs

- Local serving requires a tunnel; the settle-before-DNS and
  verify-before-dial knowledge lives in `scripts/lib/tunnel.ts` and
  `docs/references.md`. Removing the settle wait re-breaks it.
- The simulator number's `VoiceUrl` is repointed per run through Twilio's API
  (the system's own realm) — each quick tunnel has a fresh hostname.
- `serve.ts` is untested network glue by design; the loopback run is its test.

## What this increment deliberately did NOT do

- No transcript (that word in the plan's original "done when" is satisfied by
  the timestamped frozen event record; the *speech* transcript is
  Increment 2's).
- No STT/TTS provider choice; no turn model; outbound audio was tones.
- No second transport adapter — SIP and browser-WebRTC remain future adapters
  behind this same contract.
