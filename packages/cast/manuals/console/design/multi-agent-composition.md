# Design — multi-agent composition

Read this only if the agent you're composing peers with another agent —
either because the brief mentions an upstream/downstream peer, or
because the operator is asking you to wire messages between agents.

The composition mechanics below assume the seam between agents is the
right call. That decision is All-Agents Design's — by the time you're
reading this, the brief implies the seam is decided. But if the
wiring you're about to do produces a courier shape (your agent's only
job on the edge is to relay what it received; or the peer's only job
is to relay back to a tool), the seam is wrong. Flag back to
All-Agents Design via `<cast:query>` — *"this looks like a courier
hop; should we collapse?"* — before papering over it with a tighter
handoff.

## Why this file exists

When Design Manager batches multi-agent creates, each per-agent Design
session runs in isolation — you can see your own folder and the
cross-agent blueprint summaries, but you compose your peer references
without coordinating with the other Design sessions running concurrently.
That means two Design sessions can pick different channel names for the
same peer relationship, and the resulting pipeline silently breaks at
first message.

The rule, stated once:

> **Channel names for cross-agent edges come from the brief, not local
> invention.** If the brief doesn't specify a channel name, ask DM
> (via `<cast:query>`) before writing `peers.md`. Never guess.

## Composition vs authorization — the boundary

Composition is your lane. You name channels, write
`blueprint/channels/<name>/`, draft the handler prompt, declare peer
relationships in `peers.md`, and pick the shape of each edge (`q/a`,
`r/a`, `p/h`). What you do **not** do: write `acl.json`. ACL bit
authorship is Configure's lane (per-agent Configure for single-edge,
All-Agents Configure for cross-agent). Composition declares what
an edge would be; the grant authorizes it to carry traffic.

When your completion summary names a cross-agent edge, name the shape
and channel — *"q/a query from sender to receiver on channel X"* — and
hand the grant authoring to Configure. Don't propose ACL JSON in your
output. The ACL reference Configure reads is
`/ref/manuals/console/cross-agent-acl.md`.

`show_co_participants` is not part of edge wiring. It's a
`channel.json` flag about an agent's awareness of *its own*
participants — it neither opens nor blocks a cross-agent edge, and a
receiver hosting many callers sets it on the receiving channel
independent of any grant. See `primitives.md` § Co-participant
visibility.

## The three files that must agree

For any cross-agent edge `sender → receiver`, three places name the
channel and must match — regardless of shape (q/a, r/a, p/h):

| File | Role | What it names |
|---|---|---|
| `<sender>/blueprint/identity/peers.md` | sender-side | The channel the sender addresses on the receiver |
| `<receiver>/blueprint/channels/<channel>/channel.json` | receiver-side | The channel config |
| `<receiver>/blueprint/channels/<channel>/prompt.md` | receiver-side | The handler logic for inbound traffic on that channel |

If `peers.md` says `channel: "default"` but the receiver's handler lives
at `channels/lookup/prompt.md`, traffic lands in the wrong channel and
the handler never fires.

## Channel-name decisions

A cross-agent edge can land on the receiver's `default` channel —
that's the easy path and almost always works. `default` always
exists as an implicit fallback, no `channel.json` needed, no extra
files. Reach for it first.

Reach for a dedicated named channel only when one of these is true:

- The edge needs a different `idle_timeout`, `lifecycle`, or
  `disabled_tools` shape than `default` has — peer cadence rarely
  matches user pacing, and the tool surface may differ (mutation
  tools disabled, no scheduled tasks). See `primitives.md` § *Channel
  lifecycle* for picking the timer.
- The receiver has a human actively chatting on `default` and you
  don't want the peer's traffic landing in their context window.
- The receiver's `default` handler logic would mishandle agent
  traffic (handler prompt assumes a human, agent traffic would
  confuse it).
- You want a channel-specific prompt to sharpen the agent's posture
  for this peer interaction — focus its attention, constrain how it
  uses tools, or set a framing the default prompt wouldn't carry.
  The channel's `prompt.md` is the lever.

Otherwise, point at `default` and move on. Every named channel is
a folder, a handler prompt, an extra file in the operator's
blueprint, and a string both sides have to keep aligned — don't
create one for tidiness.

When you *do* create a named channel, **the name should signal what
the channel is FOR** — the question type for q/a or r/a (`review`,
`lookup`, `dispatch`, `audit`), the destination role for p/h
(`support`, `billing`, `escalation`). A reader of the receiver's
blueprint should be able to tell what kind of traffic the channel
carries from the name alone.

Do not reach for generic names like `peer` or `inbox` to fill a
slot. A channel name that conveys nothing forces the handler prompt
to do all the work, and it pairs awkwardly with the ACL JSON
structure (`peers.<sender>.peer = "..."` stacks the same word three
times). If you cannot pick a name that says what the channel is for,
that's a signal the edge probably belongs on `default`, not on a
new named channel.

Authority order below still wins; DM can override in the brief.

## Where to find the channel name

If the brief specifies a channel, use it. If the receiver's blueprint
summary at `/ref/agents/<other-folder>.blueprint.md` shows a relevant
named channel (e.g. a p/h pointing at the receiver's existing user
channel), use that. Otherwise, `default`.

Don't invent a name the receiver doesn't have a folder for —
`default` always exists; any other channel name requires a matching
`blueprint/channels/<name>/` folder on the receiver, which is
Design's job to create *before* Configure wires the grant. When
the brief is thin and you're unsure, `default` is the safe choice;
ask DM via `<cast:query>` if you want explicit confirmation.

## Typical shape

### Minimal — peer on `default`

When the edge lands on `default`, the only file you write is the
sender's `peers.md` entry:

```markdown
## field-agent
- target_agent: `field-agent`
- channel: `default`
```

`default` always exists, so no channel folder is needed on the
receiver. Configure writes the ACL pair.

### Named channel — when the edge earns its own shape

A `q`/`a` review edge — `reviewer → field-agent` on a dedicated
`review` channel. Same three-file alignment applies to `r`/`a` and
`p`/`h`; the choice between shapes is below.

**`field-agent/blueprint/channels/review/channel.json`:**

```json
{
  "idle_timeout": null,
  "lifecycle": "none",
  "log_messages": true,
  "disabled_tools": ["conversation__push_to_channel", "task__schedule"]
}
```

`idle_timeout: null` makes it single-shot — each review spawns a fresh
session, no state bleed between calls.

**`field-agent/blueprint/channels/review/prompt.md`:**

```markdown
You are receiving a review query from the reviewer agent. Reflect on
your current state and answer concisely:

1. Parse the incoming question.
2. Identify the most relevant slice of your recent work.
3. Emit a single `<cast:answer>` with 1-3 sentences.
```

**`reviewer/blueprint/identity/peers.md`:**

```markdown
## field-agent

Reviewable peer.

- target_agent: `field-agent`
- channel: `review`
- mechanism: `<cast:query target="field-agent" channel="review">…</cast:query>`
```

The `channel: review` in the sender file matches the directory name in
`field-agent/blueprint/channels/review/`. That's the alignment.

### Sharded peer channels

If the receiver's `channel.json` sets `use_sharding: true`, the channel
hosts qualifier-keyed sub-conversations. Callers address a specific
shard as `channel="name~qualifier"` (e.g.
`<cast:query target="field-agent" channel="review~daily">`).
`agent__list_peers` renders shardable peer channels as `name~*` to
signal the affordance. The choice of *when* to shard a channel and
*how* to pick the qualifier is a channel-shape decision — see
[primitives § Sharded channels](primitives.md)
for the full mechanics and prompt-authoring guidance.

## The three shapes available

Each cross-agent edge picks one of three shapes. The shape decides
how the conversation flows; pick on intent. The ACL grants that
authorize it (Configure's to write) follow from the shape choice —
see `/ref/manuals/console/cross-agent-acl.md` for what Configure
writes.

### `q`/`a` — Query, answer enters context

Sender asks; receiver spawns a session, runs its handler, emits a
`<cast:answer>`. The answer arrives in the sender's next-turn
context.

Use when the sender needs the receiver's information to continue
its own turn.

The answer lands in the *sender's* context, so verbose answers are
paid twice — once as receiver output, once as sender input. Q/A
edges work best when the handler's prompt teaches it to hand back a
conclusion, not the deliberation that produced it. If the question
deserves a long answer, that's often a sign the asker needs the
substrate the answerer would read from, not the answer itself —
mount-based wiring below.

**Caveat:** answer text enters the sender's context — a compromised
receiver can prompt-inject the sender. Use `r/a` if that matters.

### `r`/`a` — Request, reply dropped at sender

Same wire shape as `q/a` (sender emits `<cast:query>`, receiver
emits `<cast:answer>`). The difference is purely sender-side: the
sender's gate drops the reply before it enters context.

Use when the sender dispatches work to a peer that parses untrusted
content (web pages, email, user-supplied text) and you don't want
a return path that could carry an injection.

The receiver doesn't know which shape the sender chose — its side is
always `a`.

### `p`/`h` — Push, user handed over

The `p` bit means *push my originating user to another agent*; the
`h` bit means *host an incoming user pushed to me*. Sender delivers
a message on channel X attributed to the user currently in the
sender's conversation; the receiver opens or resumes a conversation
with that user on X; the user becomes a participant on the
receiver; the sender drops out. Subsequent replies flow
receiver↔user.

Use for **user-routing handoffs**: a support bot hands a user to
billing, a triage agent routes to the appropriate specialist. The
conversation that started elsewhere continues with the new agent.

**Constraint.** A push requires the originating user to already be
paired with the receiver — through the pairing flow (operator
generates a pairing code on the receiver; user redeems it) or
pre-existing static peering. Without a user to hand over, the bus
has nothing to attribute and the push is dropped.

For other agent-to-agent patterns:
- agent A asks B and uses the reply → `q/a` (see above)
- agent A dispatches work to B, no reply needed (or B parses
  untrusted content) → `r/a` (see above)
- producer writes a file, consumer watches → [mount-based
  wiring](#mount-based-wiring-file-shared-instead-of-message-sent)

Mechanism: `conversation__push_to_channel({target_agent, channel, text})`.

## Naming the shape in your handoff to Configure

When you finish composing a cross-agent edge, your completion summary
should name:

- Sender, receiver, channel name
- Which shape (`q/a`, `r/a`, or `p/h`)
- That Configure (per-agent or All-Agents Configure) writes both sides
  of the ACL pair

Example completion line: *"Wire chief-executive → market-intelligence
on channel `briefings` as `q/a`. Configure writes both sides of the
ACL pair from `/ref/manuals/console/cross-agent-acl.md`."*

Use aliases for the agent peer keys (e.g. `field-agent`, `reviewer`,
not canonical addresses or fingerprints). The framework resolves
aliases at lookup time and they stay valid across key rotation.

For a `p/h` push, also name the **pairing step** the operator owes:
*"Each user must pair with billing on its `support` channel via
/pair before pushes from triage will land."* Configure does not write
the user-side `i` grant; the pairing flow does.

Do not propose the ACL JSON yourself. The bit pair, the directional
rule, and the worked JSON examples live in
`/ref/manuals/console/cross-agent-acl.md` — that's Configure's manual.

## Channel creation, reuse, and existence

Channels are the unit of both ACL grants and conversational context
(idle_timeout, lifecycle, disabled_tools, summaries). Choosing whether
to wire an edge onto an existing channel or to create a new one is a
real design decision, not a naming convention.

### The receiver must have the channel configured

If the sender targets `channel: "lookup"` on the receiver but the
receiver has no `blueprint/channels/lookup/channel.json`, the message
silently falls back to `default` — logged as a warning, no exception.
The sender's `<cast:answer>` will never arrive on the channel the
sender expected because the receiver's handler for `lookup` doesn't
exist; whatever logic the operator wired into the `default` channel
runs instead.

Before naming a channel in a `peers.md` entry, verify the receiver's
blueprint summary lists that channel. If it doesn't, create the channel
(Design's job, on the receiver) before Configure wires the grant.

### Use the existing channel or create a new one?

**Use what's already there** — `default`, or a named channel that
already exists on the receiver — when the existing shape fits. Two
common reuse cases:

- The receiver has no special peer-specific needs; `default` works.
  (This is most edges.)
- A `p/h` push landing on the receiver's existing user channel —
  that's the canonical reuse case, since the user-hosting channel is
  exactly what `p/h` needs.

**Create a new named channel** only when the cases in
*Channel-name decisions* above apply: a different
`idle_timeout`/`lifecycle`/`disabled_tools` shape, a channel-specific
prompt to sharpen the agent's posture, isolation from a busy
`default`, or a `default` handler that wouldn't carry agent traffic
correctly.

### `default` and agent traffic

`default` is the cheapest cross-agent target — it always exists as an
implicit fallback (no `blueprint/channels/default/channel.json`
needed) and requires no per-edge channel files on the receiver. Reach
for it first.

Two genuine reasons to land a peer on its own named channel instead:

- **Context mixing.** When the receiver has a human actively chatting
  on `default`, a peer's push lands in the same context window the
  human is using. If the peer's traffic shouldn't be visible in that
  conversation, give it a separate channel.
- **Shape or prompt mismatch.** `default`'s
  `idle_timeout`/`lifecycle`/tool surface and prompt are tuned for
  whatever the receiver does on `default` — usually a human
  conversation. A dedicated channel lets you set those independently
  for the peer interaction.

The ACL grant is per-peer-per-channel: granting `peer-X: { default:
"a" }` authorizes peer-X (and only peer-X) on `default`. It is *not*
a wildcard — other peers don't get access. The concern with
`default` is whether the peer should share the surface, not whether
the grant scope is too broad.

## Failure modes

Cross-agent delivery is at-most-once at the bus layer — queueing
returns success before the receiver processes anything. Per shape:

- **`q`/`a`** — answers can take seconds to minutes (receiver spawns a
  session). Design the asker's prompt to tolerate no-answer (timeout
  fallback, at most one retry). Watch for the rejection path:
  receiver-side ACL denial or draft mode comes back as a rejection
  packet, not silence.
- **`r`/`a`** — sender never sees outcome by design. If you need
  confirmation that work happened, use `q`/`a` instead.
- **`p`/`h`** — one-shot handoff. The sender should narrate the
  handoff to the user *before* pushing ("connecting you with billing
  now") so the user has context if the push lands them in a cold
  session.
- **Receiver-side, all shapes** — tolerate malformed payloads (log
  raw, don't discard); the sender's gate doesn't validate content.

## Mount-based wiring (file shared instead of message sent)

When the topology is producer-writes-file / consumer-watches — the
right fit for no-user data pipelines that don't fit q/a/r/a/p/h —
the same authority order applies; slot names come from the brief,
not local invention. Producer declares no slot; it writes its own
`/memory/`. Consumer declares the slot in
`blueprint/props/capabilities.json::resources` and watches
`/resources/<slot>` from its handler. The operator binds the slot
to the producer's host path in Configure (mention it in your
completion summary like any other cross-agent handoff).

This is also the right shape when the payload is large enough that
sending it inline would re-pay the bytes at each hop — producer
output, push body, consumer input. Mount-based wiring lets the
content live in storage; only the path crosses the seam. If a
prospective q/a or push edge is about to carry a kilobyte-plus
payload, prefer the producer writes the artifact and the receiver
reads it from the slot.

**Slot-name guidance:** the slot is the consumer's declaration of
where on its filesystem the producer's output appears. Pick a name
that signals the source — e.g. `peer-<source>` lines up readably
across both sides. Keep it descriptive of what the slot carries; the
same anti-pattern caution from channel naming applies.

## When the operator asks about multi-agent wiring from scratch

If the operator comes to you without All-Agents Design having briefed
a multi-agent system — they're in per-agent Design asking *"can this
agent talk to another agent I'll create later?"* — route them to the
fleet-row All-Agents Design:

> *"Cross-agent wiring is All-Agents Design's lane — they hold the
> cross-agent picture. I can sketch this agent's side of the handoff,
> but the other end needs All-Agents Design to coordinate. Open the
> All-Agents Design tile in your sidebar."*

Don't try to pre-wire from a single agent's Design session. The channel
name coordination problem only works when one actor holds the full
picture.
