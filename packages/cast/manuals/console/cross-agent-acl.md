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

Not to be confused with `show_co_participants`, a `channel.json`
visibility flag governing whether an agent is aware of *its own*
co-participants. That's intra-agent and unrelated to ACL — it grants
nothing and blocks no edge.

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
| `a` | inbound | Answer: I receive `q` or `r` queries and emit `<cast:answer>` |
| `h` | inbound | Host: I accept `p` pushes (host the handed-over user) |
| `i` | inbound | User → me. Set by the pairing flow, never hand-written. |
| `o` | outbound | Me → user. Set by the pairing flow, never hand-written. |

Bits are *this agent's* view. They never match across the two ends
of an edge — each side records ITS bit, not the peer's.

## The directional rule

For every cross-agent edge, **two entries are written, one in each
agent's `acl.json`**:

|  | Sender's `acl.json` | Receiver's `acl.json` |
|---|---|---|
| **q/a** query | `peers.<receiver>.<channel> = "q"` | `peers.<sender>.<channel> = "a"` |
| **r/a** request | `peers.<receiver>.<channel> = "r"` | `peers.<sender>.<channel> = "a"` |
| **p/h** push | `peers.<receiver>.<channel> = "p"` | `peers.<sender>.<channel> = "h"` |

The framework gates both sides. Missing either entry blocks the edge
silently — no error, just delivery failure.

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
| Canonical user address | `u:<guid>@<issuer>` | Human peer. Usually written by the pairing flow into `state/paired-users.json`, not hand-authored here. |
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

## Worked examples

### q/a — `reviewer → field-agent` on `review`

```json
// reviewer/config/acl.json
{
  "owner": "local",
  "peers": {
    "field-agent": { "review": "q" }
  }
}

// field-agent/config/acl.json
{
  "owner": "local",
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
  "owner": "local",
  "peers": {
    "worker": { "dispatch": "r" }
  }
}

// worker/config/acl.json
{
  "owner": "local",
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

### p/h — `triage → billing` on `support`

```json
// triage/config/acl.json
{
  "owner": "local",
  "peers": {
    "billing": { "support": "p" }
  }
}

// billing/config/acl.json
{
  "owner": "local",
  "peers": {
    "triage": { "support": "h" }
    // The originating user's `i` grant on billing's `support` channel
    // comes from the pairing flow, NOT from Configure. Users pair
    // with billing themselves via /pair on a channel that grants i.
  }
}
```

A `p/h` push hands the originating user from sender to receiver.
The receiver opens or resumes a conversation with that user; the
sender drops out of the loop. Configure's job stops at the
agent-pair bits — the user-side `i` grant is a runtime artifact of
pairing. When you author a p/h pair, name the pairing step in your
handoff summary so it doesn't get skipped.

Push without an originating user (e.g. from a scheduler-spawned
conversation with no human participant) is dropped. For file-handoff
pipelines with no user, see Design's mount-based wiring instead of
p/h.

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
  not hand-write `i`/`o` into `acl.json` from a Configure surface.
- **The agent's own peer entry** — the agent's own identifier never
  appears as a peer of itself.
- **Cross-agent blueprint files** — `peers.md`, `channel.json`, the
  channel handler prompt. Those are blueprint, not config — Design's
  lane.
