# Warm-up call — script

One call, placed by the maintainer, read from live. Its purpose is to learn the
flow so the target simulator resembles the real system instead of a guess at it.
It is not a bench run: nothing is asserted, and the notes are impressions rather
than findings.

Recording it is optional — permitted per the determination in [plan.md](plan.md),
but not needed here. **Any audio captured this way stays reference material and
never becomes a test fixture**: a room mic on a speakerphone sounds nothing like
the ~8kHz mulaw the bench hears off the wire, and a fixture built from it would
lie about real call audio. Verbatim evidence starts at Increment 5, where Twilio
records the wire itself.

The call is invited. The listing in [brief.md](brief.md) says: *"Call it, ask for
a windshield quote on any car, then tell me what you'd fix."* Asking for a quote
on the A3 is the assignment, not a pretext for it — so speak plainly and skip
the persona. The bench's synthetic callers come later, behind the scenario seam.

**Bounds: one call. No redial.** If it drops, that's a note, not a reason to
call back.

---

## Before dialing

- Notes open, or pen and paper. Take them either way — the notes are what the
  simulator gets built from, and they're faster than re-listening to audio.
- Know the two rules below cold. They are the only parts that can't be improvised.

## Rule 1 — a human answers, the call ends

If a person picks up, or the agent transfers you to one, stop the script. You
are not testing a human being ([AGENTS.md](../AGENTS.md) invariant). Say:

> **"Sorry — I've got what I needed, I don't need to book anything. Thanks for
> your time."**

Keep it short and don't explain. The person who answers works at the shop and
has no context for a hiring post or a test bench; an explanation buys them
confusion, not clarity.

Then end the call. Note that a human answered; that fact is itself worth having.

## Rule 2 — silence is the instrument

After you give the car, **stop talking.** The whole point of the first probe is
what the system does with an underspecified input, and filling the gap destroys
the measurement. Count five seconds in your head before you say anything else.
Dead air feels much longer on a call than it is.

---

## The script

**1. Opening — then wait.**

> **"Hi, I'd like to get a quote for a windshield replacement."**

**2. Give year and model only. Then stop.** (Rule 2.)

> **"I'm asking about a 2009 Audi A3."**

The A3 has real glass variants — rain/light sensor, humidity sensor, acoustic
glass — that change the part and the price ([brief.md](brief.md)). Asking a
clarifying question is correct here. Quoting a number straight away is the
finding. Either way, let the silence run first.

**3. Answer what it asks, minimally and honestly.**

Give one fact per question. Don't volunteer the sensor — whether it asks is the
thing being observed. If you don't know an answer, say so:

> **"I'm not sure — how do I tell?"**

That is a real customer's answer, and how it handles a caller who can't
self-serve is worth seeing.

**4. If a quote arrives, ask about the fork.**

> **"Is that OEM glass or aftermarket?"**

Two plausible, separated numbers means a working price lookup. One number for
both is a note.

**5. The camera question.** Ask it plainly, as a customer would:

> **"Does it need a camera recalibration afterward?"**

The 8P A3 has no forward-facing camera, so for that year a clean *no* is
correct. A yes — especially a yes with a fee — is the highest-value observation
available on this call. Ask once. Don't argue with the answer; record it.

**6. Close without booking.**

> **"That's everything I needed — I'm not ready to book yet. Thanks for your
> help."**

Don't accept an appointment slot, and don't give a callback number. A booking
costs the shop a real slot on a real calendar.

---

## What to write down

The simulator gets built from this, so favor wording over impressions. Rough is
fine; a phrase you actually heard beats a paraphrase.

- **Greeting** — its opening line, as close to verbatim as you can get.
- **Did it ask before quoting?** Yes/no, and what it asked.
- **The quote** — the number, and what it covered. Both numbers if you got two.
- **The camera answer** — verbatim if possible. This is the one worth getting right.
- **The wait before the quote** — roughly. Seconds, not milliseconds; the real
  measurement is the bench's job, not yours.
- **What filled that wait** — speech, a filler phrase, or dead air. Dead air
  during a lookup is visible without interpretation, which makes it clean.
- **Read-back** — did it repeat anything back to you, and in what order?
- **A human** — was one ever offered? (Offered is the observation. Don't take it.)
- **Anything that surprised you.** The simulator is only as good as the texture,
  and the unscripted moments are where the texture is.

## After

Type the notes into the chat. They become the simulator's behavior spec — the
practice target we can call a thousand times so the real line gets called a
handful.
