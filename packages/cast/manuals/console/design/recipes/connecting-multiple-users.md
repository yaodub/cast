# Connecting two or more users

**Use case.** Your roommate, your partner, and you all talk to the
same agent. It knows who said what; preferences stay separate; the
household calendar stays shared. The agent has cross-cut visibility
no individual participant has. You want that broader view to *help*
the group, in either of two ways: by surfacing relevant context
discreetly, or by intermediating explicitly between participants
who can't or won't talk directly. Generalizes to teams, families,
working groups, study cohorts — any group of humans coordinating
through one shared agent.

**The shape — one channel, per-participant ACL, shared substrate.**
Cast's `(channel, participant)` keying gives each user their own
private conversation on the same channel — same `prompt.md`, same
tool surface, isolated state. One `default` channel, persistent
(`idle_timeout: 1800000` or longer), with `i`/`o` granted to each
paired participant in `acl.json`. No new channel needed for the
multi-user shape; the participant dimension is already first-class.

The substrate — agent-scoped, accessed by all participants'
conversations:

- `/memory/users/<participant-id>.md` — per-user notes the agent
  curates from each conversation. Written by
  `channels/default/cleanup.md` at TTL expiry; read by
  `channels/default/bootstrap.md` on the next conversation start
  with the same participant. Participant ID is stable across
  sessions and can be used as a filename component.
- `/memory/shared/<topic>.md` — canonical artifacts the agent
  maintains in its own voice for cross-cut coordination. Written
  by `cleanup.md` when a conversation's content warrants updating
  the shared view; read by `bootstrap.md` so each participant
  enters with shared context.

Two modes share the substrate; they differ in editorial discipline
encoded in the channel's prompt files.

**Discreet mode.** The agent never tells one participant what
another said. Cross-cut info surfaces as the agent's *own
observation* — *"You'd probably enjoy that show — it's coming up
next week"*, not *"Mary mentioned she's seeing it"*. The directive
in `channels/default/prompt.md`: *"You may surface cross-cut
knowledge as your own observation. Never quote another participant.
The fact that you know things across the group is visible; the
source is not."* (If the agent has other channels with different
voice rules, this directive lives in the channel `prompt.md`. If
this is the agent's universal voice, lift it to
`identity/prompt.md` so every channel inherits it.) Each participant
experiences a private confidant who happens to have a broader view;
none experiences a leak. Use when the value is *ambient connection*
— household, family — and participants haven't asked for explicit
intermediation.

Both modes assume the agent *knows* its co-participants — the default
`show_co_participants: true`. Discreet mode constrains how it *uses*
that knowledge; it doesn't remove it. If the agent shouldn't know
other participants exist at all — a different design, not a stricter
prompt — that's `show_co_participants: false` (`primitives.md` §
Co-participant visibility). The spectrum: open is "knows, references,"
discreet is "knows, won't quote," the flag-off is "doesn't know."

**Mediated mode.** Participants *know* the agent is intermediating.
Each participant talks to the agent privately; the agent updates
`/memory/shared/<topic>.md` in its own voice — softening positions,
clarifying disagreement, proposing wording neither party would write
themselves. Both parties read the same canonical view. The
directive lives in `channels/default/cleanup.md`: *"At TTL expiry,
decide whether anything said this turn warrants updating
`/memory/shared/<topic>.md`. If so, append in your own editorial
voice. If not, leave it alone."* The shared artifact is the
cleanup's load-bearing output. Use when participants want to
coordinate without direct conversation: conflict resolution,
awkward exchanges, async meetings across schedules, negotiation
where each side has private constraints.

(For *joint authoring* — both parties writing into the same draft
directly, no editorial gate — drop the editorial layer: a raw
shared artifact plus the *Live coordination across participant
sessions* variant below is the shape. This recipe's value is the
gate.)

**Why a shared log beats per-party push in mediated mode.** A
shared `/memory/shared/<topic>.md` read by all participants beats
the agent pushing the same update separately to each:

- *Canonical state.* Both parties read the same version on
  bootstrap. The agent's framing can't drift across participants —
  it writes once.
- *Async tolerance.* Each participant engages on their own tempo;
  no sync bottleneck on the slowest one.
- *Persistent receipts.* The situation accumulates; no relitigating
  prior rounds. Conflict resolution especially needs receipts.
- *Editorial property holds.* The agent writes the summary in its
  own voice once at cleanup, not separately per party (where
  wording can diverge).

Push still has a role — *nudges* via `push_to_participant` between
participants on the same agent: *"Bob, there's an open question
waiting on you."* The recipe is **shared log as canonical state +
occasional pushes as attention nudges**, not log-only.

**What this enables.** Group cohesion or group coordination
through a trusted intermediary none of the participants could
simulate themselves. Discreet mode makes households feel more in
sync; mediated mode resolves what direct conversation can't or
shouldn't. Both lean on the same substrate — per-participant
isolation by `(channel, participant)`, agent-scoped `/memory/`,
prompt-encoded editorial discipline.

**Where it doesn't fit.** When participants want a shared chat —
Cast doesn't have group conversations as a primitive (each
participant has their own conversation, even on the same channel).
For real-time coordination *without* a shared chat — each
participant keeps their own conversation but the agent's sessions
coordinate on shared state as it changes — see the *Live
coordination across participant sessions* variant below. When the
agent's role should be invisible — in mediated mode it isn't,
participants know they're working through it. When parties trust
the agent more than they trust each other and that asymmetry is
itself the problem — the agent becomes a single point of social
failure.

**Variants.**

- *Per-participant private memory + public mediated log.*
  `/memory/users/<participant-id>.md` stays private; only the agent
  reads it. `/memory/shared/<topic>.md` is what every participant's
  bootstrap pulls. The cleanup directive: *"Concerns marked
  private to a participant stay in their `/memory/users/` file.
  Public framing goes in `/memory/shared/`."*
- *Conflict resolution.* Two parties, mediated mode. Agent restates
  each position in fair voice in `/memory/shared/<topic>.md`,
  surfaces convergence and disagreement, proposes wording neither
  would write.
- *Async meeting.* N parties, an evolving meeting document at
  `/memory/shared/meeting-<id>.md`. Each turn's cleanup updates the
  shared view; no scheduled sync needed; participants drop in
  across timezones.
- *Negotiation.* Each party tells the agent their constraints
  privately (cleanup writes to their `/memory/users/<id>.md`); the
  agent surfaces only the *intersection* in
  `/memory/shared/<topic>.md` — discretion + mediation in one
  shape.
- *Tiered surfacing.* Some memory is never shared (private
  `/memory/users/`); some informs the agent's voice without being
  quoted (the cleanup decides what crosses the boundary); some is
  public (`/memory/shared/`). The cleanup prompt teaches the line.
- *Periodic shared-artifact maintenance.* Add a `consolidation`
  channel — single-shot (`idle_timeout: null`), scheduled fire
  from `props/schedule.txt` (e.g. weekly), narrow `disabled_tools`
  (no push, no extension writes). Reads `/memory/shared/`, prunes
  stale topics, consolidates redundant ones. The maintenance loop
  for the canonical artifacts; pairs structurally with
  [Nightly reflection](nightly-reflection.md).
- *Live coordination across participant sessions.* When concurrent
  participants act on shared state (editing the same files, working
  on the same artifact), each `(channel, participant)` session runs
  blind to the others' in-flight work without a coordination
  substrate. Shape: a shared append-only feed at e.g.
  `/memory/activity-feed.jsonl` written via `file__append_feed`,
  watched via `file__watch_feed`; `push_to_participant` reserved for
  actionable interruption. **Posture matters** — feed = routine
  awareness (broadcast, append-only, parseable); push = actionable
  coordination (terse, interrupts, names the verb). Don't push for
  *"I'm working on X"* — that's feed material. Do push for *"you're
  about to touch what I just claimed; want to coordinate?"*
  Detection has two moments worth teaching explicitly: **reactive**
  (watch fires mid-session — source-attribute on receipt with
  `<cast:push fromParticipant>` discipline rather than presenting
  peer text as the agent's own) and **proactive** (pre-edit scan of
  the recent feed window, catches events the agent missed mid-turn).
  Etiquette — who yields when work overlaps — is a per-agent design
  decision the prompt encodes (first-to-claim wins; defer to the
  operator; explicit handoff via push). Watch lifecycle is the same
  shape: the mechanical answer is `file__unwatch` on activity-mode
  shift (editing → idle/chatting drops the watch; new edit ask
  re-registers via `file__watch_feed`). The editorial question is
  what counts as a shift — the prompt encodes the trigger; the
  primitive is there. Pairs with
  [Shared feed as a meeting point](shared-feed-meeting-point.md) at
  the live end of its cadence spectrum.

**Composes.** Per-participant conversation isolation (the
substrate's `(channel, participant)` keying), `/memory/users/<id>.md`
(per-participant private notes), `/memory/shared/<topic>.md`
(mediated canonical artifact), `bootstrap.md` (loads both per-user
and shared files into context on conversation start), `cleanup.md`
(writes back to both based on the editorial directive),
`push_to_participant` (nudges between participants on this agent),
prompt discipline (the editorial move that decides what surfaces
and how).

**Failure modes that define the value.**

- *Over-share* in discreet mode. Quoting one participant to another
  betrays the pattern; once trust breaks here, the recipe is dead.
  The discreet directive must explicitly forbid quotation across
  participant boundaries.
- *Drift* in mediated mode. Different voice or different facts to
  different parties means the canonical artifact stops being
  canonical. The shared file is the single writer; if the agent
  also volunteers framings during conversation that contradict
  what's in `/memory/shared/`, drift opens up. The bootstrap
  reading the shared file is what keeps the agent's per-conversation
  voice anchored.
- *Mode confusion.* The agent has to know which mode each
  conversation is in. Mixing them — quoting in mediated,
  summarizing in discreet — breaks both at once. The mode is a
  property of the *deployment* (what the operator wants this agent
  to be), encoded in the channel's `prompt.md`. Don't make the
  agent infer mode from conversation content.
