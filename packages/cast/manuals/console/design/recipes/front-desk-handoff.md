# Front desk that routes users

**Use case.** One agent is the address everyone starts at — the
public bot, the support contact, the household's shared number.
Behind it sit specialists: one holds billing context, one handles
scheduling, one owns a project. The front desk's job is the routing
judgment — *who should own this person's thread* — and then getting
out of the way. The user keeps talking in the same chat; the agent
on the other end changes.

**The shape.** A push handoff per destination
(`../multi-agent-composition.md` § Push — hand a user over). The
front desk pushes its *current participant* to a specialist's
channel; the specialist opens or resumes a conversation with that
user; the front desk drops out. Subsequent replies flow
specialist ↔ user.

- **Front desk** — a `default` user channel, persistent, where
  strangers or members arrive. Its `prompt.md` carries the routing
  table in prose: what each destination owns, what signals route
  there, and the narration discipline below. Its grants hold `p`
  toward each specialist it can hand to, on the channel it pushes to.
  Tool surface can be narrow — the desk needs push, not scheduling or
  extension writes.
- **Each specialist** — hosts the handoff on a user channel, most
  often its existing `default` (the canonical reuse case: the
  user-hosting channel is exactly what a push handoff needs). A
  dedicated named channel (`support`, `billing`) only when the
  specialist's `default` is busy with another audience or needs a
  different shape.
- **The edge has two halves.** Cross-agent push carries a *person*,
  so two owners have a say. The front desk's `acl.json` holds `p`
  toward each specialist on the destination channel — the desk's
  owner granting the desk reach to route a user there. The carried
  user needs access (`io`) on that same channel — the specialist's
  owner granting *this person* a conversation. Design names the shape
  and channel; Configure writes both halves
  (`/ref/manuals/console/cross-agent-acl.md`).
- **The access half, in practice.** When the desk and its
  specialists share one owner, the access half is auto-approved — the
  person the desk routes is already inside that owner's trust, and the
  push lands on first try. Across owners, the carried user's access is
  the gate: the specialist's owner either grants the user ahead of
  time, or answers a held first handoff — allow-once for one
  hand-over, allow-always to grant the user and let later handoffs
  flow. Name the cross-owner case in the handoff to Configure; it is
  the half operators forget.

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
safety](../zone-safety.md) with the push as the only crossing, and
the crossing carries a *person*, not data access.

**What this enables.** One stable public address over an evolving
fleet. Specialists can be added, replaced, or upgraded without the
user learning a new contact — the desk's `p` grant toward the new
specialist is the only change. Each specialist sees only the users
actually routed to it.

**Where it doesn't fit.** When the caller needs an *answer*, not an
*owner* — that's `q`/`a` relay
([Specialist behind a query-only door](specialist-behind-query.md)),
and the desk answering from a specialist's reply keeps the user
relationship in one place. When the "specialists" are steps of one
job rather than owners of different domains — that's
process-decomposition (`../anti-patterns.md`); fold them. When the
routed person won't be admitted on the far side — each specialist's
owner controls who converses there, so a handoff to an owner who
declines (or never answers) drops the user. The desk routes freely
within one owner's fleet; across owners it routes only where the
access half is granted or reliably approved.

**Variants.**

- *Triage with a pre-check.* The desk holds `q` toward specialists
  and asks (*"is this yours?"*) before handing over. One q/a hop
  buys routing accuracy; pay it only where misroutes are costly.
- *Return path.* The specialist holds `p` back toward the desk and
  returns the user when its piece is done — two push edges, one per
  direction, each independently granted.
- *Escalation desk.* Routing keyed on severity rather than topic:
  routine stays with the desk; the rare hot case is handed to the
  operator-facing specialist. The desk's filter judgment is the
  product ([Quiet processing channel](quiet-processing-channel.md)
  applied to people instead of events).

**Composes.** The two-sided push edge (sender's `p` toward the
specialist, the carried user's `io` on the receiver — both per
destination), `conversation__push_to_channel` with `target_agent`,
source attribution on the receiving side
(`<cast:push fromAgent fromParticipant>`), zone placement (public
desk, private specialists).

**Cross-link.** [Specialist behind a query-only door](specialist-behind-query.md)
moves *answers* across the wall; this recipe moves *people*. The
two compose: a desk that answers small questions by `q`/`a` and
hands over the threads that deserve an owner.
