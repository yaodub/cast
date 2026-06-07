# Design — primitives and the spec discipline

This manual is foundation reading for any Design session about to
author or modify a blueprint. `console/design.md` covers the files
and their lifecycle; this covers what those files *let you do*, and
— load-bearing — the design discipline that uses them. For the
conceptual prior (*what counts as an agent*, *why* the discipline
is scaffolding rather than definition), see
`console/what-is-an-agent.md`. This manual is the *how*; that one
is the *what for*. For the economic dimension — *what each design
choice costs and how it compounds across fires* — see
`economics.md`, the sibling foundation manual.

A Cast agent's design output is a *context-flow spec*: file paths,
channel names, trigger verbs, named end-to-end so every piece of
information the agent will need at runtime arrives via a named
*arrow* — a pathway with a trigger, a verb, and a destination
(`bootstrap.md` reads `/memory/foo.md` on first turn;
`schedule.txt` fires `default` at 09:00; `cleanup.md` writes
`/memory/bar.md` at session end). Information not on a named arrow
is orphaned — physically present on disk, behaviorally invisible
at runtime. Most of authoring a blueprint is naming those arrows.

The vocabulary below is the set of moves a spec is composed of. The
recipes alongside (`recipes/`) are worked compositions — read them
as patterns *and* as what finished specs look like.

Extensions (email, calendar, web-fetch, whatsapp) add concrete
external integrations the agent uses to act on external data and
services; their per-extension manuals at `/ref/manuals/extensions/<name>/`
are the authoritative reference for each. Extensions are distinct
from **transports** (the chat carriers that route inbound messages
from paired users to the agent's channels — server-level,
Configure-bound, no blueprint footprint); see `console/overview.md`
§ *Extensions vs. transports* for the full disambiguation.

## The agent runtime

The agent inside the container is **Claude Code** — same binary,
same tools (`Bash`, `Read`/`Write`/`Edit`, `Glob`, `Grep`, plus
extension MCP tools). Consequences worth pinning:

- **Ad-hoc scripts are free.** The agent writes a Python/Node/shell
  script into `/home/agent/` and `Bash`-runs it. "Let the agent run
  code" needs no custom MCP wrapper — reach for a prompt-driven
  script before reaching for service code.
- **Python via blueprint.** Container has `python3` + `pip`. Extra
  packages declared in
  `blueprint/props/capabilities.json::pip.extra_packages`; install
  at provision time. Locked by default — `operator-values.md`
  § Field authority.
- **Network is Configure's lane.** Default `sdk-only`; extra
  `host:port` in `config/agent.json::containerAllowedEndpoints`.
  Inside the container `127.0.0.1` is its own loopback, not the
  host's — for host-side services, dial `casthost:<port>`. See
  `configure.md` § Reaching a host-side service.
- **Service code lives in `blueprint/service/`** and runs as its
  own host process (MCP server, scheduler, extension subprocess) —
  authored in advanced mode (`/cast-build`).

Advanced-mode test: *does it need a process that is not the agent
itself?*

## The two layers

An agent has two design layers, and authoring choices live in both:

**Shape layer** — what's *available* where. Channels, the tool surface
within each channel, ACL bits per identity per channel, the mount
table. These are gates, not verbs. They decide where the verbs work
and who can reach them.

**Verb layer** — what's *done* within the shape. Push, file-watch,
scheduled fire, query/answer, internal suppression, recall, memory
writes. These are the moves an agent makes once the shape is set.

A correct blueprint can be one that authors verbs without thinking
about the shape. A *good* blueprint shapes the surface so each verb is
available exactly where it serves the design and gated everywhere
else.

### Costs ride with shape

Every shape choice has an economic dimension. Each layer of the
prompt assembly is paid for on every turn; each `disabled_tools`
entry shaves the surface that's loaded; each cross-agent push
spawns a fresh session with full identity layers in the receiver;
each scheduled fire pays cold-start whether or not it produces an
action. The vocabulary below names *what* the primitives do; how
those choices compound across fires lives in `economics.md`. Reach
for it when picking between two designs that work — economy is
usually the tiebreaker.

---

## The shape layer

### Channels — when the agent needs different hats

A channel is a directory under `blueprint/channels/<name>/`. Each
channel is its own configuration surface: idle behavior, lifecycle,
logged or not, tool surface, single-shot or persistent. The same
agent can present radically different surfaces on different channels
— a `processing` channel with no scheduling tools, a `default`
channel with full conversation tools, a `review` channel that only
accepts inbound peer queries.

**Most agents start with just `default`.** The implicit fallback
(30min idle, no lifecycle, logged) is a working user-chat config
without any `channel.json`, and a single-channel agent is a complete
agent. Reach for a second channel when the agent needs to put on a
different hat for a different kind of interaction — a `processing`
channel handling silent background events, a `review` channel
responding to peer queries on a single-shot lifecycle, a
`reflection` channel scheduled to consolidate memory. Agents with
no user-conversational surface (cron-only backends, service-fed
responders) are the deliberate exception, not the starting point.

**Channels carry weight identity-by-alias can't.** Aliases work
as portable role-slots in both identity prose and channel names —
portability alone doesn't decide where role-specific behavior
lives. A channel earns it over an identity directive when the
interaction shape needs more than prose can express: a different
lifecycle (single-shot vs persistent), a tighter tool surface
(`disabled_tools`), cost scoping (the directive only matters on
this interaction kind, not every turn forever), or structural
posture isolation (narrower ACL, disabled tools the LLM can't talk
its way around). Identity-by-alias is fine for cross-cutting peer
awareness and short rules. Reach for a channel when the behavioral
shape changes.

**Why this channel exists — the rationale test.** A new channel
costs authoring effort and adds a surface to maintain. It earns its
place when it differs from existing channels along at least one of
these dimensions, *and* the difference matters for behavior or safety:

1. **Audience / ACL** — different identities or different bit grants
2. **Lifecycle** — single-shot vs. persistent (single-shot disables
   file-watch and is right for stateless processing)
3. **Tool surface** — `disabled_tools` narrowing for blast-radius
   control
4. **Trigger source** — user / peer / schedule / file-watch /
   extension subscription
5. **Substrate boundary** — `log_messages` flag, channel-typed DB
   choice
6. **Sharding** — within-channel qualifier dimension for parallel
   sub-conversations
7. **Participant visibility** — `show_co_participants` flag: whether
   co-participants are visible and reachable to each other on the
   channel

If two candidate channels share all seven, merge them. If one channel
is doing two channels' work — a hostile-input subscription handler
mixed with user chat — split, because the safety posture and verbs
they need differ. The default failure mode is *channel-overload*:
agents that never grow a second channel end up with `default` doing
chat + scheduled fires + extension callbacks + peer pushes, because
the rationale test was skipped.

Composes with: every primitive below — they're all channel-scoped or
channel-conditional in some way.

### Channel-scoped tool surface (`disabled_tools`)

`channel.json: disabled_tools: ["task__*", "conversation__push_to_channel"]`
removes those tool names (or globs) from the agent's available toolset
*on that channel*. The agent has different capabilities depending on
which conversation it's in.

Use this to:

- Carve a single-shot processing channel that can't schedule or push
  elsewhere — bounded blast radius if the input is hostile.
- Make a "responder-only" channel where push is disabled — agents
  on that channel can answer but can't initiate cross-channel work.
- Prevent a notification channel from logging by disabling
  `message_log__*`.

Composes with: per-channel ACL (who can reach the channel), channel
lifecycle (single-shot vs persistent), the verb set (decides which
verbs are even present here).

### Co-participant visibility (`show_co_participants`)

A channel is a cross-participant surface. Its members are the
identities placed on it: a user by pairing, a peer agent by the
answer grant it holds here. Members are the channel's co-participants,
and `show_co_participants` enables or disables whether they see and
reach each other.

`channel.json: show_co_participants: false` isolates the *other people
on this channel* from each other. Default `true`. One flag, two
consequences: it gates whether the agent is aware co-participants
exist, and whether they can reach each other by cross-conversation
push. When off, the `<other-participants>` line in
`<conversation-context>` becomes an explicit disabled marker, the
channel's members are hidden from member-tier
`agent__list_participants` callers (own row plus a population-blind
note, queried from any room), and `conversation__push_to_participant`
from one co-participant to another is refused. The flag does not touch
per-participant conversation keying. Each conversation is separately
keyed regardless, structurally and always (§ *Memory*). What the flag
switches is reach and visibility between participants, not the
isolation of one conversation's transcript.

Use this to:

- Hide callers from each other on a specialist queried by many
  (`recipes/specialist-behind-query.md`).
- Shed the awareness layer on single-shot processing or audit
  channels that don't need it.

Leave it `true` where cross-participant awareness is the point — a
spectrum with *discreet mode* (knows they exist, won't quote;
`recipes/connecting-multiple-users.md`) sitting between full
visibility and this flag's full blindness.

Composes with: per-channel ACL, recall (`list_summaries` honors the
same flag).

### ACL bits per identity × per channel

ACL is seven bits (`ioaqrph`) scoped per peer identity per channel.
**Each bit is directional from *this* agent's perspective**, all
stored in this agent's own `config/acl.json`:

- **Inbound gates** (`i`, `a`, `h`) — what this agent accepts from the
  peer on this channel: regular conversation (`i`), answers to queries
  it sent / queries from the peer (`a`), hosted pushes (`h`).
- **Outbound permits** (`o`, `q`, `r`, `p`) — what this agent is
  allowed to send to the peer on this channel: regular conversation
  (`o`), queries expecting answer (`q`), fire-and-forget requests
  (`r`), pushes (`p`).

For any cross-agent edge, **both sides write their own entry**: the
sender's `acl.json` records its outbound bit, the receiver's records
its inbound bit. A `q`/`a` query edge needs `q` in the sender's file
AND `a` in the receiver's — missing either side silently blocks the
edge. ACL JSON authorship is Configure's lane — see
`/ref/manuals/console/cross-agent-acl.md` for the per-shape mapping.
Your job in Design is to name the shape and channel; Configure writes
the bits.

The same user (or peer agent) can have full access on one channel and
no presence on another. This is structural — a channel that doesn't
grant `i` to a participant simply doesn't exist from that
participant's view.

Use this to:

- Pair different users to different channels — your agent can present
  a different surface to each user.
- Restrict a peer agent to query-only on one channel while granting
  full conversation access on another.
- Build hierarchies: an admin channel grants `ioaq` to one identity;
  everyone else has `i` only on the public channel.

ACL changes happen in Configure, not Design — but the *shape* of the
ACL (which identities need which bits on which channels, and on which
side) is a Design-time decision. Mention what each side needs in your
handoff to Configure; don't leave it implicit.

Composes with: channel design (the unit of access), peer agent wiring
(cross-agent peers need `r`/`p`/`h` bits — see
`multi-agent-composition.md` for the shape choice and
`/ref/manuals/console/cross-agent-acl.md` for the ACL JSON Configure
writes), source attribution (the receiver knows which identity
initiated, so prompts can branch).

### The mount table — what the agent sees of its own filesystem

The agent's filesystem view is a composition: a set of `(path, mode)`
pairs declared by Cast's container-mount config plus any resource
mounts wired up through the two-phase declare-and-provision flow
below. RO mounts are not behavioral promises — they are
filesystem-level enforcement. An agent literally cannot write where
the mount declares RO.

Standard mounts: `/memory` (RW, persistent), `/home/agent` (RW,
runtime CWD), `/staging` (RW, attachment surface), `/identity` (RO,
the blueprint), `/assets` (RO, static data the agent reads at
runtime), `/shared/<ext-name>` (RO, output written by extensions),
`/attachments` (RO, inbound files).

**Substrate is agent-scoped, not channel-scoped.** `/memory/`,
`/home/agent/`, attachments, and the agent.db are shared across
every channel. Channels carve *views* and *write disciplines* over
the shared substrate via path convention: `/memory/digest/runs/<date>.md`
is conventionally written by the `digest` channel's cleanup;
`/memory/reflections/<date>.md` by a `reflection` channel's
scheduled fire. The path is the namespace. Writer and reader
channels agree by path convention — pin the conventions in the spec
or two channels will silently invent inconsistent paths and the
loops drift apart. (Exception: `agent.db::message_log` for user
channels vs. `console.db::message_log` for console channels —
physical isolation enforced by channel type, not per-channel sharding.)

**Resource mounts at `/resources/<name>` come up in two phases.**
Design declares the slot in `blueprint/props/capabilities.json::resources`
(name, `description`, `access: ro|rw`, `required`). The operator binds
a host path in `config/provisions.json::resources`, normally through
the admin form. The slot's `access` is the ceiling — operators can
narrow `rw → ro` when binding, never escalate. Operators cannot invent
slots Design didn't declare.

Use this to:

- Read a corpus the operator drops in (RO).
- Watch a feed written by `file__append_feed` (the in-agent
  inter-conversation pattern — one channel appends, another watches),
  or by an external producer (an extension, an agent service, an
  operator script).

Mount RW/RO is also what `file__append_feed` enforces at the tool
boundary — the host process could write anywhere physically, but the
tool layer respects the container's declared mode.

`required: true` is advisory at runtime. An unbound required slot
doesn't crash the agent — the container-runner warns and skips, the
slot is omitted from the prompt's directory layout, and the agent
spawns. Configure surfaces the gap (validate, dynamic snapshot, admin
banner) until the operator binds a path. So Design can add a required
slot without bricking a live agent; the operator can't miss the gap.

Composes with: file watches (RO can be watched, RW can be appended
to), agent-to-agent topology (the mount graph is part of the trust
shape — see `multi-agent-composition.md` for slot-name alignment),
operator-driven configuration (your handoff to Configure should name
the slot and what to bind there).

The author-vs-operator ceiling that mount `access: ro|rw` enforces at
the filesystem layer has a sibling at the capability-field layer:
specific fields in `props/capabilities.json` are **locked by default**,
opt-in to operator override via a `{ unlocked: true, value: ... }`
wrapper. Decision framework: `operator-values.md` § Field authority.

### Channel lifecycle — idle, single-shot, bootstrap/cleanup

A conversation is the short-term workspace; `/memory/` is the
persistence layer between conversations (§ *Memory*).
`bootstrap.md` reads memory on first turn; `cleanup.md` writes
memory at close. Memory ops aren't limited to these hooks — see
§ *Memory* for mid-conversation reads/writes.

`idle_timeout` fires cleanup on silence. Required in every
`channel.json`. Positive integer (milliseconds) for persistent, or
`null` for single-shot. Max `2_147_483_647` (~24.86 days, Node's
`setTimeout` ceiling). Unknown keys are rejected — a typo like
`ttl:` fails validation rather than silently turning single-shot.

**Pick the shortest timer that serves the expected reply cadence.**
Anchor points:

- **`1800000` (30min)** — user-conversational continuity window.
  Matches the framework's implicit fallback. Default for user-facing
  channels (see § *Channels — when the agent needs different hats*).
- **Longer** (e.g. `86400000` for 24h) — daily-rhythm agents. Pair
  with lifecycle hooks so cleanup actually fires; a long timer alone
  holds the slot warm but doesn't propagate state.
- **Modest persistent** (a few minutes) — peer-to-peer in active
  back-and-forth (research agent expecting follow-ups, dispatcher
  waiting on a worker).
- **`null` (single-shot)** — fresh session per fire, no resumption;
  file-watch tools aren't registered. Pick *deliberately* when
  per-call isolation is the design — hostile-input handlers, audit
  edges, `q`/`a` edges where each call should be independent of
  prior callers. Cadence decides the timer; isolation is a separate
  question.

Lifecycle hooks (`lifecycle: "bootstrap-only"`, `"cleanup-only"`, or
`"full"`) fire at start and end on both persistent and single-shot
channels — on persistent at idle expiry, on single-shot as a piped
`<cast:lifecycle>` turn right after the reply (bootstrap runs in
topology-only mode there, no prior session to re-immerse from).
Single-shot caveat: `conversation__write_summary` is a no-op
(single-shot conversations don't persist to the state store), so
distillations land in `/memory/` directly.

The timer and hooks are orthogonal axes. `idle_timeout` decides
*when* the boundary fires; lifecycle decides *what crosses it*.
Persistent + `lifecycle: "none"` holds the slot warm but cold-starts
every new session. Single-shot + `lifecycle: "cleanup-only"`
distills each fire before exiting. Pick the timer for cadence; pick
the hooks for what crosses.

Composes with: memory (the persistence layer cleanup writes to and
bootstrap reads from — see § *Memory*), summaries (cleanup produces,
framework auto-injects on next conv-key open), the verb surface
(single-shot disables file-watch and persistent scheduling).

### Sharded channels — one channel, many sub-conversations

`use_sharding: true` on a channel turns it into a host for many
independent sub-conversations within the same channel configuration.
Each sub-conversation is keyed by a **qualifier** — an opaque
string carried in the routing metadata. Same `prompt.md`,
`bootstrap.md`, `disabled_tools`, etc. for every shard; isolated
conversation state per qualifier.

**The capability is parallel-with-persistence, caller-keyed at
runtime.** Without sharding, the alternatives are all worse: serial
topics in one conversation interleave and push each other out of
context; per-topic channels can't be authored at runtime; flat
memory dumps lose per-topic conversation continuity. Sharding gives
the third option none of those provide — caller-keyed slots that
materialize at runtime, persist independently, inherit one
configuration. Per-slice substrate convention
(`/memory/<channel>/<qualifier>.md`) emerges naturally because
`bootstrap.md` and `cleanup.md` fire per sub-conversation. Reach
for sharding when the work shape is parallel-with-persistence and
the slice key is what the caller picks at runtime (web-research
topics, per-PR review threads, per-user assistant slots).

**When to reach for it.** Default to single-shot when the channel
serves multiple callers but the receiver has no per-caller state to
maintain — each fire is stateless and fresh. Reach for sharding when
the receiver does want to carry conversation state across calls *but
separately per slice*: per caller, per topic, per time bucket, per
external entity (PR number, ticket ID, …). The qualifier names the
slice. Sharding is not a way to multiplex unrelated logical
channels — make those separate channels.

**How a caller addresses a shard.** The composite form is
`name~qualifier` (mirrors the address grammar). It works in:
- `conversation__push_to_channel` / `push_to_participant` — the
  `channel` arg
- `<cast:query channel="name~qualifier">` — the channel attribute

`agent__list_peers` renders sharded peer channels as `name~*` so the
caller's prompt can tell at a glance that a channel accepts a
qualifier. Substitute your own qualifier in place of `*`.

**Character set.** Qualifier shape matches the channel-name shape:
`^[a-z][a-z0-9-]*$` — lowercase letter start, then lowercase
letters, digits, or hyphens. The qualifier cannot contain `~` (the
composite form has exactly one `~`).

**What to put in a caller's prompt.** When authoring a runtime agent
that's going to query a sharded peer, teach the qualifier-picking
rule in the prompt: pick whatever names the slice that matters
*to the receiver's state model*. Common choices: the caller's own
alias (for per-caller state on the receiver), the participant
identity (when a single agent serves many users), a topic name
(`daily`, `weekly`, `release-notes`), a time bucket
(`2026-05`), an external ID (`pr-1234`). Document the choice in the
caller's prompt so the rule is explicit, not implicit — same as you
would for which agent to ask in `peers.md`.

**What to put in a receiver's prompt.** When authoring the sharded
channel's `prompt.md`, write it for *one slice at a time*. The
runner only sees the qualifier's conversation history; memory and
files are still per-agent, so a receiver that wants to record
qualifier-specific notes should namespace by qualifier
(`/memory/reviews/<qualifier>.md`). `bootstrap.md` and `cleanup.md`
fire per sub-conversation, so they can read/write the right slot
without manual dispatch.

**Missing qualifier.** Calling a sharded channel as `name` (no
qualifier) lands the message in the **null-qualified
sub-conversation** — distinct from any qualified sub-conversation,
shared by every caller that omits the qualifier. Typically a sign
the caller meant to address a specific shard and didn't.

**Qualifier on an unsharded channel.** Throws — `name~qualifier`
against a channel without `use_sharding: true` is a routing error,
not a silent drop.

Composes with: memory (per-shard files), summaries (per-shard,
because the conversation key is per-shard), the verb surface
(`conversation__push_to_channel` accepts the composite form), and
`agent__list_peers` discovery (sharded peers render with `~*`).

---

## The verb layer

Every conversation is a **cell** keyed by `(agent, participant, channel)`
(plus a shard qualifier). A trigger lands in exactly one cell and sets its
participant: an inbound message → the sender's cell; a `schedule.txt` fire
→ the agent's *own* cell (participant is the agent itself); a
`task__schedule` → the cell of the participant the task was bound to. The
verbs below are how an agent *crosses* from the cell it's in to another —
one verb per axis. Any cross-conversation move — a nudge, a hand-off,
surfacing, fan-out, initiating with someone who hasn't written — is a cell
move; reach for the verb that crosses the axis you mean, and mind that a
cron fire starts in the agent's own cell, not a user's.

### Push — `conversation__push_to_channel` / `conversation__push_to_participant`

The routing verbs. Three distinct moves on three different addressing
axes:

- **`push_to_channel` without `target_agent`** — *same participant,
  different channel on this agent.* Self-routing across the agent's
  own channels.
- **`push_to_channel` with `target_agent`** — *same participant, peer
  agent's channel.* Cross-agent push along the user's pairing edge;
  the receiver opens or resumes a conversation with that participant.
- **`push_to_participant`** (intra-agent only) — *different
  participant on this agent.* Directed messaging between participants
  who share this agent. Use cases include: nudging a participant with
  a thread waiting (*"Bob, Alice asked for your read"*); handing
  attention between participants; surfacing privately to one
  participant; initiating with a participant who hasn't started;
  live coordination between concurrent sessions on the same channel.
  Not for routine awareness — that's substrate (`/memory/`, feeds);
  push is for *actionable* messages that interrupt.

Cross-agent + cross-participant in one step is deliberately not
exposed. To reach Bob on agent B from Alice on agent A, agent A
queries agent B; agent B independently decides to push to Bob if its
prompt says so. This forces the receiver to authorize the participant
move under its own ACL, not the sender's.

Composes with: ACL (cross-agent push needs `p` on sender +
`h` + `i` on receiver), source attribution (the receiver sees
`<cast:push>` with `fromAgent` / `fromParticipant` / `fromChannel`
attrs and can branch), `<cast:internal>` (silent push),
channel-scoped tool gating (you can disable push on a channel that
should be receive-only).

Pushes are fire-and-forget — the tool returns success the moment the
bus accepts the dispatch — but they carry a correlation `id` in the
result text. If the receiver later denies the push (ACL revoked
between dispatch and gate, draft mode, originating user lacking `i`),
a `<cast:rejection request="<id>">reason</cast:rejection>` arrives on
a subsequent turn so the agent can recognize the failure instead of
proceeding as though the push landed. The receiver-side ACL check is
authoritative; sender-side gating only catches sync errors (unknown
participant, no `p` bit).

### File feed — `file__watch_feed` / `file__append_feed`

A *feed* is an ordered, append-only JSONL stream that peers observe
via `file__watch_feed`. `file__append_feed(path, data, meta?)`
appends a row; the framework assigns a monotonic `id` so watchers
can cursor through rows. `file__watch_feed(path)` registers a watch;
the agent receives `<cast:watch path since through>` with the new
rows when the feed grows. `file__unwatch(path)` drops a registered
watch mid-conversation — coordination noise can be turned off when
the user's activity mode shifts (editing → idle/chatting), without
ending the conversation. `file__list_watches` returns currently
registered entries.
Cursor is per conv-key, so two watchers see only their own progress
past their own `lastSeenId`. Mount-mode aware: `file__append_feed`
requires RW; `file__watch_feed` accepts RO. Single-shot channels
get `file__append_feed` — an append is a fire-and-forget write with
no dependency on a future turn — but not the watch tools
(`file__watch_feed`, `file__unwatch`, `file__list_watches`), whose
fires arrive on later turns a single-shot session never has.
Per-channel cap on concurrent watches:
3 by default (`fileWatch.maxWatchesPerChannel`, operator-tunable).
Hitting the cap returns an error; use `file__list_watches` +
`file__unwatch` to free a slot, or re-register a path to refresh
the cursor.

The watch is **event-driven, not polling.** The framework fires
`<cast:watch>` to the agent as soon as the feed grows; coordination
latency between two concurrent watchers is bounded by per-conversation
turn cadence, not by any periodic check. This is the primitive for
live coordination between concurrent conversations on the same agent
(or across agents via shared mounts) — not just async accumulation.

Feeds are a coordination primitive, *not* a journal/audit format —
they enforce a strict `{id, data, meta?}` envelope that rejects plain
JSONL. For agent-private journals (replay, retrospect, diary), use the
SDK's Edit/Write tool to append plain rows directly.

Primary use: intra-agent inter-conversation coordination — two
conversations on the same agent collaborating live (editor and
author on a shared draft). Path rendezvous is a prompt-layer
concern; channel prompts name the path on both sides.

**Watch a change feed, not the artifact.** Watching the document
directly fires on every keystroke. Maintain a change feed alongside
(appended by the agent at meaningful moments, or mechanically by
an agent service or external script) and watch that.

Composes with: mount table (RW-only append; RO is watch-eligible),
source attribution (a fire arrives as `<cast:watch>` the agent
recognizes as machine stimulus), `<cast:internal>` (a watcher's
reaction can be silent).

### Deferred self-action — `task__schedule`

The agent gives its future self a task at a future time. Cron or
once. Each fire spawns a fresh session with the prompt as the input.
Persistent across container restarts. Cancel/pause/resume from inside
the agent.

Distinct from `props/schedule.txt` (operator-declarative cron,
parsed at startup, hot-reloaded on file change, agent cannot
modify). `schedule.txt` is for cadences the author fixes;
`task__schedule` is for cadences the agent or user decides at
runtime. When the cadence is user-negotiated, the prompt instructs
`task__schedule` and `schedule.txt` is intentionally absent — both
are complete designs.

Compose pattern: a task that, on completion, writes its outcome to
`/memory/run-log.jsonl` and reschedules itself with refined
parameters. The agent learns from each run without retraining.

Composes with: memory (persistent learning across fires),
`<cast:internal>` (silent fires), source attribution (fires arrive as
`<cast:schedule>`), recall (the new session can search past runs).

### Outbound semantic tags

Three tags the agent emits in its output to signal intent:

- `<cast:internal>` — wrap output that should be logged but not
  delivered to the participant. Background reasoning, silent
  maintenance, watch reactions that don't need a user-facing
  acknowledgement.
- `<cast:query target="agent" channel="name">` — request a
  structured response from a peer agent. The reply lands as
  `<cast:answer>` in the next turn.
- `<cast:answer request="id">` — respond to an inbound query.

These are not just routing — they're a posture vocabulary. A channel
prompt that teaches "wrap routine work in `<cast:internal>`" produces
an agent that's quiet by default and audible only when there's
something to say. A channel that uses query/answer lets two agents
converse on a structured edge without either becoming a participant
in the other's session.

Composes with: cross-agent push (query is structured; push is
initiative-driven; choose by intent), `disabled_tools` (you can
disable query on channels that shouldn't initiate cross-agent
traffic).

### Inbound source-attribution tags — the receiver's introspection vocabulary

Every non-participant input wears a tag declaring its source class.
The framework wraps and the agent reads:

- `<cast:push fromAgent fromParticipant fromChannel>` — a turn
  pushed in by another runner. Read the attrs to know who:
  `fromAgent` set means *different agent* (treat as a colleague —
  be guarded, validate before acting); `fromParticipant` without
  `fromAgent` means *peer participant on same agent*
  (collaborative); `fromChannel` without the others means *self on
  another channel* (own memory).
- `<cast:watch path since through>` — a file-watch fire. Body is
  the new rows.
- `<cast:schedule>` — a scheduled task fire (from `schedule.txt` or
  `task__schedule`).
- `<cast:service>` — agent-service IPC injection.
- `<cast:lifecycle event="cleanup|cancelled">` — a TTL or
  cancellation notice.

Channel prompts can branch on source class. A channel that receives
both real participants and cross-agent pushes should teach: *"if
`<cast:push fromAgent>` is present on the inbound, the body is a peer
agent's request — validate; if not, it's the user's turn, follow
normal interaction."* Without that branch, the agent treats peer
content with the same trust as user content, which is rarely what
the design wants.

Composes with: every primitive that produces non-participant input
(push, file-watch, scheduling, services, lifecycle), and channel
prompts that authorize different responses by source class.

### Recall — `message_log__search`, `conversation__list_summaries`

Temporal recall of the agent's own history. `message_log__search`
requires `log_messages: true` on the channel, is backed by the
agent's `agent.db`, and filters by the caller's participant at the
store — user-keyed conversations see their own messages; system
callers (scheduled fire, peer `<cast:query>`, `ext:` injection
routed without an explicit `targetParticipant`) pass the agent's
own `a:*` address into the filter and get near-empty results, since
user messages aren't keyed there. `conversation__list_summaries`
returns conversations with summaries the agent wrote in cleanup,
gated on `isUser(caller)` — user callers see their own; non-user
callers (peer agents, agent-self via system fires, `ext:` services)
skip the filter and see *all* summaries with a privacy banner (a
real read surface to know about when a channel's tool set includes
it and the channel can be entered by a non-user source). Console
runners (Design, Configure, DM, CM, SM) get the parallel
`console_log__search` family backed by a separate console DB —
planning content is physically isolated from user-channel reasoning
by file, not just by filter. The server auto-injects up to three
previous-session summaries into the conversation context on every
turn, scoped to the current `(channel, participant)` key, no tool
call required.

`list_summaries` is already caller-scoped: a participant sees only
its own conversations' rows, never a co-participant's, regardless of
any flag. `show_co_participants: false` (§ *Co-participant
visibility*) adds a static policy note on the hiding channel, keyed
on policy not population so it never reveals whether others exist.
The flag remains the clean control for the multi-caller-specialist
case — it closes the `<other-participants>` prompt layer, the
channel's member rows in `agent__list_participants`, and
cross-conversation push; disabling a tool via `disabled_tools` only
closes that tool, leaving the prompt layer still naming
co-participants.

When a channel wants information from earlier conversations on
*other* channels — common in scheduled maintenance fires — neither
recall verb fits cleanly. One composition that does: earlier
conversations write distillations to known substrate paths during
their `cleanup.md`; the maintenance fire reads those paths.
Recognition happens in-context with the original conversation
(cheapest moment); the maintenance side has full control over what
it reads. One shape among others — pick what fits.

Composes with: bootstrap (recall on conversation start to restore
mental model), per-channel logging (`log_messages: false` to opt a
channel out), cleanup writes to substrate (the path becomes the
rendezvous when the recall verbs don't fit the channel's source).

### Memory — the agent's persistence layer

`/memory/` is RW from inside the container, persistent across
conversations, agent-curated. Framework neither writes nor reads it.
Propagates state along two axes:

- **Temporal** — same `(channel, participant)` across conversation
  boundaries.
- **Cross-participant / cross-channel** — different participants or
  different channels on the same agent. Each `(channel, participant)`
  is its own session and can't reach another's history directly;
  `/memory/` is the only path between them.

Two patterns:

- **Checkpoint (scheduled).** `cleanup.md` writes; next session's
  `bootstrap.md` reads. The bulk of distillation lives here.
- **Opportunistic (mid-conversation).** `Read /memory/<file>` when
  the agent recognizes a gap; `Write` when something shouldn't wait
  for cleanup. Triggers: (a) abnormal close would lose it (hard
  preference, filter rule, stated intent), (b) cross-participant
  propagation needs to be timely (A's write is visible to B on B's
  next turn, not B's next conversation), (c) the value lands at a
  known moment (deferred-follow-up writes the decision at
  intent-time).

Composes with: lifecycle (the checkpoint pattern). Distinct from
§ *File watch* (live coordination between concurrent conversations —
different primitive).

---

## How the layers compose — the spec discipline

The shape layer decides which verbs are reachable where, by whom;
the verb layer is the moves the agent makes within that reach.
Composing them well isn't a stylistic preference — it's the
discipline that turns vocabulary into a working agent. The discipline
has a name and a test.

### The artifact — a context-flow spec

The framework's prompt assembly fires a fixed set of layers at
turn-start (Cast protocol → profile prompt → profile skills →
identity files (`prompt.md` / `whoami.md` / `peers.md` / `skills.md`) →
channel `prompt.md` → service-injected `agent-context.md` →
server-built `<conversation-context>` carrying up to three
previous-session summaries). On a new conversation's first turn, the
channel's `bootstrap.md` runs as a one-shot query and its output is
injected as `<bootstrap-context>`.
After that, the only new context entering the agent's head is what
the agent itself reaches for via tools (`Read /memory/...`,
`message_log__search`, `conversation__list_summaries`). Information
on disk that no layer carries and no tool retrieves is *orphaned* —
it exists, but the agent cannot act on it.

A design output is a context-flow spec: every joint named, with file
paths, channel names, and trigger verbs. *"The agent will know about
its calendar"* is a wish; *"`channels/scheduler/bootstrap.md` reads
`/memory/calendar/index.md` on first turn; subsequent turns pull
specific events via `Read /memory/calendar/<date>.md`; cleanup writes
new commitments back"* is a spec. Same intent, different rigor; only
the spec survives contact with disk.

The unit of the spec is the arrow, not the artifact at either end.
An artifact can be filled by the author, stubbed for the agent to
overwrite, absent for an extension to create, declared as a slot
for the operator to bind, or implicit in a prompt instruction that
fires a tool call. State varies; named-ness doesn't. Design is
complete when every arrow is named, regardless of which artifacts
have materialized.

### Rigor at the joints, freedom inside the nodes

Specs are precise *where one component hands off to another* and
silent *inside* each component. Pinned: paths, channel names,
trigger verbs, schema sketches at the boundaries. Free: how the
channel `prompt.md` is worded, how the agent reasons about what it
loaded, how the cleanup phrases its summary. The contract at the
boundaries is checkable; the implementation inside each component
is the agent's craft. (Same shape as a jazz lead sheet — chord
changes pinned, solos invented every time. Or an API contract —
request and response shapes pinned, implementation free.)

### The test — is this design done?

A channel's behavior is fully specified when the following set,
read together, lets you list every file the channel touches at
runtime, every recall verb it expects to fire, and the cadence of
any maintenance — without guessing:

- `channels/<name>/channel.json` — lifecycle, tools, sharding,
  logging
- `channels/<name>/{prompt,bootstrap,cleanup}.md` — handler logic
- `identity/{prompt,whoami,peers,skills}.md` — agent-wide layers
  this channel inherits
- `props/capabilities.json` — agent-wide `disabled_tools`,
  extensions, resource slot declarations
- For peer-facing channels: the *caller's* `peers.md` and
  `acl.json` too — both sides must agree on the channel name and
  ACL bits, or the edge silently breaks
- The intended ACL grants for `config/acl.json` (Configure writes
  the file; Design specifies the shape)

If you can read those and answer *"what arrow fires on what
trigger?"* with paths, verbs, and prompt instructions, the joints
are named. If the answer is *"the agent will reach for memory"* or
*"the prompt teaches it to look,"* something is unnamed — and at
runtime the agent will improvise the joint, silently and wrongly.

This test is about whether the joints you *are* building are named — not
about how much to build now. Deferring scope to a later iteration is a
legitimate choice (`/ref/manuals/console/design.md` § Reading the
operator); the joints in the thin version still have to pass this test.

### Stratification — agent-wide vs channel-specific directives

The channel `prompt.md` is the only channel-specific static prompt;
`identity/{prompt,whoami,peers,skills}.md` are agent-wide and
inherited by every channel. The discipline respects the
stratification:

- **Agent-wide.** Directives true on every channel: *"Always
  summarize before closing,"* *"never write outside `/memory/`,"*
  *"to ask the research-agent for facts, query its `lookup`
  channel."* Any directive whose applicability does not depend on
  which entry point is in play.
- **Channel-specific.** Directives whose applicability *depends on*
  the entry point. *"Wrap turns in `<cast:internal>` unless
  something genuinely warrants the user"* only makes sense in a
  quiet processing channel. *"On the first turn, load the previous
  run's summary"* belongs in `bootstrap.md`.

A directive in the wrong stratum is its own failure mode: agent-level
prompts polluted with channel-specific pulls bloat every conversation;
channel-level prompts duplicating an agent-wide rule drift over time
as one copy is updated and others aren't. The applicability test:
*"would this be true on every channel this agent has?"* — if yes,
agent layer; if no, channel layer.

### Looking is part of answering — at design time

The retrieval rigor has two faces. Runtime: an agent's *"I don't
know"* must be the conclusion of a retrieval attempt against named
substrate, not a substitute for one (see `console/overview.md` §
*Ground every load-bearing claim*). Design-time: information you
didn't put on a named arrow won't be retrieved. *"The agent will
know about preferences"* is the design-time form of the same
orphaning failure — the spec must name *which file the preferences
live in* and *which channel's `prompt.md` or `bootstrap.md`
references it*. If the design doesn't pin the path from substrate
to context, the data exists but is invisible at runtime.

### Test the draft

After drafting a channel's spec, ask:

- **Tool reach.** Are scheduling tools available on a channel that
  should be stateless? File-watch tools on a single-shot channel
  (they won't be — does the prompt assume otherwise)? Push tools
  on a channel that should be receive-only?
- **Identity reach.** Can each user reach the channels they need?
  Are peer agents granted only the channels they should query, with
  only the bits they should hold (and is the matching bit on the
  caller's side specified too)?
- **Mount reach.** Are the resource slots the agent expects declared
  in `capabilities.json` with `required: true` on the load-bearing
  ones, and does the handoff to Configure name what to bind?
- **Source posture.** Does each channel that can receive
  non-participant input teach the agent how to read the source
  class (`<cast:push>`, `<cast:watch>`, `<cast:schedule>`, …)?
- **Visibility posture.** On multi-caller or multi-user channels, is
  `show_co_participants` set deliberately — `true` where
  cross-participant awareness serves the work, `false` where callers
  shouldn't learn about each other? The default is `true`; confirm
  it's intended, not inherited.
- **Joint coverage.** For every behavior the channel performs at
  runtime, is there a named arrow from substrate → context that
  carries the information the behavior depends on?

If those have clean answers per channel, the spec is doing its job.

## Designing for runtime adaptation

The spec discipline names every joint at authoring time. It does
*not* fix every behavior. A blueprint that pins all behavior up
front is one you'll keep returning to edit; the complementary
design-time question is which behaviors to leave evolvable at
runtime, within the substrate the spec defines.

Two shapes this takes, calibrated to the agent's job:

- **Memory accumulation → consolidation.** When the agent builds
  up substantial substrate over time (long-running memory, growing
  run-logs, accumulating decisions), uncurated growth becomes
  noise. The structure that worked at 100 entries is wrong at 1000.
  Specify a consolidation loop — typically a scheduled fire into a
  single-shot `reflection` channel that compresses, refactors,
  and surfaces patterns. See `recipes/nightly-reflection.md`.
- **Varied queries → behavioral adjustment.** When the agent
  fields a wide space of asks from users or peer agents, the right
  behavior is rarely fully knowable at authoring time. Specify a
  substrate where feedback lands and is read on subsequent fires —
  user pushback writes filter rules the next fire reads;
  calibration records compare expected vs. actual; self-tuning
  cadences refine themselves from run logs. See
  `recipes/nightly-reflection.md` § Variants (self-tuning) and
  `recipes/deferred-follow-up.md` § Variants (calibration-driven).

Simple agents — one-shot transforms, narrow peer responders,
fixed-scope handlers — need neither. Forcing reflection or
adaptive loops onto them adds maintenance burden without payoff.
The discipline is *consider*, not *include*: ask whether this
agent will benefit from improving at its task between now and the
next time you revisit it. If not, design as fixed and accept that
the cost of behavior changes lands with you.

## Further reading

- `recipes/README.md` — worked compositions that combine these
  primitives into shapes none produces alone, and exemplars of the
  spec discipline above (every loader names its file, every channel
  its lifecycle, every loop its closer). Read a few early; carry
  the moves forward.
- `multi-agent-composition.md` — channel-name alignment, the three
  edge shapes (q/a, r/a, p/h), and the handoff to Configure for
  ACL grant authorship.
- `/ref/manuals/console/cross-agent-acl.md` — Configure's manual for
  ACL JSON (bit glossary, directional rule, worked examples). Read
  it if you need to understand what Configure will write; do not
  author ACL grants yourself.
- `service-and-schedule.md` — service code, `schedule.txt` syntax,
  build pipeline.
- `/ref/manuals/extensions/<name>/` — per-extension tools, config,
  and behavioral skill.
