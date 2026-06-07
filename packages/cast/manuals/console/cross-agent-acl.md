# Cross-agent ACL — Configure's authoring reference

Cross-agent edges are composed by Design (channel names, blueprint
files, shape choice) and **authorized by Configure**. Composition
declares what an edge would be; the ACL grants in `config/acl.json`
authorize traffic to actually flow. Without the grants, the edge is
inert.

This manual is Configure's authoring reference for the ACL bits. It
does not cover composition — see
`/ref/manuals/console/design/multi-agent-composition.md` for the
blueprint side.

`show_co_participants` is a separate `channel.json` flag, Design's to
set. It enables or disables whether the members placed on a channel
see and reach each other, and it neither authorizes nor blocks a
cross-agent edge. The `a` and `i` grants decide who is a member of the
channel. The flag decides whether those members are open to one
another. (See `primitives.md` § Co-participant visibility.)

**Who reads this.**

- **Per-agent Configure** — when the operator (or a Design completion
  brief) asks for an ACL grant on this agent.
- **All-Agents Configure (CM)** — when authoring grants across two
  agents in a cross-agent wire-up, with no upstream Design brief.

**Who does NOT read this.** Per-agent Design and All-Agents Design
(DM) do not author ACL grants. They name the shape and channel in
their handoff to Configure; Configure writes the JSON.

## Bit glossary

| Bit | Direction (this agent's view) | Meaning |
|---|---|---|
| `q` | outbound | Query: I ask, the reply enters my next-turn context |
| `r` | outbound | Request: I ask, my gate drops the reply before it enters context |
| `p` | outbound | Push: I hand my originating user over to another agent |
| `a` | inbound | Answer: I receive `q` or `r` queries and emit `<cast:answer>`, and the peer becomes a member of the channel (a co-participant). |
| `h` | inbound | Host: I accept `p` pushes (host the handed-over user) |
| `i` | inbound | User → me. Set by the pairing flow; hand-touched only to consolidate with an `h` handoff grant (§ The p/h merge gotcha). |
| `o` | outbound | Me → user. Set by the pairing flow, never hand-written. |

Bits are *this agent's* view. They never match across the two ends
of an edge: each side records ITS bit, not the peer's.

**Membership lives in the inbound bits.** `a` (a peer agent) and `i`
(a user) place that identity on the channel as a co-participant,
present in the room. The outbound bits (`q`, `r`, `p`, `o`) are
capabilities and place no one. So an `a` grant is not only the right
to answer: on that channel the peer is reachable and visible to the
other members, gated by `show_co_participants`. The query edge is
asymmetric in this respect: the sender's `q` confers no membership,
the receiver's `a` does. (See `primitives.md` § Co-participant
visibility for the room model.)

**Membership confers discovery — exactly as much as it confers
reach.** A placed member (`a` or `i`) can enumerate its own rooms and
their members at runtime (`agent__list_channels`,
`agent__list_participants`); an identity with no placement on a
channel gets a denial that reveals nothing about that channel's
population or existence. `show_co_participants: false` hides a room's
members from member-tier callers, queried from any room. Discovery
reads the same grants as the push gate, so what a cell can list is
exactly what it can reach.

**Who the peer key is.** For `q`/`r`/`a` the peer key is the **other
agent** (its alias or canonical address). For `p`/`h` it is the
**originating user** (`u:<id>`), not the peer agent. A person handoff
is authorized by that user's own grants, and the two agents are pure
conduits that hold no bits for it. The p/h row below and the worked
example make this concrete.

## The directional rule

For every cross-agent edge, **two entries are written, one in each
agent's `acl.json`**:

|  | Sender's `acl.json` | Receiver's `acl.json` |
|---|---|---|
| **q/a** query | `peers.<receiver>.<channel> = "q"` | `peers.<sender>.<channel> = "a"` |
| **r/a** request | `peers.<receiver>.<channel> = "r"` | `peers.<sender>.<channel> = "a"` |
| **p/h** push | `peers.<u:user>.<channel> = "p"` | `peers.<u:user>.<channel> = "h"` |

The framework gates both sides. Missing either entry blocks the edge
silently: no error, just delivery failure.

**q/r/a key on the peer agent; p/h key on the originating user.** A
push is a person handoff, so both halves are written on that user's
`u:<id>` key, not on the other agent, and the sending agent holds
nothing for the handoff. The receiver also requires the user to be a
member of the channel (the `i` bit, set by pairing) before it will
host them, so in practice the receiver entry consolidates to `"ih"`.
See § The p/h merge gotcha.

## JSON structure

`config/acl.json::peers` is a nested map: peer-identifier → channel
→ bits.

```json
"peers": {
  "<peer-identifier>": {
    "<channel-name>": "<bits>"
  }
}
```

**Peer identifier (outer key)** — who this grant applies to:

| Form | Example | When |
|---|---|---|
| Alias (preferred for agents) | `field-agent` | Other agent. Matches the peer's `manifest.name`. Resolved at lookup time, survives key rotation. |
| Canonical agent address | `a:<guid>@<issuer>` | Other agent, exact-match. Both parts required — `@<issuer>` is not optional. |
| Canonical user address | `u:<guid>@<issuer>` | Human peer. Usually written by the pairing flow into `state/paired-users.json`. Hand-authored here only to confer `p` or `h` for a cross-agent handoff (see § The p/h merge gotcha). |
| Any-agent glob | `a:*` | Bulk grant covering every agent identity. Falls in if no exact match. |

`u:*` is rejected at schema parse — users must pair explicitly.

A bare type-prefix without `@<issuer>` (e.g. just `a:<guid>`) is
neither an alias nor a canonical address. It silently fails to
resolve. Use the alias or the full canonical form.

**Channel name (inner key)** — the channel on the **receiving**
agent. Both sides of an edge use this same name, because the bits
authorize the same channel — the one on the receiver.

**Bits (value)** — this agent's permissions toward that peer on
that channel. See the glossary above. Each side records ITS bit.

The agent's own identifier does not appear as a peer. Owner access
short-circuits to full bits before the peers map is consulted.

**The `owner` field widens writes only.** It defaults to
`"operator"`, an inert label that matches no identity. Setting it to
a real `u:<id>` gives that user unconditional push reach into any of
the agent's conversations — but reads stay member-scoped: enumeration
(`agent__list_channels`, `agent__list_participants`) and
cross-participant summaries are reserved for the agent itself and the
operator surfaces. A configured owner who should also *see* a room's
members must be placed there like anyone else.

## Worked examples

### q/a — `reviewer → field-agent` on `review`

```json
// reviewer/config/acl.json
{
  "owner": "operator",
  "peers": {
    "field-agent": { "review": "q" }
  }
}

// field-agent/config/acl.json
{
  "owner": "operator",
  "peers": {
    "reviewer": { "review": "a" }
  }
}
```

Tags: `<cast:query target="field-agent" channel="review">` /
`<cast:answer request="...">`. The answer enters the reviewer's
next-turn context.

### r/a — `dispatcher → worker` on `dispatch`

```json
// dispatcher/config/acl.json
{
  "owner": "operator",
  "peers": {
    "worker": { "dispatch": "r" }
  }
}

// worker/config/acl.json
{
  "owner": "operator",
  "peers": {
    "dispatcher": { "dispatch": "a" }
  }
}
```

Sender emits `<cast:request>` instead of `<cast:query>` — the
receiver sees that tag in its formatted inbound (vs. `<cast:query>`
for q/a) so it knows the call is fire-and-forget and skips composing
`<cast:answer>`. The receiver's bit is still `a` (same accept gate
for both kinds). The difference is sender-side: `r` is the right
to emit the fire-and-forget envelope; if a reply is somehow attempted
it is dropped at the sender's reply gate. Use when the receiver
parses untrusted content and you don't want a return path that could
carry an injection.

Live ACL wins: granting the sender `q` later (in addition to or
instead of `r`) restores reply delivery on the next round-trip
without restart.

### p/h — handing user `alice` from `triage` to `billing` on `support`

Both halves key on the **user** being handed over (`u:alice@idp`),
not on the peer agent. The agents hold no bits for the handoff.

```json
// triage (source)/config/acl.json — alice may be pushed out on `support`
{
  "owner": "operator",
  "peers": {
    "u:alice@idp": { "support": "p" }
  }
}

// billing (receiver)/config/acl.json — alice may be hosted via push,
// consolidated with the `i` her pairing already wrote (see the merge
// gotcha below for why the `i` must be re-stated here).
{
  "owner": "operator",
  "peers": {
    "u:alice@idp": { "support": "ih" }
  }
}
```

A `p/h` push hands the originating user from sender to receiver. The
receiver opens or resumes a conversation with that user; the sender
drops out of the loop. `p` and `h` are **operator-conferred user
grants in `acl.json`, never granted by pairing** (pairing only ever
writes `i`/`o`). The user must also have paired with the receiver, so
she already holds `i` on `support` there. The receiver gates on both:
`h` (you authorized this user for cross-agent hosting) and `i` (she is
a member of the channel). When you author a p/h pair, name the pairing
step in your handoff summary so it doesn't get skipped.

Push without an originating user (e.g. from a scheduler-spawned
conversation with no human participant) is dropped. For file-handoff
pipelines with no user, see Design's mount-based wiring instead of
p/h.

### The p/h merge gotcha

`config/acl.json` peers override `state/paired-users.json` **per
identity key**, not per channel: the merge is
`{ ...pairedUsers, ...configPeers }`, so a `u:<id>` entry in
`acl.json` replaces that user's *entire* paired entry. Pairing writes
the user's `i` into `paired-users.json`; conferring `h` in `acl.json`
on the same user therefore wipes the paired `i` unless you re-state it.

So a receiver entry of `{ "support": "h" }` alone silently strips the
user's membership and the handoff is denied at the `i` gate. Conferring
`h` means consolidating both bits into one entry, `{ "support": "ih" }`,
either by writing the full `"ih"` in `acl.json` or by extending the
user's `paired-users.json` entry in place. This is the one case where
you touch a user's `i` by hand. Otherwise pairing is its sole writer.

## Common mistakes

- **Same bit on both sides** (e.g. `q` on both sender and receiver) —
  wrong. Bits are directional. Each side records ITS bit.
- **`q` on a receiver** — wrong. `q` is sender-only. If you find
  yourself writing `q` on the receiver, you have the sender/receiver
  direction inverted.
- **`a` on a sender** — wrong. `a` is receiver-only. Same check:
  who asks, who answers?
- **One side only** — silent failure. The framework gates BOTH sides;
  missing either entry blocks delivery with no error. Always write
  both halves.
- **Channel name mismatch** — sender targets `lookup` on the
  receiver, but the receiver has no `blueprint/channels/lookup/`.
  The bus falls back to `default` (logged as warning); the sender's
  expected handler never fires. Verify the channel exists on the
  receiver before granting.
- **`p/h` for agent-to-agent task dispatch** — wrong shape. `p`
  pushes the *originating user* of the sender's conversation, not
  a task; `h` hosts that user, not a task result. Without a user
  to hand over (scheduler-spawned conversation, pure agent-to-agent
  work) the bus has nothing to attribute and the push is dropped.
  For task dispatch use `q/a` (sender uses the reply) or `r/a`
  (sender drops the reply). See `multi-agent-composition.md` § p/h.

## Verify after write

After authoring or mutating a cross-agent ACL pair:

1. Re-read **both** `acl.json` files (the sender's and the
   receiver's).
2. Confirm the bit pair matches the shape table above.
3. Confirm the channel name matches on both sides.

Especially for All-Agents Configure: `conversation__push_to_channel`
into a per-agent Configure returns success on queue, not on
landing. Use `manager__resurvey` on the target agents and read both
files before declaring the wire-up done. A wire-up that's "done" but
missing one half is structurally indistinguishable from one that
landed correctly until traffic flows — by which point the operator
is debugging silence.

## Channels you grant on

ACL grants reference channel names from the receiver's blueprint
(under `blueprint/channels/<name>/`). If the channel doesn't exist
on the receiver, the grant is inert.

Channel naming, channel creation, and channel shape decisions are
Design's lane — see
`/ref/manuals/console/design/multi-agent-composition.md`. When a
grant references a channel that doesn't exist on the receiver,
route the operator to Design (or DM) to create it first; you
cannot create the channel from a Configure surface.

## Sharded channels

If the receiver's `channel.json` sets `use_sharding: true`, callers
address shards as `channel="name~qualifier"`. ACL grants use the
**bare channel name**; the `~qualifier` is routing metadata, not
part of the bit-grant key.

```json
// Grant covers all shards of the `review` channel:
"peers": { "reviewer": { "review": "a" } }
// Callers can then address `review~daily`, `review~urgent`, etc.
```

The sharding decision itself is Design's — see
`/ref/manuals/console/design/primitives.md` § Sharded channels.

## Where Configure does NOT write

- **User grants (`i`/`o`)** — written by the pairing flow into
  `state/paired-users.json` when a user redeems a pairing code. Do
  not hand-write `i`/`o` into `acl.json` from a Configure surface. The
  single exception is consolidating an existing `i` alongside an `h`
  you are conferring for a cross-agent handoff (§ The p/h merge
  gotcha); even then the `i` is one the user already earned by pairing,
  not a new grant you are inventing.
- **The agent's own peer entry** — the agent's own identifier never
  appears as a peer of itself.
- **Cross-agent blueprint files** — `peers.md`, `channel.json`, the
  channel handler prompt. Those are blueprint, not config — Design's
  lane.
