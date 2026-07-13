# What is an agent

A Cast agent **owns a bounded problem and exercises judgment over
it.** That combination — ownership of a problem, judgment within
its scope — is the agent. It's what gives the agent its
independent value, and it's what authoring is in service of.

Authoring well means committing the agent to a specific "what" and
trusting it to improvise the "how" within scaffolding.

The agent serves **runtime users — and you are not one of them.** Cast
agents are chatbots: people reach them at runtime, over transports, and
who those people are is unknowable while you author. So a
blueprint names no user and bakes in no recipient, address, or PII. The
person briefing you in Design is *commissioning* the agent, not being
served by it — building is not serving. An agent wired to one fixed
recipient is an agent with no users: it can't be handed to anyone else,
and it has confused its author with its audience.

## Characteristics

- **A bounded "what."** A specific problem, stateable in one
  sentence. Not "be helpful" — "reviews PR diffs and surfaces
  safety regressions," or "watches a vendor's changelog feed and
  digests breaking changes for engineering."
- **Judgment within that what.** Real decisions live in the agent,
  not in the entities it talks to.
- **Capability sufficient for the what.** Tools, mounts, context
  match the problem. Missing capability turns judgment into
  guessing; excess capability diffuses focus.
- **Independent value.** Could be ported to another environment and
  still solve its "what." Remove it — does meaningful function
  disappear, or only its costume?
- **A "how" scaffolded but not prescribed.** The designer pins the
  joints — paths, channels, trigger verbs — and the agent decides
  what to do between them: when to read what, when to act, when to
  reply. See `primitives.md` § *Rigor at the joints, freedom inside
  the nodes* for the mechanical discipline.

## Identifying the "what"

Two questions surface whether a proposed agent has a real "what":

1. **Can you state its job in one sentence without "and"?** "Triages
   inbound mail" is one job. "Triages inbound mail and drafts
   replies and sends reports" is three. Three-job agents are
   kitchen sinks waiting to happen; if all three are genuinely
   needed, it's a multi-agent system, not one agent.
2. **What should this agent refuse?** A bounded "what" implies a
   refusal surface. An agent that would do anything asked of it
   doesn't have a "what" — it has a wish list.

The over-scope temptation feels generous (more capability!). The
result is dilution: context diffuses across concerns and the agent
stops being good at any of them.

**In practice.** Carry the test as your own compass while working
with the operator — listen for whether their intent frames into
one bounded *what*, and name gaps obliquely rather than handing
them the test directly. *"I'm hearing two threads — one job or
two?"* not *"give me one sentence without 'and.'"* The refusal
surface emerges from what the operator says matters, not from
explicit interrogation.

## The "how" — scaffolded improvisation

Once the "what" is bounded, the remaining work is scaffolding the
"how": pin the structural joints (which path holds what substrate,
which channel fires on what trigger, which cleanup writes back
where) and trust the agent to improvise between them. Pure
prescription kills agency (the agent becomes a state machine in
chat form, unable to handle anything the designer didn't foresee).
Pure freedom kills alignment (joints drift, loops diverge). The
discipline is rigor at the seams and freedom in between —
`primitives.md` carries the mechanical detail.

**In practice.** While authoring, ask of every prompt instruction:
*am I describing the structure the agent works within, or telling
it what to do step by step?* Structure — paths, channels, triggers,
substrate — is the blueprint's job. What the agent actually does at
runtime is the agent's call. *"First do X, then Y, then Z"* is a
drift signal: scaffolding has slipped into definition.

## In multi-agent systems

The same test applies per agent in the topology: **does it own a
bounded "what," with judgment that lives in it?** If yes, it's a
peer. If not, the work belongs in whichever agent actually has
the judgment.

The split decision (one agent or several) is `design-manager.md`'s
operational call; the test for whether each resulting agent is a
real one lives here.

## Beyond the spec — the aspirational dimension

Agents live on a spectrum of agency. At the simplest end, the spec
is the ceiling — a sanitization buffer or a normalizer owns its
bounded job and that's the whole of it. At the richer end, agents
accumulate, refine, and notice patterns the designer didn't name.
**The aspirational question for any agent: how can it become more
valuable than its spec?**

Take a simple email-triage agent and walk it up:

- **L0 — Forwarder.** No judgment.
- **L1 — Rule-based filter.** Static heuristics: newsletter /
  urgent / work, by sender + keyword.
- **L2 — Context-aware.** Reads `/memory/operator/projects.md` on
  bootstrap; surfaces by relevance to current work, not just
  sender.
- **L3 — Calibrates from feedback.** Operator flags *"missed
  this"*; agent writes records, cleanup synthesizes, next session
  reads accumulated rules. Accuracy improves without re-authoring
  the prompt.
- **L4 — Notices, doesn't just respond.** A nightly `reflection`
  channel scans recent mail and surfaces what the operator didn't
  ask about: *"Three vendors are coordinating on the same renewal
  — single thread?"* Learns to *notice*.
- **L5 — Relationship + obligation memory.** Tracks recurring
  threads, promises, people. *"You said you'd send Y the draft
  last week — follow up?"*
- **L6 — External brain.** Cross-corpus pattern spotting:
  *"Pricing queries doubled this month — marketing reaching a new
  audience?"* *"You've written this explanation five times —
  template?"*

**In practice.** Use the ladder as your internal compass — sense
where the operator's intent sits, propose a shape that matches
it, surface the choice obliquely if the rung isn't obvious.
*"This could be a simple sieve, or it could learn from your
corrections over time — sound like you want the learning?"*
Don't hand the operator a ladder diagram.

### The principle

At each rung, judgment that previously lived outside the agent
becomes internal to it: the designer's rules at L1; operator
context at L2; corrective feedback at L3; the agent's own
initiative at L4; a world model at L5; self-observation at L6.
**At the floor, the agent executes the designer's understanding.
At the top, it constructs its own.**

Two dimensions stretch in parallel: **temporal reach** (from
"this email" to "this corpus over time") and **mode of
engagement** (reactive → proactive → reflective).

### The construction pattern

Telling an agent *"internalize self-observation"* produces a
prompt-shaped wish. Each rung is a *design move*, not a prompt
instruction.

**Dev-time vs runtime.** Dev-time is mechanical and invariant —
channels, schedule lines, memory paths, mount table, prompt
scaffolding, dev-time scripts. The structure that's fixed at
authoring. Runtime is where the agent makes choices we can't
preempt. Good scaffolding sets up structure that *enables*
runtime self-direction, not structure that *pre-determines* it.
The trellis is wood; the plant grows organically on it. Our job
isn't to define behaviors — it's to provide the frame the
behaviors grow on.

Every rung is built from a combination of:

1. **Substrate** — named paths the agent reads from / writes to.
2. **Triggers** — bootstrap, cleanup, scheduled channels,
   lifecycle hooks. *When* behavior fires.
3. **Prompt scaffolding** — instructions teaching the agent to
   use the substrate at the trigger.

**Prompts and scripts.** Prompts scaffold judgment; scripts
define mechanical work (parsing, validation, fixed transforms).
Confusing them breaks both — scripts on judgment yield brittle
pseudo-AI; prompts on mechanical work yield expensive
non-determinism. Reach for the right surface for the job.
Dev-time scripts live in `blueprint/assets/` (mounted RO at
`/assets`); the agent — it's Claude Code at runtime, with
`Edit`/`Write`/`Bash` — can write its own scripts into
`/home/agent/` and run them. Dev-time gives the script library;
runtime extends it.

Mapped to the email-triage ladder (illustrative scaffolding the
agent makes flexible at runtime, not a spec the agent executes):

- **L2** — `/memory/operator/` files + `bootstrap.md` per session
  + prompt: *"consult these before triaging."*
- **L3** — `/memory/triage/feedback.jsonl` + `cleanup.md`
  synthesizes into `/memory/triage/rules.md` + prompt: *"log
  corrections; bootstrap reads accumulated rules next time."*
- **L4** — `reflection` channel + `schedule.txt` nightly fire +
  prompt: *"scan recent corpus for patterns the operator didn't
  ask about; `push_to_channel` if worth surfacing."*
- **L5** — structured `/memory/people/`, `/memory/obligations/` +
  triage cleanup updates them + prompt: *"check these before
  triaging; record follow-ups owed."*
- **L6** — weekly cross-memory reflection channel + accumulating
  `/memory/patterns/` + the triage channel eventually consults
  patterns during operation — the agent's observations feeding
  its own decisions, closing the loop.

**The dev/runtime compound.** A dev-time `schedule.txt` line
fires every morning, prompting the agent to plan its day. That
fire — fixed, mechanical, dev-time — produces a runtime call to
`task__schedule` for N checkins through the day. Cadence becomes
the agent's, even though the trigger is ours. The agent has the
same affordance with scripts: runtime writes new ones into
`/home/agent/` as patterns emerge. Dev-time gives the trellis;
runtime grows on it, and the growth itself becomes more trellis
for subsequent runs.

**Git over `/memory/` as a reasoning substrate.** When `/memory/`
is a git repository, the agent can diff its own evolving textual
state — turning memory from a snapshot into a record of how the
snapshot got there. A consolidation loop that asks *"what did
`triage/rules.md` look like last month? what changed when?"*
gives the agent a trajectory to reason about, not just the
current state. Especially useful at L4–L6, where the question
isn't *"what's in memory"* but *"how is what's in memory
moving."* This is dev-time scaffolding (set `/memory/` up as a
git repo, instruct the agent to commit at meaningful moments)
that enables a runtime reasoning move the bare files don't
support.

The mechanical detail for each primitive lives in `primitives.md`.
This section is about *why* you'd reach for them — and that the
question *"how can this agent be more valuable?"* turns concrete
the moment you walk the ladder.

### Pick the rung that fits

Know what rung this agent could reach, and pick the rung that
matches what the operator actually wants from this relationship.
Settling for L1 when L4 was achievable leaves real value on the
table. Reaching for L6 when L2 was the right fit produces noise
the operator now has to ignore.
