# Per-entity workroom

**Use case.** Your agent tracks many parallel threads of the same
kind — a review thread per PR, a research thread per topic, a
client thread per account. Each thread needs its own conversation
continuity: what was said about `pr-1234` last week should be in
context when `pr-1234` comes up again, and never when `pr-5678`
does. One channel configuration, many independent workrooms.

**The shape.** One channel with `use_sharding: true`. Each
sub-conversation is keyed by a qualifier the caller picks at
runtime (`review~pr-1234`, `research~quantum-sensors`,
`accounts~acme`). Same configuration for every shard; isolated
conversation state per qualifier.

- `channels/review/channel.json` — `use_sharding: true`, persistent
  with a modest `idle_timeout`, `lifecycle: "full"`. The timer runs
  per sub-conversation: the shard being worked stays warm while the
  rest stay cold. Sharding earns its place only when there *is*
  per-slice state to carry — a stateless multi-caller channel
  should be single-shot instead
  ([Specialist behind a query-only door](specialist-behind-query.md)).
- `channels/review/prompt.md` — written for one slice at a time.
  The runner only ever sees one qualifier's history; the prompt
  names the per-slice substrate convention below and teaches the
  agent to namespace anything it records by qualifier.
- `channels/review/bootstrap.md` — reads
  `/memory/review/<qualifier>.md` on a shard's first turn.
  Bootstrap and cleanup fire per sub-conversation, so each shard
  restores and persists the right slice without any dispatch logic.
- `channels/review/cleanup.md` — writes the slice's distillation
  back to the same path at that shard's expiry.

The caller side is a prompt-layer contract. A caller agent's
prompt (or this agent's own user-channel `prompt.md`, when the
shards are self-routed via `push_to_channel`) teaches the
qualifier-picking rule: the external ID for entity threads
(`pr-1234`), the topic name for research threads, the caller's own
alias when the receiver should keep per-caller state. Pin the rule
explicitly — `agent__list_peers` shows callers `review~*`, which
says a qualifier is accepted, not which one to pick.

**One nuance worth pinning in the spec.** The conversation cell is
keyed by participant *and* qualifier — two callers using the same
qualifier still hold separate conversations. What they share is the
substrate path: `/memory/review/<qualifier>.md` is read and written
by every caller's shard for that qualifier. Conversation continuity
is per `(caller, slice)`; entity state is per slice, merged in
memory. If the design needs cross-caller continuity, the substrate
file is the canonical view and cleanup is its writer — same
editorial move as the shared log in
[Connecting two or more users](connecting-multiple-users.md).

**The closer.** Shard conversations expire on their own timers, but
the per-slice files accumulate forever — closed PRs, dead topics,
churned accounts. Name the janitor: a scheduled fire into a
single-shot maintenance channel that sweeps `/memory/review/`,
archives slices stale past a threshold, and consolidates what's
worth keeping. Same primitive as
[Nightly reflection](nightly-reflection.md), pointed at the shard
substrate. A workroom design without a janitor is a memory leak
with a nice address scheme.

**Addressing gotchas** (from `../primitives.md` § Sharded channels):
calling the channel bare (`review`, no qualifier) lands in the
null-qualified sub-conversation shared by every caller who omits
one — usually a caller bug, worth a line in the receiver's prompt.
A qualifier against an unsharded channel is a routing error, not a
silent drop.

**What this enables.** Parallel-with-persistence, caller-keyed at
runtime. The alternatives are all worse: serial topics in one
conversation interleave and push each other out of context;
per-topic channels can't be authored at runtime; flat memory dumps
lose conversational continuity. Slots materialize the moment a
caller names one — no blueprint edit when `pr-9000` opens.

**Where it doesn't fit.** Stateless serving (single-shot is
cheaper and cleaner). Slices that are really different *kinds* of
interaction — different lifecycle, tool surface, or audience —
those are separate channels, not shards. Group coordination on one
shared thread (the participant axis already does that —
[Connecting two or more users](connecting-multiple-users.md)).

**Variants.**

- *Per-caller workroom.* Qualifier = the caller's alias. A
  specialist that keeps separate working context per peer agent —
  the stateful counterpart of the query-door specialist.
- *Time-bucketed ledger.* Qualifier = period (`ledger~2026-06`).
  Each bucket's shard accumulates the period's thread, cleanup
  distills it, the janitor archives closed periods.
- *External-entity tracker.* Qualifier = ticket/PR/order ID, often
  fed by an extension subscription landing events into the shard
  via the composite address.

**Composes.** `use_sharding` + qualifier addressing
(`name~qualifier`), per-shard lifecycle (`bootstrap.md` /
`cleanup.md` fire per sub-conversation), `/memory/<channel>/<qualifier>.md`
substrate convention, `agent__list_peers` (`~*` affordance),
scheduled janitor channel.

**Cross-link.** [Specialist behind a query-only door](specialist-behind-query.md)
is the stateless inverse (fresh session per call, no slice state).
[Nightly reflection](nightly-reflection.md) supplies the janitor.
[Connecting two or more users](connecting-multiple-users.md) slices
by participant where this recipe slices by entity.
