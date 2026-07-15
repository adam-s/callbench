# Drivers — how a call actually gets placed

The transport survey behind the architecture, recorded so the next agent
doesn't re-run it. Options are ranked by fit for this project; the decision is
at the bottom.

Everything here is a claim about the world as of 2026-07-15 and was assembled
from reasoning plus the maintainer's account details, **not from a probe**. Per
the probe-before-building rule in [AGENTS.md](../AGENTS.md), treat pricing,
codec, and behavior specifics as labelled assumptions until Increment 1
measures them. The ranking is a starting point, not a finding.

## 1. Twilio Programmable Voice + Media Streams — chosen

REST API places an outbound call; a `<Connect><Stream>` verb forks bidirectional
audio to a WebSocket server. The server receives the far end's audio, transcribes
it, decides the next utterance, synthesizes it, and streams it back.

- Full turn-by-turn control, and — the reason it wins — **frame-level receive
  timestamps**, which is what makes latency a measurement rather than an
  impression. Every other option degrades that.
- The maintainer already holds an upgraded account with balance.
- It mirrors the stack of the system under test, which makes the bench legible
  to its intended reader.
- Assumed order of magnitude: ~$0.014/min plus ~$1.15/mo for a number. Verify
  against the account, don't quote from here.
- Audio arrives as 8kHz mulaw. Assumed; confirm the real frame shape by capture
  before writing a parser.

## 2. Agent-vs-agent — a mode, not an alternative

Same Twilio plumbing, but the conversational glue is a realtime model prompted
as a persona instead of a scripted turn machine. Less code, less determinism.

The useful form is hybrid, and it is the one the architecture targets: the model
carries the conversation, the harness injects scripted probes at fixed points,
and deterministic assertions run over the transcript afterward. Model judgment
stays in a named, isolated stage and never becomes load-bearing plumbing — the
rule in [AGENTS.md](../AGENTS.md).

Note the failure mode this invites: a model persona that improvises its way past
a probe point produces a call that looks successful and tests nothing. Probe
injection has to be enforced by the harness, not requested in a prompt.

## 3. SIP directly (PJSUA2, drachtio, baresip)

A SIP trunk plus a scriptable softphone. Most control over the audio path,
lowest per-minute cost, and you own codecs, NAT, and RTP. Worth it only to
avoid the WebSocket hop, which is not a problem this project has.

## 4. Twilio Voice JS SDK in a headless browser

Run the WebRTC client under Playwright and use Web Audio to inject synthesized
audio and capture the far end. More moving parts than Media Streams for no gain
in control — **except** that the listing names Web Audio and WebRTC, so there's
narrative value if the bench ever wants to demonstrate that surface directly.
Not the default path. If it's ever built, it's a second transport adapter behind
the same contract, which is exactly what the one-interface-per-source rule buys.

## 5. Other providers

Telnyx (cheaper media streaming, similar API), SignalWire (TwiML-compatible),
Vonage. No reason to switch at this volume. They are adapter implementations if
the question ever arises.

## Ruled out

**Google Voice.** No API. Manual-only, or fragile browser automation with no
clean audio access. Fine for a human warm-up call, useless as a driver.

## Adjacent prior art

Commercial voice-agent testing platforms — Hamming, Coval, Cekura/Vocera,
Retell's built-in simulation — do synthetic-persona calling with assertions.
Worth knowing the category exists and being able to say why you built rather
than bought. Not evaluated in depth.

## Account facts (maintainer-supplied, 2026-07-15)

- Account is upgraded and active with balance — past trial restrictions, so no
  trial notice is prepended to calls.
- **A number must be purchased.** Outbound needs a `from` caller ID. Verifying a
  personal cell as caller ID technically avoids the purchase, but then every
  test call presents a personal number. An owned number is the clean path, and
  it doubles as the inbound leg (below).
- **Inbound SMS works without registration; outbound does not.** The "Registration
  required" label on a US local number is A2P 10DLC, and it gates *sending*.
  Receiving is unaffected. This is the right half to have: the harness never
  sends a text, and an inbound number lets a scenario check that a booking
  confirmation actually arrived and carries the corrected values (Family 2 in
  [probes.md](probes.md)).
- **The target is itself a Twilio number.** The call stays on-net, so no
  intermediate carrier scores it for spam and a new number won't get screened.
  It also means measured latency reflects the target's own pipeline rather than
  PSTN transit — which is what makes the latency findings worth reporting.
  On-net does **not** mean the phone leg can be bypassed; the target is dialed
  like any other number.

## Decision

**Twilio Programmable Voice + Media Streams, with the hybrid tester on top.**
It's the only option that delivers frame-level timing, it's already paid for,
and it's legible to the audience. SIP and the browser-WebRTC path stay live as
future adapters behind the transport contract rather than as forks in the
design.

The first thing built against it is a loopback dry run — the harness calling a
number the maintainer owns, wired to a trivial answering endpoint — so the whole
loop (dial, stream, transcribe, respond, timestamp) is shaken out before a
single call reaches the shop. That rehearsal is Increment 1 in
[plan.md](plan.md), and it is not optional: the first dial to a real business
should be the first *interesting* call, not the first call.
