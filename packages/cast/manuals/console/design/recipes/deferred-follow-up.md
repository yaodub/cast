# Deferred follow-up on stored intent

**Use case.** A user states a decision, commitment, or expectation —
*"I'm starting to run three times a week," "I'm trying this new
diet for a month," "I picked vendor X expecting Y outcome."* Right
now they're focused; in 30 or 60 or 90 days they'll have moved on
and forgotten. You want the agent to come back to it on the user's
behalf — not on a fixed cadence, but *because of this specific
moment* — and ask how it actually went.

**The shape.** When the user states an intent, the agent does three
things in the same turn:

1. Writes the intent to `/memory/decisions/<date>-<topic>.md` with
   sections for *what they said*, *expected outcome*, and
   *follow-up date*. The schema is the contract — a self-describing
   entry that the future fire can parse without ambient context.
2. Calls `task__schedule` for the follow-up date: single-shot fire,
   far-future, target channel `default` (the user's channel — the
   fire arrives as a turn there). Payload includes the memory file
   path so the session handling the fire knows where to read.
3. Confirms briefly to the user: *"I'll check back in 30 days on
   this."*

When the fire arrives weeks or months later, the channel's prior
conversation has typically TTL'd out, so the fire opens a fresh
session on `default`. The session sees the inbound as
`<cast:schedule>` (not a participant turn), reads the file path
from the payload, `Read`s `/memory/decisions/<date>-<topic>.md`,
and opens with a question grounded in the original intent:
*"Three weeks ago you said you'd try X expecting Y. How did it
actually go?"* The user's reply writes back to the same decision
file as the *outcome*, alongside the original *expectation* — a
calibration record that accumulates over time.

The channel's `prompt.md` teaches the source-attribution discipline:
*"if the inbound is `<cast:schedule>`, don't greet — pick up the
deferred topic from the payload's file path; the user is not
expecting a fresh conversation."*

**What this enables.** A different trigger topology than recurring
reflection. Each fire is *intent-driven* — one user moment seeds
one future fire — rather than *cadence-driven* (cron fires
irrespective of context). The agent's behavior over time is shaped
by the *accumulation* of these scheduled revisits: drift, growth,
calibration. Self-knowledge that the user couldn't get without
scheduling discipline they don't have.

**Where it doesn't fit.** Decisions where the outcome is too
short-horizon to matter (today's lunch choice). Cases where
revisiting would be unwelcome — the user wants to make decisions
and move on, not relitigate. Long-horizon stuff where the schema
in `/memory/decisions/` may drift between intent-time and
follow-up-time; if the schema changes between writes and reads,
the fire reads garbled context. Pin the schema or write
self-describing entries.

**Variants.**

- *Multi-step calibration.* 30-day check-in, then 90-day, then
  yearly. Each fire reads the prior outcomes and asks the next
  one, then schedules the next horizon. The decision file becomes
  a record of expectation vs. reality at multiple horizons —
  useful for tracking calibration over a long arc.
- *User-suggested cadence.* Agent asks at intent-time: *"When
  should I check back?"* — the user picks the horizon. Custom
  rather than baked-in.
- *Silent revisit.* Instead of asking the user, the fire reads the
  decision and any context-since (memory writes, conversation
  summaries) and writes its own assessment to the decision file.
  Useful for self-knowledge where interrupting the user would be
  unwelcome but the record is still valuable. Wrap the fire's
  output in `<cast:internal>` so it doesn't surface.
- *Calibration-driven prompt update.* Over many decisions, the
  agent notices its own (or the user's) systematic miscalibration
  — *"you consistently overestimate how long projects take"* —
  and surfaces the pattern. Composes with
  [Nightly reflection](nightly-reflection.md), which is the right
  place to do this kind of cross-decision pattern-finding.

**Composes.** `task__schedule` (single-shot, far-future is the key
configuration), `/memory/decisions/<date>-<topic>.md` as the intent
store with self-describing schema, the `default` user channel as
the target where the fire lands, `<cast:schedule>` source
attribution (so the receiving session knows it's a deferred
follow-up, not a fresh user turn), the channel's `prompt.md`
directive that teaches the source-class branching.

**Cross-link.** Different from
[Nightly reflection and memory consolidation](nightly-reflection.md):
that one is cadence-driven over the agent's whole memory; this one
is intent-driven on a single stored decision. They compose well —
nightly reflection can scan upcoming follow-ups and prep richer
context for the fires that are about to land.
