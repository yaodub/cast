# Agent introspection

A Claude Code session in which the operator and Claude Code help an agent look at itself — its runtime, its memory, its design — and surface where it could grow into more of itself.

[Advanced mode](../MODES.md) is the only place this can happen. It needs the full read surface across blueprint, runtime state, SDK transcripts, and memory. Consoles can't see across all of these; advanced mode can.

## What this is, and is not

Not an audit. Audit asks *"what's broken?"* Introspection asks *"how can this agent become more itself?"* Mechanical signals — unused capabilities, stranded conversations, channel sprawl — are evidence feeding aspirational proposals, never the headline.

Not a security review. The [Security Manager](../console/security-manager.md) console audits design and posture inside a sandbox. Introspection compares runtime against intent with full host read.

Not implementation. `/cast-build <folder>` or direct host-side edit is where blueprint proposals get built. Introspection (`/cast-refine`) is upstream of build.

Not agent-side reflection. The [nightly-reflection recipe](../console/design/recipes/nightly-reflection.md) is the agent reading its own memory mid-life, on cadence. Introspection composes the operator, Claude Code, and the agent's full accumulated state at once — outside perspective the agent can't get from inside a single conversation.

## What introspection produces

A single output: **blueprint refinement.** Proposals to sharpen the agent's instructions — identity, channels, capabilities, memory rules, cadences.

Runtime alignment is downstream. After the blueprint changes ship, the agent's existing maintenance cadences (cleanup loop, nightly consolidation, weekly audit) bring accumulated state into alignment with the new instructions. That's the agent's job, not introspection's. We don't perform routine maintenance on runtime data.

**Corollary — drift is a blueprint problem.** If the agent's runtime has drifted from blueprint, that's almost always because the instructions driving the cadences are too weak. The fix lives upstream: sharpen the cadence instructions, then let the agent catch up. Reaching directly into runtime memory to fix what looks like state drift overwrites the agent's authorship of its own state without recording the change in `context.jsonl` or any scratchpad bridge — the next bootstrap reads the rewritten file as if the agent wrote it, but the shape won't match what it remembers.

The workflow:

```
observe (agent runs in production)
  ↓
introspect (this doc) — sharpen the blueprint
  ↓
ship blueprint (via /cast-build <folder> or direct host-side edit)
  ↓
runtime alignment
  ├─ default: agent's cadences absorb the change over time
  └─ optional: subagent-driven migration (see below) for immediate alignment
```

## When to introspect

- The agent has weeks of real run history, not days.
- The operator senses drift, friction, or untapped potential.
- A new use case has emerged that wasn't in the original design.
- Before a major reshape — understand the current shape before changing it.
- On cadence — periodic check-ins for live agents.

## When not to

- Agent too new to have a meaningful run history.
- Agent already mid-redesign.
- Operator's intent has just shifted dramatically — let it settle.
- For a security concern — the Review console is the right surface.

## Disciplines

Five rules that govern the session. They are not suggestions.

**Ask first.** Before reading anything, ask the operator: what should this agent become? What's changed since it was designed? Where's the friction? Introspection without operator-intent is projection.

**Evidence-cite per proposal.** Every proposal cites the specific conversation, memory entry, config row, or design-vs-execution gap that motivated it. No "you could add X" without grounding. This is the discipline that separates thoughtful coaching from plausible-sounding filler.

**Bias toward sharpening.** When proposals tie, prefer the one that makes the agent more itself over the one that makes it more capable. Order of preference: *sharpen* (tighten what's there) → *subtract* (stop what doesn't fit) → *compose* (pair with a peer, split a role) → *add* (when reach is genuinely lacking). Subtraction is first-class, not a fallback. The vocabulary for *compose* and *add* moves lives in [`primitives.md`](../console/design/primitives.md) — channels, peers, services, schedules, push/query patterns.

**Propose, don't apply.** Read-only on runtime memory. Output is blueprint proposals. Implementation is `/cast-build <folder>` or direct host-side edit. The one write exception is the introspection artifact itself — operator-authored, at a path the agent doesn't read from. Never edit agent-authored runtime memory directly; if immediate alignment is needed after the blueprint ships, spawn a subagent that acts in the agent's voice (see *Optional: subagent-driven migration*).

**Mechanical as evidence layer.** Mechanical lenses run first as evidence-gathering. Anomalies surface as inputs to aspirational proposals, never as findings standing alone.

## The read surface

Introspection compares four layers. Each lens combines them differently. For the canonical agent-folder layout (what each directory contains and who owns it), see [`agent-architecture.md`](agent-architecture.md). For schema-level reference and query patterns, see the debugging-pipeline reference doc — it's failure-investigation oriented but the data locations are reusable.

| Layer | Where it lives | What it tells you |
|---|---|---|
| **Intent** — what the agent was designed to be | `blueprint/identity/`, `blueprint/channels/<name>/`, `blueprint/props/capabilities.json`, `blueprint/service/manifest.json` | Declared persona, channels, capabilities, peers, service shape |
| **Behavior** — what the agent actually did | `state/agent.db` (`message_log`, `events`, `outbound_requests`, `inbound_requests`), `sessions/<conv-key>/.../*.jsonl` | Conversations, tool calls, errors, lifecycle, cross-agent traffic |
| **Memory** — what the agent has learned about itself | `memory/` (persistent memory; sibling of `home/`, not under it) | Reflections, distillations, accumulated context |
| **Operator state** — what the operator has done to it | `state/admin-changelog.jsonl`, `config/`, `state/tasks.json` | Config mutations, secrets actions, scheduled tasks |

**Cross-agent traffic.** Push text from A to B lives in B's `message_log` (with `sender = A`); `gateway.db` sees only external transports, and A's `outbound_pushes` holds correlation only — `request_id`, `target_channel`, no text. To reconstruct A↔B, read each side's `message_log` filtered by the other as `sender`. Session transcripts at `sessions/<conv-key>/.../*.jsonl` hold the runner's view including tool inputs/outputs.

Mechanical signals (unused capabilities, stranded conversations, error patterns) come from Behavior and Operator state. Aspirational proposals layer Intent and Memory on top to ask: *where does Behavior fall short of Intent, and where has the agent itself already noticed that gap via Memory?*

## Lenses

Each lens names a question and the kind of evidence it consumes. Run mechanically first; surface to the operator only when the evidence supports a proposal.

**Usage shape.** What is the operator actually using this agent for? What patterns recur that the agent could anticipate, compress, or sharpen? Reads conversation history, accumulated memory, scheduled-task run-logs.

**Operator burden.** Where is the operator still doing manual work the agent could absorb? Where is configuration churning? Reads the admin changelog, intervention patterns, scheduled-task gaps.

**Identity coherence.** Does the declared identity match observed behavior? Should the identity layers be sharpened, expanded, or split? Reads the identity layers against samples of actual conversation.

**Capability fit.** Of declared tools, channels, skills, peers: which are used? Which gather dust? Which are absent but reached for? Reads declared capabilities against tool invocations and conversation content. If the agent has a service, see [`service-development.md`](service-development.md).

**Composition.** Is one agent doing two agents' jobs poorly? Is the peer graph supporting the work, or just declared? Reads peer and service declarations against the realized request graph. Vocabulary: [`primitives.md`](../console/design/primitives.md); worked patterns: [`multi-agent-composition.md`](../console/design/multi-agent-composition.md).

**Memory architecture.** Is memory serving the agent or just accumulating? Is reflection cadence alive? Are distillations being reused? Reads memory contents, reflection log, recall-verb invocations.

**Subtraction candidates.** What should stop? Capability sprawl, prompt drift, dead channels, abandoned tasks, dormant peers. Reads the inverse of the usage and capability lenses — declared but unused, configured but never visited.

**Adjacent moves.** Given this agent's shape, which composition patterns from [the recipes catalog](../console/design/recipes/) are the natural next step? Reads the agent's shape against the recipes vocabulary.

## Session flow

1. **Scope and intent.** Confirm scope: single-agent (which) or server. Ask the operator about intent, recent changes, and any specific concerns — or take an open survey if they don't have one.

2. **Survey pass.** Run mechanical lenses to gather evidence. Don't surface raw findings yet; hold them as evidence inputs.

3. **Aspirational reading.** Read the agent's blueprint, identity, recent memory, sample of conversations. Build a coherent picture of what this agent *is* before proposing what it could become.

4. **Proposal generation.** Group evidence under aspirational lenses. Produce proposals, each naming a growth direction (sharpen / subtract / compose / add), citing the motivating evidence, and sketching the shape of the change — not the implementation.

5. **Operator dialogue.** Present proposals. Let the operator pull threads, push back, ask for more evidence, dismiss. Refine and iterate. The operator's reactions are themselves evidence about intent.

6. **Write the artifact.** Consolidate into the introspection document. Hand off — the operator takes proposals to `/cast-build <folder>` or direct host-side edit to ship the blueprint changes. If immediate runtime alignment is needed, an optional subagent-driven migration follows (see *Optional: subagent-driven migration* below).

## Output

Per-agent: `$CAST_AGENTS_DIR/<name>/introspection/<YYYY-MM-DD>.md` (default `~/.cast/agents/<name>/introspection/`)

Server-scope: `$CAST_CONFIG_DIR/../introspection/<YYYY-MM-DD>.md` (default `~/.cast/introspection/`)

The artifact's structure:

- **Intent.** One paragraph capturing the operator's stated intent for this agent at session start.
- **Where this agent is.** A few paragraphs describing what the agent is actually doing, grounded in evidence.
- **Proposals.** Each proposal: title, growth direction, evidence citations, shape of the change.
- **Discarded threads.** Considered and dismissed, with the reason. Discarded threads matter — they prevent re-raising the same proposal next session.

## Optional: subagent-driven migration

After the blueprint ships, the agent's existing cadences (cleanup loop, weekly audit, nightly consolidation) align runtime state to the new instructions on their natural schedule. When that's too slow — the next cleanup may be hours away, the weekly audit days — the operator can spawn a subagent to perform the migration immediately, **in the shoes of the agent**.

This is a distinct task from blueprint refinement. The boundary is preserved because the subagent takes on the *agent's* identity, not the operator's:

- The subagent's brief frames it as the agent: *"You are `<agent name>`. Your blueprint's tracker schema is now two-axis (see updated `skills.md`). Reslot `tracker.md` to match. Record the migration in `context.jsonl` as you would any cleanup-loop write."*
- Writes happen in the agent's voice, with the agent's contextual judgment about how to slot the data — not the operator's projection of how it should be slotted.
- The migration is recorded with the same authorship semantics as the agent's own writes.
- The subagent exits when the migration is done. No scope creep into other agent work.

**When to spawn one.** Alignment can't wait for the agent's cadences — an upcoming check-in will run against stale state, a deadline depends on the migration being current, or the change is large enough that the operator wants it deliberate rather than incremental.

**What to skip.** Migrations the agent will absorb naturally and soon. Don't spawn a subagent for state the next cleanup will catch.

## Server scope

Server-scope introspection helps the operator see the *fleet*. Each agent's self-view contributes; Claude Code reads each agent's blueprint and recent state, then synthesizes across. For ACL coherence and routing analysis between agents, [`cross-agent-acl.md`](../console/cross-agent-acl.md) is the canonical reference.

The lenses shift to the composition layer:

| Per-agent lens | Server-scope equivalent |
|---|---|
| Usage shape | Cross-agent usage distribution |
| Capability fit | Capability distribution across the fleet |
| Composition | Role architecture — does the fleet's shape fit the operator's needs? |
| Memory architecture | Memory duplication or leakage across agents |
| Operator burden | Cross-cutting friction recurring across agents |
| Subtraction candidates | Redundant agents, role overlap, dormant tenants |
| Adjacent moves | Multi-agent recipes (reviewer-interviews-team, shared-feed-meeting-point) |

Artifact structure stays the same; the unit of analysis becomes the fleet rather than the individual agent.

## A note on cadence

Introspection isn't a one-shot. The richest value comes from a sequence over time — each session's proposals seed the next, discarded threads accumulate into shared understanding, and the operator's intent itself sharpens through the dialogue.

## Ground truth

When the framing here leaves you unsure about what's spec-defined vs implementation, the canonical reference is [`packages/agent-schema/src/v1/SPEC.md`](../../../agent-schema/src/v1/SPEC.md). Reach for it when terminology matters or when proposals depend on contract-level details the framing docs don't fully specify.
