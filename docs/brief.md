# Brief — where this project came from

Verbatim record of the request that started callbench, plus the reasoning that
turned it into a project. Nothing here is a spec; the spec is
[plan.md](plan.md) and the per-increment contracts. This file exists so a fresh
agent can see the original intent without a human re-explaining it.

## The listing (verbatim, 2026-07-15)

A hiring post from the founder of Nexus, reproduced as received:

> Building agents against systems you don't control since 2018. Web Audio and
> WebRTC in the toolkit. Our codebase is going to feel familiar to you inside
> an hour.
>
> Nexus is a voice AI that runs a real auto shop's front office. Calls stream
> through Twilio into OpenAI's realtime model, which quotes from the shop's
> live pricing, books to the right tech, and handles confirmations, deposits,
> and invoicing. Dealer and insurance partners get their own portals, and staff
> can teach the agent new facts with approval gates. The shop it runs is a
> three-time XPEL Colorado Dealer of the Year; we built it with them, not just
> for them.
>
> I'm hiring the founding full-stack engineer for the multi-tenant build.
> $190–210K plus 1–1.5% equity, remote US.
>
> Call it, ask for a windshield quote on any car, then tell me what you'd fix:
> (720) 722-9242. 20 minutes?

The ask is literal: call the line, find what you'd fix, report back. The
invitation to call is the whole interview's first round.

## The maintainer's request (verbatim, 2026-07-15)

> Independtly and this will eventually happen in a different folder, I want to
> create an automation test for this number where I use voice to drive testing
> the system I'm asked to here.

And, on what the calls should probe:

> Some things I want is to say something in the flow that will require the
> system to do disabiguation, workflow including having to force going back
> ensure changes are remebered, I want to know how long it will take when
> considering the quote, ect.

Then, on scaffolding this repo:

> Look at all the scaffolding in job-hunter and job-hunter-video like .agents,
> AGENTS, the skills, utilities, and everything else. Decide which we are going
> to bring over to the new folder like the testing review skills. Create a new
> folder in ~/Projects with an appropriate name for this. Then scaffold the
> project. Put all the explaination and the original request in docs/.

Test car, chosen by the maintainer and kept as the reference scenario: a **2009
Audi A3**.

## Why that car is the right probe

The 8P-generation A3 spans 2006–2013 and carries real windshield variants —
rain/light sensor behind the mirror, humidity sensor, acoustic glass. The
variants change the part and the price, so a correct quote *cannot* be produced
from year+model alone. That makes the car a natural test of whether the system
asks a disambiguating question or quotes blindly. It also has no forward-facing
camera, so an offer of ADAS recalibration for that year is a fabrication with a
dollar figure attached — a check with an unambiguous right answer.

This reasoning is the seed of the probe catalog in [probes.md](probes.md), and
it generalizes: a good test input is one where the correct behavior is to ask,
and where a confident wrong answer is distinguishable from a right one.

## Why build a bench instead of just calling

A human can place the call and form an opinion in twenty minutes. Three things
push toward a harness:

1. **The findings are the interview.** "The quote came back without asking
   about the rain sensor" is an opinion. The same claim with the audio, the
   transcript span, the timestamp, and a re-runnable scenario that reproduces
   it is evidence. The deliverable stops being a critique and becomes a test
   suite the founder can run.
2. **The thing being tested is what the job builds.** The post names Twilio,
   realtime voice, Web Audio, WebRTC, and agents driving systems you don't
   control. A bench built on the same stack is the work sample, and it argues
   the point the post opens with rather than restating it.
3. **Some findings only exist under repetition.** Latency distribution, barge-in
   handling, and whether a correction survives to the confirmation are
   properties of many runs, not one call. A person can't hold p95 in their head.

## Scope, and the fence around it

In scope: place a call, hold a scripted-plus-improvised conversation, capture
audio and timings, transcribe, assert against a scenario's expectations, emit a
diffable report.

Out of scope, permanently: anything that changes, stresses, or works around the
system under test. It is a real shop's front office; a call that reaches a
person costs that person real time, and a redial loop costs the business
availability. The invariants in [AGENTS.md](../AGENTS.md) — human-approved
dials, bounded runs, a human on the line ends the test — are not ceremony. They
are the terms under which this project is allowed to exist at all.

Deliverable shape, current intent: a handful of scenarios, each run a small
number of times, producing one report the maintainer reads and turns into a
message. The prose of that message is Adam's judgment and voice, written by
Adam. The bench's job ends at the evidence.

## Cross-repo relationship

Standalone by design. It borrows scaffolding from `~/Projects/job-hunter` and
`~/Projects/job-hunter-video` — the `AGENTS.md` spine, the `.agents/` layout,
the red-team and self-improve skills, the Biome/Vitest/TypeScript setup — and
shares no code, no data, and no state with either. It is not a package of
job-hunter and must not import from it.

If the findings ever become an application artifact (a cover letter, a video),
that packaging happens in those repos, from the frozen report this one
produces.
