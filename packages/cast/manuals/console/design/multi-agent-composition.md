# Design — multi-agent composition

Read this only if the agent you're composing peers with another agent —
either because the brief mentions an upstream/downstream peer, or
because the operator is asking you to connect agents.

The composition below assumes the seam between agents is the right
call. That decision is All-Agents Design's — by the time you're reading
this, the brief implies the seam is decided. But if what you're about
to do produces a courier shape (your agent's only job on the edge is to
relay what it received; or the peer's only job is to relay back to a
tool), the seam is wrong. Flag back to All-Agents Design via
`<cast:query>` — *"this looks like a courier hop; should we collapse?"* —
before papering over it with a tighter handoff.

## What you're composing

You are not drawing a connection graph. Agents find each other at
runtime: `agent__list_peers` shows every sibling and whether this agent
can already reach it, could request to, or is blocked from it; and an
agent's granted reach is computed into its prompt. The graph forms from
what agents advertise, what's granted, and what's blocked — you don't
author the edges by hand.

So composition is three design acts on the agent in front of you:

1. **How it advertises itself** — its description and its channels are
   its face in discovery. A peer decides whether and how to engage it
   from those alone.
2. **What shape each interaction takes** — query, request, or push,
   chosen on intent and trust.
3. **Its reachability posture** — what's open, what's open to ask, what
   is closed.

The grants that authorize an edge are Configure's lane (per-agent
Configure for a single edge, All-Agents Configure across two agents).
You shape the surface and name the intent; Configure writes `acl.json`;
the agents discover the rest. The ACL reference Configure reads is
`/ref/manuals/console/cross-agent-acl.md` — name the shape and channel
in your handoff, don't propose ACL JSON in your output.

`show_co_participants` is not part of edge wiring. It's a `channel.json`
flag that governs whether a channel's own members see and reach each
other — it neither opens nor closes a cross-agent edge. The grant
places a peer on the channel; this flag then governs whether the members
placed there are open to one another. See `primitives.md` §
Co-participant visibility.

## Advertise the interface

What a peer sees of this agent at discovery time is its **description**
and its **channels** — nothing else. Write both to be legible to a
stranger, because a stranger (another agent) is who reads them.

- **The agent description** answers *should I engage this agent at
  all?* Make it a sharp statement of what the agent does and hands
  back — "reviews draft copy and returns a one-to-three-sentence
  verdict," not "helper agent." A peer cannot decide to use what it
  cannot understand from the description alone.
- **A channel is the agent's API surface.** A peer reaches the agent
  *through a channel*, so each channel you expose is a published entry
  point. Its name and description are the signature — a `review`
  channel described as "ask me to review a draft" tells a caller what
  to send without any hand-wired instruction. Its `channel.json`
  (lifecycle, idle timeout, tool surface) and `prompt.md` (the handler)
  define how inbound traffic on it is treated.

Designing these well is the bulk of composition. The receiver's channel
plus its handler is where the work lives; reachability follows from it.

### A named channel, end to end

A `review` channel on `field-agent` that accepts a query and answers:

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
You are receiving a review query. Reflect on your current state and
answer concisely:

1. Parse the incoming question.
2. Identify the most relevant slice of your recent work.
3. Emit a single `<cast:answer>` with 1-3 sentences.
```

That folder, plus a sharp channel description, is the whole receiver
side. Configure grants on `review`; a peer discovers it and addresses
`<cast:query target="field-agent" channel="review">`.

If the channel sets `use_sharding: true`, callers address a specific
shard as `channel="name~qualifier"`, and `agent__list_peers` renders the
channel as `name~*` to signal the affordance. When and how to shard is a
channel-shape decision — see `primitives.md` § Sharded channels.

## The shape of the interaction

Each edge engages a channel in one of three shapes. Pick on intent and
trust; the grants follow from the shape (Configure's, from
`/ref/manuals/console/cross-agent-acl.md`).

### `q`/`a` — query, answer enters context

Sender asks; receiver spawns a session, runs its handler, emits a
`<cast:answer>`. The answer arrives in the sender's next-turn context.

Use when the sender needs the receiver's information to continue its
own turn.

The answer lands in the *sender's* context, so verbose answers are paid
twice — once as receiver output, once as sender input. Q/A edges work
best when the handler's prompt teaches it to hand back a conclusion, not
the deliberation that produced it. If the question deserves a long
answer, that's often a sign the asker needs the substrate the answerer
reads from, not the answer itself — mount-based wiring below.

**Caveat:** answer text enters the sender's context, so a compromised
receiver can prompt-inject the sender. Use `r/a` if that matters.

### `r`/`a` — request, fire-and-forget

Same routing as `q/a`, but the sender emits `<cast:request>` instead of
`<cast:query>`. The receiver sees that tag on its inbound, so it knows
no `<cast:answer>` is expected — it does the work and emits no envelope
reply. If a reply is attempted anyway, the sender's gate drops it before
it enters context.

Use when the sender dispatches work to a peer that parses untrusted
content (web pages, email, user-supplied text) and you don't want a
return path that could carry an injection.

Worked composition: `recipes/untrusted-content-airlock.md`.

### Push — hand a user over

A push delivers a message on a channel attributed to the user currently
in the sender's conversation. The receiver opens or resumes a
conversation with that user on the channel; the user becomes a
participant on the receiver; the sender drops out. Subsequent replies
flow receiver↔user.

Use for **user-routing handoffs**: a support bot hands a user to
billing, a triage agent routes to the right specialist. The
conversation that started elsewhere continues with the new agent.

A push needs a user to hand over — the sender's current participant.
Without one (a scheduler-spawned conversation with no human), there is
nothing to attribute and the push is dropped; for no-user data
pipelines, see mount-based wiring.

Mechanism: `conversation__push_to_channel({target_agent, channel, text})`.
Worked composition: `recipes/front-desk-handoff.md`.

For other patterns:
- agent A asks B and uses the reply → `q/a`
- agent A dispatches work to B, no reply needed (or B parses untrusted
  content) → `r/a`
- producer writes a file, consumer watches → mount-based wiring below

## The reachability posture

Every edge into this agent sits in one of three positions:

- **Open** — granted; traffic flows.
- **Open to ask** (the default) — the agent is discoverable and
  reachable on request; the first time a peer reaches, the owner is
  asked to allow or deny. An edge with nothing said about it sits here.
- **Closed** — a deliberate block; the peer is never even asked.

Because *open to ask* is the default, an agent is reachable-by-request
unless something says otherwise. So a non-communication intent is an
act, not an absence. If this agent must not be reachable by a particular
peer or user — a finance agent the public triage bot should never touch,
a user who should not be able to reach another — name that as a
**standing block** in your handoff, and Configure writes it. The owner
holds the same lever at runtime, allowing or denying each first contact
as requests arrive. Your call is which edges deserve a standing block up
front and which are fine left open to ask.

This is a real part of the design, not an afterthought: an agent's
social posture — what it advertises, what it answers, and what it
refuses — is composed as deliberately as its channels.

## Naming it in your handoff to Configure

When you finish composing a cross-agent edge, your completion summary
names:

- Sender, receiver, channel name
- The shape (`q/a`, `r/a`, or push)
- Any **standing block** — an edge that should be closed, not left open
  to ask
- That Configure (per-agent or All-Agents) writes the grant from
  `/ref/manuals/console/cross-agent-acl.md`

Example: *"Wire chief-executive → market-intelligence on channel
`briefings` as `q/a`. Configure writes the grant from
`/ref/manuals/console/cross-agent-acl.md`."*

Use aliases for the agent peer keys (e.g. `field-agent`, `reviewer`, not
canonical addresses or fingerprints). The framework resolves aliases at
lookup time and they stay valid across key rotation. Do not propose the
ACL JSON yourself — the bits and the worked examples are Configure's
manual.

## Designing the receiver's channel

Channels are the unit of both the interface and the conversational
context (idle_timeout, lifecycle, disabled_tools, summaries). Choosing
whether an edge lands on an existing channel or earns a new one is a
real design decision.

A cross-agent edge can land on the receiver's `default` channel — the
easy path, almost always right. `default` always exists as an implicit
fallback (no `channel.json` needed). Reach for it first.

Give the edge its own named channel only when one of these holds:

- The edge needs a different `idle_timeout`, `lifecycle`, or
  `disabled_tools` shape than `default` — peer cadence rarely matches
  user pacing, and the tool surface may differ (mutation tools
  disabled, no scheduled tasks). See `primitives.md` § Channel
  lifecycle for picking the timer.
- The receiver has a human actively chatting on `default` and a peer's
  traffic shouldn't land in their context window.
- The receiver's `default` handler assumes a human and would mishandle
  agent traffic.
- A channel-specific `prompt.md` would sharpen the agent's posture for
  this interaction — focus its attention, constrain its tools, set a
  framing `default` wouldn't carry.

Otherwise point at `default` and move on. Every named channel is a
folder, a handler prompt, and a string both the grant and the folder
have to keep aligned — don't create one for tidiness.

When you do name a channel, the name and description should signal what
it is FOR — the question type for q/a or r/a (`review`, `lookup`,
`dispatch`, `audit`), the destination role for a push (`support`,
`billing`, `escalation`). A reader of the receiver's blueprint should be
able to tell what kind of traffic the channel carries from the name
alone. Avoid generic names like `peer` or `inbox` that convey nothing —
if you can't name what the channel is for, that's a signal the edge
belongs on `default`.

The grant is per-peer-per-channel: granting `peer-X` on `review`
authorizes peer-X (and only peer-X) there. It is not a wildcard.

## The channel name must line up

One alignment to keep: the channel string the grant authorizes and the
receiver's `blueprint/channels/<channel>/` folder name must be
identical. If the grant authorizes `review` but the handler lives at
`channels/lookup/prompt.md`, traffic falls back to `default` (logged as
a warning) and the intended handler never fires. The channel name comes
from the brief, not local invention — if it's unspecified, ask DM via
`<cast:query>` before the edge is wired. Create the receiver's channel
folder before Configure grants on it.

## Failure modes

Cross-agent delivery is at-most-once at the bus layer — queueing returns
success before the receiver processes anything. Per shape:

- **`q`/`a`** — answers can take seconds to minutes (receiver spawns a
  session). Design the asker's prompt to tolerate no-answer (timeout
  fallback, at most one retry). Watch the rejection path: a receiver-side
  denial or draft mode comes back as a rejection packet, not silence. A
  request held for the receiver owner's approval is likewise surfaced —
  a non-terminal pending notice — and the asker's request stays open
  until the owner decides, so the eventual answer still lands.
- **`r`/`a`** — sender never sees the outcome by design. If you need
  confirmation that work happened, use `q`/`a` instead.
- **Push** — one-shot handoff. The sender should narrate the handoff to
  the user *before* pushing ("connecting you with billing now") so the
  user has context if the push lands them in a cold session.
- **Receiver-side, all shapes** — tolerate malformed payloads (log raw,
  don't discard); the sender's gate doesn't validate content.

## Mount-based wiring (file shared instead of message sent)

When the topology is producer-writes-file / consumer-watches — the right
fit for no-user data pipelines that don't fit q/a, r/a, or push — the
same authority order applies; slot names come from the brief, not local
invention. Producer declares no slot; it writes its own `/memory/`.
Consumer declares the slot in
`blueprint/props/capabilities.json::resources` and watches
`/resources/<slot>` from its handler. The operator binds the slot to the
producer's host path in Configure (mention it in your completion summary
like any other cross-agent handoff).

This is also the right shape when the payload is large enough that
sending it inline would re-pay the bytes at each hop. Mount-based wiring
lets the content live in storage; only the path crosses the seam. If a
prospective q/a or push edge is about to carry a kilobyte-plus payload,
prefer the producer writes the artifact and the receiver reads it from
the slot.

**Slot-name guidance:** the slot is the consumer's declaration of where
on its filesystem the producer's output appears. Pick a name that
signals the source — e.g. `peer-<source>` lines up readably across both
sides. Keep it descriptive of what the slot carries.

## When the operator asks about multi-agent wiring from scratch

If the operator comes to you without All-Agents Design having briefed a
multi-agent system — they're in per-agent Design asking *"can this agent
talk to another agent I'll create later?"* — route them to the
fleet-row All-Agents Design:

> *"Cross-agent composition is All-Agents Design's lane — they hold the
> cross-agent picture. I can shape this agent's side of the handoff, but
> the other end needs All-Agents Design to coordinate. Open the
> All-Agents Design tile in your sidebar."*

Don't try to compose both ends from a single agent's Design session. The
channel-name coordination only works when one actor holds the full
picture.
