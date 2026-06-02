# Reviewer that interviews the team

**Use case.** You've built two or three agents that each handle a
different slice of work. You want one agent that periodically checks
in with them — what's working, what's stuck, what they've noticed —
and gives you a synthesized report. Scales as the fleet grows;
manually opening each agent's chat to ask is slow at three and
impossible at ten.

**The shape.** A reviewer agent with `peers.md` listing each
reviewable agent. Each reviewable agent exposes a `review` (or
similar) channel — single-shot (`idle_timeout: null`) so each
review cycle starts fresh with no state bleed from prior cycles,
`disabled_tools` blocks mutation-shaped tools, `acl.json` grants
`a` to the reviewer on the `review` channel (receiver-side
inbound). The reviewer's own `acl.json` grants `q` to each
reviewable agent on `review` (sender-side outbound).
On a scheduled fire (from `props/schedule.txt` for an
operator-locked cadence, or `task__schedule` for adaptive) landing
in a `review-runner` channel — single-shot
(`idle_timeout: null`) for the same reason (each scheduled review
is an independent unit of work), narrow `disabled_tools` (no
extension writes, no further scheduling) — the reviewer iterates
its peers list, emits `<cast:query target="<peer>" channel="review">`
to each with a question, collects `<cast:answer>` responses.
Optionally runs a follow-up round on responses worth probing —
*"you mentioned X — can you elaborate?"* — then synthesizes a
report into `/memory/reviews/<date>.md`. Surfaces to the operator
via `conversation__push_to_channel` (no `target_agent`) from
`review-runner` to the reviewer's `default` channel with a short
summary referencing the report file path — the operator opens the
file from there.

**What this enables.** Cross-agent visibility through
self-narration. Each reviewed agent reports its own state (it knows
what's working better than any external check); the reviewer
applies cross-cut judgment that no individual agent has. The
reviewer's role is *synthesis* — noticing patterns across agents,
flagging concerns, recommending where the operator should look.

Compositionally this is the
[specialist-behind-query-door pattern](specialist-behind-query.md)
*in reverse* — one caller (reviewer), many specialists (reviewed
agents). Each reviewed agent serves the reviewer through a
single-shot query channel; the reviewer aggregates. No mutation:
review is information-only, which keeps blast radius bounded and
audit trail intact.

**Where it doesn't fit.** Cases where the reviewer should *act* on
findings rather than report — see Variants below before breaking
the no-mutation property; mutation paths exist in Cast, they just
don't run from one agent into another's blueprint. Real-time
monitoring (a log + watch shape fits better than scheduled Q&A).
Single-agent systems where the reviewer's work is just memory
consolidation — see
[Nightly reflection and memory consolidation](nightly-reflection.md).

**Specifically not the recipe: RW-mounting peer blueprints.** A
tempting extension is mounting reviewed agents' `blueprint/` as RW
into the reviewer, letting it apply changes directly. *Don't.* This
breaks Cast's mount-as-trust-boundary property (every other
security primitive assumes mounts mean what they say), creates a
privileged agent class with no analog elsewhere in the system, and
skips Cast's supervised-authoring path (Design under operator gaze,
or Claude Code on the host with operator review). The error budget of the
reviewer's prompt becomes the error budget of the entire team.
The softer variants below preserve the boundary.

**Variants.**

- *Multi-pass interview.* Round-1 broad questions; round-2
  follow-ups on signal. Each round is one query/answer hop per peer.
  Cheap to add; meaningfully richer reports.
- *Report-and-recommend.* Reviewer's report includes specific
  suggestions ("agent X's prompt is drifting on Y"), but takes no
  action. Operator opens Design on the named agents and iterates.
  Default for most cases.
- *Proposal log.* Reviewer writes proposals to a path it owns —
  e.g. `/memory/proposals/<date>.md`. An All-Agents Design session
  (or the operator directly) reads proposals and decides what to
  apply via the normal authoring path. The reviewer is a
  *proposer*, not an *applier* — Cast's existing supervised-
  authoring story handles application.
- *Targeted deep dive.* Instead of interviewing the whole roster
  every cadence, the reviewer focuses on one agent at a time on a
  longer cadence — deeper dive, less breadth, less context cost
  per fire.

**Composes.** `task__schedule` (the cadence),
`peers.md` and ACL `q`/`a` bits (the access shape),
`<cast:query>` / `<cast:answer>` (the Q&A primitive), single-shot
review channel on each peer with narrow `disabled_tools` (the
serving side), the reviewer's own user channel (where the report
surfaces). Fits naturally with
[Nightly reflection and memory consolidation](nightly-reflection.md)
— the reviewer is itself doing scheduled reflection, just with peer
Q&A as the input rather than its own memory.
