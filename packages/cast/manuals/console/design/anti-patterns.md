# Design — anti-patterns

The recipes name shapes that work. This file names shapes that
waste. Each entry: what it looks like, what it costs, what to
reach for instead. Principles referenced are from `economics.md`.

Read like the recipes — inspiration in the negative, not a
checklist. Develop the feel; spot the smell earlier next time.

---

## Principle 1 — context that isn't load-bearing

### Heavy identity

`prompt.md` three pages long, prescribing every edge case; `skills.md`
written as tutorial prose; `whoami.md` padded with facts that belong
in `/memory/`.

Layers 4–7 ride every conversation. Three pages of prescription
pays three pages per fire, forever.

**Reach for:** scaffolding, not definition (`what-is-an-agent.md`).
Voice + principle in `prompt.md`. Bullets in `skills.md`. Keep each
layer to what earns its place on every turn.

### Eager bootstrap

`bootstrap.md` reads five `/memory/` files and narrates each before
the first user turn.

Every conversation pays the bootstrap output whether this turn
needed any of it.

**Reach for:** point at `/memory/` in bootstrap; teach the agent in
`prompt.md` to Read specific files mid-turn when the question calls
for them.

### Eager capability load

`capabilities.json` enables every extension; channels that don't
use them inherit the full tool surface.

Tool descriptions inject on every conversation that loads the
tool — MCP servers with verbose docs cost that verbosity per fire.

**Reach for:** `disabled_tools` per channel. Single-shot processing
channels drop push and write tools; channels without scheduling
drop `task__*`. Blast-radius and economy win together.

### Heavy `agent-context.md` / oversized summaries

`agent-context.md` (Layer 9) written verbosely on every refresh;
`cleanup.md` writes long `conversation__write_summary` output.

Layer 9 assembles every turn. Up to three previous-session
summaries auto-inject per turn — verbose cleanup compounds
three-fold.

**Reach for:** distill aggressively. Summary is for the next
session's first turn — a paragraph of what mattered, not a
transcript.

---

## Principle 2 — seams that don't follow judgment

### Courier agent

An agent whose inbound is large and outbound is a single tool call
with the same payload. A "publisher" that takes content and calls
`publish(text)`. A "forwarder" that takes a message and pushes it.

Full agent overhead — identity, capabilities, summaries — for work
that doesn't need a separate agent. Inbound also re-pays the
content as input tokens.

**Reach for:** collapse. Either the upstream agent does the
publishing itself, or the seam earns its existence with real
judgment (formatting decisions, scheduling, gatekeeping). If you
can't name what the courier *decides*, it's a courier.

### Process-decomposition seam

Two or three agents chained because the *work* has steps:
writer → editor → publisher; parser → enricher → router. Each
re-reads most of the prior agent's context.

Full agent overhead at every chop. High verbatim overlap between
contexts. Specialization in name only.

**Reach for:** carve by *categorical difference* — judgment,
access, scope, trust. If the only difference is which step of one
job, fold. For sequencing within one agent, use channels or
scheduled fires.

---

## Principle 3 — handoffs that carry deliberation, not conclusions

### Verbatim narration

Agent A writes *"Here's what I reasoned through: step 1... step
2... therefore X"* and sends the whole thing to B. B only needed X.

A's reasoning enters B's context as inbound. Q/A answers also
re-enter the sender's context — verbose answers double-tax.

**Reach for:** hand the conclusion. *"X."* If B needs reasoning, B
asks. R/A expects no reply at all — even cheaper.

### Verbatim payload

Agent A writes a 5KB article inline into a push to B, whose only
action is `publish(text)`.

Same bytes paid three times: A's output, message body, B's input.

**Reach for:** pass by reference. A writes to `/memory/` or a
mount; the push carries the path. Tool schemas shape this —
`publish(file_path)` forces handle-passing.

But check principle 2 first: if B's only job is to read what A
wrote and call a tool, B is a courier. Collapsing is cleaner than
patching.

### Broadcast fan-out

One agent pushes events to many peers via repeated
`conversation__push_to_channel`. Worse: peers re-push.

Each receiver cold-starts with full identity + summaries. Ten
peers on a noisy feed = ten cold-starts per event. Re-push
amplifies geometrically.

**Reach for:** `file__append_feed` + RO mounts on consumers
(`recipes/shared-feed-meeting-point.md`). Fan-out via mount is one
watch registration per consumer, zero producer change. Push only
when the receiver must act on each event in its own session.

---

## Principle 4 — cadence that doesn't match signal

### Cadence without signal

A nightly reflection that fires on empty days. A 5min health check
on state that changes hourly. A `schedule.txt` picked for comfort.

Every fire pays full prompt assembly + summaries + bootstrap —
same cost whether or not it produces an action.

**Reach for:** intent-driven over cadence-driven
(`recipes/deferred-follow-up.md`). For periodic checks, raise the
interval until most fires produce action, or convert to
event-triggered.

Test: of the last N fires, how many produced an action?

One legitimate exception: absence detection. Silence emits no event
to trigger on, so a liveness or staleness check has to poll — keep
that fire as cheap as the check allows and reserve the expensive
session for the alarm path
(`recipes/reviewer-interviews-team.md` § Variants, *Passive
heartbeat*; `recipes/two-speed-agent.md` for the cost split).

### TTL churn

`idle_timeout` set to 2–5min on a channel where replies arrive
every 10–15min.

Cleanup fires on every gap. Next message cold-starts: fresh
identity assembly, bootstrap, up to three summaries re-injected.

**Reach for:** match the timer to expected reply cadence. 30min
(`1800000`) for user-conversational continuity. Single-shot
(`null`) when per-call isolation is the design.

### Peer channel held warm

A peer channel with `idle_timeout: 86400000` (24h), no lifecycle,
rarely used.

Context slot occupied between meaningful interactions — no
cleanup, no propagation.

**Reach for:** most peer channels are right at single-shot. Long
persistent TTLs only when there's genuine active back-and-forth.

---

## Principle 5 — reads that aren't focused

### Boiling the ocean

A research agent told *"look at our codebase and find issues"* that
reads every file. A skill that says *"read all of memory before
answering."* A peer query phrased *"tell me about your work."*

Context fills with material that doesn't shape the answer. More
work per turn, no better output.

**Reach for:** frame the question first. Search/grep before Read.
Hand sub-agents the tight question, not the broad task. Ask peers
*"is the X case handled?"* — not *"tell me about your work."*

---

## Principle 6 — building for users you don't know yet

### Agent with no users

Baking a recipient, address, or user list into the blueprint —
`email me every morning`, `default → summary to alice`, an inbound
list naming specific people.

It collapses three roles usually distinct — author, operator, runtime
user — and works only while they're the same person. The agent can't be
handed to anyone else; it has confused its author with its audience.

**Reach for:** the recipient is acquired at runtime (the message the
agent is answering, or discovery via `agent__list_participants` /
`agent__list_peers`) or set by the operator in Configure — never
authored. A scheduled fire reaches a person
by crossing into their cell — `conversation__push_to_participant`, or a
participant-bound `task__schedule` — or by a transport: a runtime move, not
a baked value. `what-is-an-agent.md`; `primitives.md` § The verb layer. The
worked positive shape — surface the capability, capture opt-in at runtime,
let a recipient-free detector deliver — is `recipes/opt-in-notification.md`.

---

## Smells the reviewer can spot

Quick heuristics for the Economy lens (`security-manager.md`):

- **Identity bulk** — aggregate word count high relative to scope.
- **Eager extensions** — declared in `capabilities.json`, no
  channel's prompt invokes them.
- **TTL extremes** — shorter than expected reply cadence (churn) or
  long without lifecycle (held warm).
- **Courier shape** — channels mostly receive payloads and call one
  tool with the same payload.
- **Push concentration** — one agent pushes to many peers; a feed
  would do.
- **Cadence-without-signal** — schedule whose last N fires produced
  no action.
- **Survey reads** — "read all of X before doing Y" without a
  narrowing step.

None are critical alone — they're judgment calls the operator owns
(`security-manager.md` § *Authority lives with the operator*).
Surface as concerns, explain impact, let the operator decide.
