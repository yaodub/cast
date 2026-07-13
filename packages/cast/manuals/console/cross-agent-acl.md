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

## Grants are acquired two ways

A grant lands in `acl.json` either because you hand-author it here, or
because the **reactive approval** path wrote it. When an edge has no
grant and no reject tombstone, the first message on it is *held* and
the agent asks its owner to decide; an allow-always answer writes the
grant back into `acl.json` exactly as if you had authored it. So a wire
you do not pre-author is not blocked — it surfaces as an approval the
owner answers the first time traffic flows. While that approval is
outstanding, the reaching agent is not left guessing: it is told its
request is pending — parked awaiting the owner, not refused — so it
waits rather than retrying. Hand-authoring is for wires the operator
wants live without that first prompt.

You author the same JSON either way. The rest of this manual is the
shape of that JSON.

## Bit glossary

| Bit | Direction (this agent's view) | Meaning |
|---|---|---|
| `q` | outbound | Query: I ask, the reply enters my next-turn context |
| `r` | outbound | Request: I ask, my gate drops the reply before it enters context |
| `p` | outbound | Push containment: I may route my current user into a peer **agent's** conversation. Keyed on the peer agent. Reactive-managed — usually written by the owner-approval path, not hand-authored. |
| `a` | inbound | Answer: I receive `q` or `r` queries and emit `<cast:answer>`, and the peer becomes a member of the channel (a co-participant). |
| `i` | inbound | User → me (conversation messages, and channel membership). A pushed-in user lands here too — the access half of an inbound push. |
| `o` | outbound | Me → user (conversation messages). |

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
exactly what it can reach. `agent__list_peers` additionally shows
sibling agents tagged `granted` / `askable` / `rejected`, so an agent
can see where it could *request* reach, not only where it already has it.

**Who the peer key is.** Every bit keys on the **other agent** (its
alias or canonical address) — `q`/`r`/`a` for query and answer, `p`
for push-containment. The one exception is the access half of a push:
the receiver's grant for the carried user keys on that **user**
(`u:<id>`), because what it authorizes is the user's own conversation
on the receiver. See § Push for the two-sided shape.

## The directional rule

For every cross-agent edge, **two entries are written, one in each
agent's `acl.json`**:

|  | Sender's `acl.json` | Receiver's `acl.json` |
|---|---|---|
| **q/a** query | `allowed.<receiver>.<channel> = "q"` | `allowed.<sender>.<channel> = "a"` |
| **r/a** request | `allowed.<receiver>.<channel> = "r"` | `allowed.<sender>.<channel> = "a"` |
| **push** (two-sided) | `allowed.<receiver>.<channel> = "p"` | `allowed.<u:user>.<channel> = "io"` |

The framework gates both sides. Missing either entry blocks the edge
silently: no error, just delivery failure.

**Push is two-sided, on two different keys.** The sender's `p` keys on
the **receiver agent** (containment — "I may route a user into that
agent"). The receiver's `io` keys on the **carried user** (access —
"this user may converse here"), and that user must be a concrete member
of the channel. The two halves are decided by two owners — the sender's
owner approves the `p`, the receiver's owner approves the user's `io` —
and either can be pre-authored here. See § Push.

## JSON structure

`config/acl.json::allowed` is a nested map: peer-identifier → channel
→ bits. (`rejected` has the same shape and holds reject tombstones.)

```json
"allowed": {
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
| Canonical user address | `u:<guid>@<issuer>` | Human peer. The user's conversation grant (`io`), and the access half of an inbound push. |
| Any-agent glob | `a:*` | Bulk grant covering every agent identity. Falls in if no exact match. |

`u:*` is rejected at schema parse — a user grant names a specific user.

A bare type-prefix without `@<issuer>` (e.g. just `a:<guid>`) is
neither an alias nor a canonical address. It silently fails to
resolve. Use the alias or the full canonical form.

**Channel name (inner key)** — the channel on the **receiving**
agent. Both sides of an edge use this same name, because the bits
authorize the same channel — the one on the receiver.

**Bits (value)** — this agent's permissions toward that peer on
that channel. See the glossary above. Each side records ITS bit.
The six bits are `i o a q r p`; an agent peer key may carry only
`q/r/a/p` (the conversational `i`/`o` are for user and console keys).

The agent's own identifier does not appear as a peer. Owner access
short-circuits to full bits before the `allowed` map is consulted.

**The `owner` field widens writes only.** It defaults to
`"operator"`, an inert label that matches no identity. Setting it to
a real `u:<id>` gives that user unconditional push reach into any of
the agent's conversations — but reads stay member-scoped: enumeration
(`agent__list_channels`, `agent__list_participants`) and
cross-participant summaries are reserved for the agent itself and the
operator surfaces. A configured owner who should also *see* a room's
members must be placed there like anyone else. The `owner` is also who
the agent's reactive approvals route to; `approval_channel` pins which
conversation they land in.

## Worked examples

### q/a — `reviewer → field-agent` on `review`

```json
// reviewer/config/acl.json
{
  "owner": "operator",
  "allowed": {
    "field-agent": { "review": "q" }
  }
}

// field-agent/config/acl.json
{
  "owner": "operator",
  "allowed": {
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
  "allowed": {
    "worker": { "dispatch": "r" }
  }
}

// worker/config/acl.json
{
  "owner": "operator",
  "allowed": {
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

### Push — handing user `alice` from `triage` to `billing` on `support`

A push hands the sender's current user to the receiver agent. The
receiver opens or resumes a conversation with that user; the sender
drops out of the loop. Two halves, on two different keys:

```json
// triage (sender)/config/acl.json — triage may route a user into billing's `support`
{
  "owner": "operator",
  "allowed": {
    "billing": { "support": "p" }
  }
}

// billing (receiver)/config/acl.json — alice may converse on billing's `support`
{
  "owner": "operator",
  "allowed": {
    "u:alice@idp": { "support": "io" }
  }
}
```

- **Containment** is the sender's `p`, keyed on the **receiver agent**
  (`billing`) — "triage may route users into billing on `support`".
- **Access** is the carried user's `io`, keyed on the **user**
  (`u:alice@idp`) on the receiver — "alice may converse on `support`",
  which also makes her a member of the channel.

Both halves are reactive by default: the first time triage pushes,
triage's owner is asked to authorize the `p` edge to billing; when the
push lands, billing's owner is asked to authorize alice's `io`. When
both agents share an owner, the access half is auto-approved (one
owner, one decision). Pre-author either half here to skip its first
prompt. `p` is reactive-managed — prefer letting the owner approval
write it, and hand-author it only for a known, standing wire.

Push without an originating user (e.g. from a scheduler-spawned
conversation with no human participant) is dropped. For file-handoff
pipelines with no user, see Design's mount-based wiring instead.

## Common mistakes

- **Same bit on both sides** (e.g. `q` on both sender and receiver) —
  wrong. Bits are directional. Each side records ITS bit.
- **`q` on a receiver** — wrong. `q` is sender-only. If you find
  yourself writing `q` on the receiver, you have the sender/receiver
  direction inverted.
- **`a` on a sender** — wrong. `a` is receiver-only. Same check:
  who asks, who answers?
- **Push keyed the same on both sides** — wrong. The sender's `p`
  keys on the receiver **agent**; the receiver's `io` keys on the
  **user**. They are different keys, not a mirror pair.
- **One side only** — silent failure. The framework gates BOTH sides;
  missing either entry blocks delivery with no error. Always write
  both halves.
- **Channel name mismatch** — sender targets `lookup` on the
  receiver, but the receiver has no `blueprint/channels/lookup/`.
  The bus falls back to `default` (logged as warning); the sender's
  expected handler never fires. Verify the channel exists on the
  receiver before granting.
- **Push for agent-to-agent task dispatch** — wrong shape. A push
  routes the *originating user* of the sender's conversation, not a
  task; the receiver hosts that user, not a task result. Without a user
  to hand over (scheduler-spawned conversation, pure agent-to-agent
  work) the bus has nothing to attribute and the push is dropped.
  For task dispatch use `q/a` (sender uses the reply) or `r/a`
  (sender drops the reply). See `multi-agent-composition.md` § Push.

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
"allowed": { "reviewer": { "review": "a" } }
// Callers can then address `review~daily`, `review~urgent`, etc.
```

The sharding decision itself is Design's — see
`/ref/manuals/console/design/primitives.md` § Sharded channels.

## Where Configure does NOT write

- **The agent's own peer entry** — the agent's own identifier never
  appears as a peer of itself.
- **Reject tombstones, casually** — a `rejected` entry is a hard deny
  the reactive gate stops re-asking on. Write one to permanently shut
  an edge, not as a substitute for simply leaving a grant absent (an
  absent grant is still askable).
- **Cross-agent blueprint files** — `channel.json`, the channel handler
  prompt. Those are blueprint, not config — Design's lane.
