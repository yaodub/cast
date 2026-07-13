# Shared feed as a meeting point

**Use case.** Four friends planning a trip together. Each of you talks
to the agent throughout the week — Alice adds Tuesday: *"found a great
Lisbon Airbnb."* Bob adds Wednesday: *"I'm gluten-free."* When you
open it Thursday, the agent already knows. The shared feed is the
meeting point.

The same pattern adapts to other shapes of asynchronous coordination
— a study cohort sharing notes, a hobbyist community logging finds,
a book club tracking discussion points, a household managing
projects. And to *agent-to-agent* coordination: two or more agents
that need to coordinate over time without a synchronous conversation
— one writes, others react when they're next active. The unifying
shape: independent actors (humans through one agent, or agents
peer-to-peer) converge on a shared substrate; the substrate
accumulates state any participant can pick up from later.

**The shape.** A feed (ordered JSONL stream) at a path each agent
knows. A channel appends with `file__append_feed`; another channel
watches with `file__watch_feed`. The watching channel must be
persistent (`idle_timeout` not `null`) — file-watch isn't registered
on single-shot channels because the watch fire needs a session that
survives. Watch is typically established in the channel's
`bootstrap.md` so it's wired on every fresh session. Each watcher
has its own cursor — they see only what's new since their
`lastSeenId`.

Same-agent variant: two channels on one agent agree on a path
under `/memory/`. Producer channel writes; consumer channel
watches; reactions land via `<cast:watch>` fires.

Cross-agent variant: the producer agent writes its own
`/memory/feed.jsonl`; the consumer agent declares a resource slot in
`props/capabilities.json::resources` (RO), the operator binds the
slot to the producer's host path in Configure. The consumer's
channel watches `/resources/<slot-name>` (the path inside the
consumer's container, not the producer's path). See
`../primitives.md` § *The mount table* for the two-phase mechanics
and `../multi-agent-composition.md` for the slot-name convention.

**What this enables.** Coordination without protocol — the feed
itself is the protocol. The cadence spectrum is wide: watchers
receive `<cast:watch>` within seconds of an append (live
coordination of concurrent activity — multiple participants
editing the same artifact, two agents reacting to in-flight peer
work) *and* a watcher that's been offline catches up on next
spawn (async — collaborators who engage days apart). Same
primitive, both ends. Multi-watcher fan-out is free — adding a
third agent watching the feed is one watch registration, no
producer change. The feed is an audit trail by construction.

For the live-coordination case in the multi-user-same-agent
setting (multiple participants editing shared state), pair this
recipe with the *Live coordination across participant sessions*
variant of [Connecting two or more users](connecting-multiple-users.md)
— that variant adds the feed-vs-push posture distinction and
source-attribution discipline the live case demands.

**Where it doesn't fit.** Synchronous interaction where one party
must respond *now* — use push instead. Bidirectional negotiation
that involves more than appending facts (the feed is append-only,
no edits, no deletes from the file format's view). Cases where the
consumer should not know prior history — the feed gives full backfill
access by default.

**Variants.**

- *All-RW shared feed* (every participant appends) vs *producer-RW
  + consumers-RO* (one writer, many readers, structurally enforced
  by mount mode).
- *Single-agent variant.* Two channels on one agent rendezvous on
  a path under `/memory/` — same primitive, no operator wiring
  needed.
- *Operator-as-writer.* The writer doesn't have to be a peer agent.
  An admin tool, a separate process, or the operator working
  through a Configure-side mount can append rows; the agent has the
  path mounted RO and watches it. Useful when you want a human in
  the loop without giving them a chat seat — drop a brief, post a
  note, push a corpus update by file edit instead of conversation.
  Mount-surface invariant means the agent's own `file__append_feed`
  refuses to write to the path; the operator owns the file
  end-to-end.
- *Mount asymmetry beyond feeds.* The same A's-RW = B's-RO
  mechanism that makes the producer/consumer feed work is the
  general pattern for *any* one-way trust between agents — a
  knowledge base maintained by one party and consulted by others,
  a published artifact directory, an event stream. The trust
  direction is enforced at the filesystem layer, not by either
  agent's behavior or by request. Even if B is compromised, the OS
  rejects writes. Multi-fan-out is cheap — adding a third or
  fourth observer is one operator config change.

**Composes.** `file__append_feed`, `file__watch_feed`, mount table
(RO/RW determines who can append), source attribution (`<cast:watch>`
on fire), per-conv-key cursors (each watcher tracks independently).

**Cross-link.** When the watcher should also do editorial work
before forwarding what it sees, pair this with the *Input from a
feed watch* variant of
[Quiet processing channel](quiet-processing-channel.md).
