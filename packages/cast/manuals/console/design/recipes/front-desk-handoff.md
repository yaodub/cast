# Front desk that routes users

**Use case.** One agent is the address everyone starts at — the
public bot, the support contact, the household's shared number.
Behind it sit specialists: one holds billing context, one handles
scheduling, one owns a project. The front desk's job is the routing
judgment — *who should own this person's thread* — and then getting
out of the way. The user keeps talking in the same chat; the agent
on the other end changes.

**The shape.** A `p`/`h` handoff edge per destination
(`../multi-agent-composition.md` § The three shapes). The front
desk pushes its *current participant* to a specialist's channel;
the specialist opens or resumes a conversation with that user;
the front desk drops out. Subsequent replies flow
specialist ↔ user.

- **Front desk** — a `default` user channel, persistent, where
  strangers or members arrive. Its `prompt.md` carries the routing
  table in prose: what each destination owns, what signals route
  there, and the narration discipline below. Its `peers.md` names
  each specialist and the channel to push to. Tool surface can be
  narrow — the desk needs push, not scheduling or extension writes.
- **Each specialist** — hosts the handoff on a user channel, most
  often its existing `default` (the canonical reuse case: the
  user-hosting channel is exactly what `p/h` needs). A dedicated
  named channel (`support`, `billing`) only when the specialist's
  `default` is busy with another audience or needs a different
  shape.
- **The edge** — front desk's `acl.json` holds `p` toward each
  specialist on the destination channel; each specialist holds `h`
  for the front desk there. Design names the shape and channel;
  Configure writes both sides
  (`/ref/manuals/console/cross-agent-acl.md`).
- **The pairing prerequisite** — a push hands over a *participant*,
  so the user must already be paired with the receiving specialist
  (pairing code redeemed, or static peering). Without the user's
  own `i` on the destination channel the bus drops the push. Name
  this step in the handoff to Configure; it is the part operators
  forget.

**Narrate before pushing.** The push is one-shot and the user may
land in a cold session on the specialist. The desk's prompt teaches:
tell the user what's happening (*"connecting you with billing
now"*), put what the specialist needs into the push text as a
conclusion, not a transcript (`economics.md` § 3), then push. The
specialist's channel prompt teaches the other side: an inbound
`<cast:push fromAgent fromParticipant>` opening a conversation is a
routed user with context in the body — greet the *user*, act on the
brief, don't re-interrogate.

**Why this seam is real.** The desk is a filter — the judgment of
*where this belongs* is its whole value, which is what separates it
from the courier shape (`../anti-patterns.md` § Courier agent). The
walls do work too: the desk faces the public and holds nothing; the
specialists hold context and credentials and never face the public.
That's the outer/inner zone split of [Degrees of zone
safety](../zone-safety.md) with `p/h` as the only crossing, and the
crossing carries a *person*, not data access.

**What this enables.** One stable public address over an evolving
fleet. Specialists can be added, replaced, or upgraded without the
user learning a new contact — the desk's `peers.md` and the new
edge's grants are the only changes. Each specialist sees only the
users actually routed to it.

**Where it doesn't fit.** When the caller needs an *answer*, not an
*owner* — that's `q`/`a` relay
([Specialist behind a query-only door](specialist-behind-query.md)),
and the desk answering from a specialist's reply keeps the user
relationship in one place. When the "specialists" are steps of one
job rather than owners of different domains — that's
process-decomposition (`../anti-patterns.md`); fold them. When
users can't be paired with receivers ahead of need — the pairing
prerequisite makes ad-hoc routing to arbitrary agents a non-shape.

**Variants.**

- *Triage with a pre-check.* The desk holds `q` toward specialists
  and asks (*"is this yours?"*) before handing over. One q/a hop
  buys routing accuracy; pay it only where misroutes are costly.
- *Return path.* The specialist holds `p` back toward the desk and
  returns the user when its piece is done — two `p/h` edges, one
  per direction, each independently granted.
- *Escalation desk.* Routing keyed on severity rather than topic:
  routine stays with the desk; the rare hot case is handed to the
  operator-facing specialist. The desk's filter judgment is the
  product ([Quiet processing channel](quiet-processing-channel.md)
  applied to people instead of events).

**Composes.** `p`/`h` ACL bits (per edge, both sides), pairing
(the user's own `i` on the destination), `peers.md` (the routing
table's address half), `conversation__push_to_channel` with
`target_agent`, source attribution on the receiving side
(`<cast:push fromAgent fromParticipant>`), zone placement
(public desk, private specialists).

**Cross-link.** [Specialist behind a query-only door](specialist-behind-query.md)
moves *answers* across the wall; this recipe moves *people*. The
two compose: a desk that answers small questions by `q`/`a` and
hands over the threads that deserve an owner.
