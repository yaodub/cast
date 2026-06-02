# Design — economics: where tokens get spent

Foundation reading alongside `primitives.md` and `operator-values.md`.
Primitives name *what the building blocks are*. Recipes name *patterns
that compose them well*. This manual names *what each design choice
costs*.

Token costs in Cast are not paid once; they're paid on every turn,
every fire, every conversation, for the life of the agent. A 5KB
identity layer pays 5KB per fire forever. A schedule that fires every
5min when the signal changes hourly pays 12 wasted fires per hour
indefinitely. A broadcast to 10 peers pays 10 cold-starts per push.
Bad economy compounds; good economy compounds too.

The single discipline:

> **Every token in context should be load-bearing for the next decision.**

Five principles fall out of it. The rest of this manual is each one.

1. **Load-bearing context** — if removing a line wouldn't change the
   agent's next action, it's rent.
2. **Seams follow judgment, not task steps.**
3. **Communication carries conclusions, not deliberation.**
4. **Cadence matches signal rate, not anxiety.**
5. **Read with a question, not as a survey.**

---

## 1. Load-bearing context

The framework assembles a fixed set of layers on every turn (see
`primitives.md` § *The artifact*). Every line in those layers rides
every conversation, for the life of the agent.

Where this gets violated:

- **Identity prose that prescribes instead of scaffolds.** A
  multi-page `prompt.md` that anticipates every edge case rides
  every turn. Scaffolding principle (`what-is-an-agent.md`) is the
  economic version too: provide structure, not definition.
- **`peers.md` listing peers the agent never queries.** Layer 6;
  dead weight if the agent doesn't reach for it in normal operation.
- **`skills.md` written as tutorial.** Every line costs tokens
  (`design.md`). One-line bullets, not pedagogy.
- **Eager capability load.** Extensions enabled globally when only
  one channel uses them. Tool descriptions ride every conversation
  that loads the tool. Use `disabled_tools` per channel.
- **Eager `bootstrap.md`.** Reading five memory files and narrating
  them on first turn loads context that may not be needed this
  conversation. Point at `/memory/`, let the agent Read mid-turn on
  demand.
- **Heavy `agent-context.md`.** Layer 9, assembled *every turn*.
  Verbose service-injected content multiplies by every conversation.
- **Oversized summaries.** Up to three previous-session summaries
  auto-inject per turn on the same `(channel, participant)`. Verbose
  cleanup writes compound three-fold.

Test: for each layer, ask *would the agent still pick the right
action this turn if this line were removed?* If yes, the line is
rent.

## 2. Seams follow judgment, not task steps

A well-placed agent boundary marks a place where the work genuinely
differs on the other side — different judgment, different access,
different scope, different trust posture. A poorly-placed boundary
chops one piece of work into stages and pays full agent overhead at
each chop.

The org analogy is direct. Bad org design carves roles by *step in
a process* — writer drafts, editor passes through, publisher
submits; three roles, two of which add no judgment. Good org design
carves by *what only that role can do or decide*:

- The **reviewer** applies a cross-cut no individual contributor
  has.
- The **specialist** holds expertise or credentials the caller
  doesn't.
- The **filter** decides which events deserve escalation, and that
  decision is itself the value.

Test before splitting: *if I removed this agent and gave its work
back to the role on either side, would anything be lost?* If no,
the role was a courier — collapse it. If yes, name what's lost;
that's the agent's mandate.

The recipes (`recipes/`) are all organized around real seams.
`specialist-behind-query` separates by access. `reviewer-interviews-team`
by cross-cutting judgment. `quiet-processing-channel` by filtering
responsibility. None are "agent A does step 1, agent B does step 2."

See `anti-patterns.md` § *Courier agent* and § *Process-decomposition
seam*.

## 3. Communication carries conclusions, not deliberation

When agent A hands to B, the handoff is the *result* — a decision,
a delta, an answer — not the trail that produced it. If B needs the
reasoning, B asks. Otherwise A's transcript becomes B's
prompt-context tax on a question B didn't need to solve.

Two ends of the spectrum:

- **Verbatim deliberation.** A long "here's what I thought through"
  message sent to B, which only needed the conclusion.
- **Verbatim payload.** A 5KB article handed to a "publisher" agent
  whose only action is to call `publish(text)`. Same content paid
  three times: A's output, message body, B's input.

Verbatim-payload has a structural fix: **pass by reference, not by
value**. Producer writes to `/memory/` or a mount; consumer's tool
accepts a path. Service tool schemas shape this — `publish(file_path)`
forces handle-passing; `publish(text)` forces every caller to pay
for the content twice.

But the deeper fix is often principle 2: if B's only job is
relaying A's output to a tool, there's no real seam — either A
publishes itself (collapse) or B does real publishing work
(formatting, scheduling, audience targeting — a real seam).
Pass-by-reference patches the cost; collapsing removes it.

For deliberation: keep `<cast:query>` and push payloads
high-density. Q/A answers land in the *sender's* context, so
verbose answers double-tax. R/A drops the answer entirely.

See `anti-patterns.md` § *Verbatim narration* and § *Verbatim payload*.

## 4. Cadence matches signal rate, not anxiety

Schedules are a contract about *when new information is likely to
exist*. A nightly reflection that fires on empty days pays full
prompt assembly + summaries for zero output. A 5min health check on
state that changes hourly does the same 12× per hour, forever.

Fire when there's plausibly something to react to, not on a comfort
interval. The recipes show the spectrum:

- `deferred-follow-up` — efficient end: one user moment seeds one
  future fire.
- `nightly-reflection` — cadence-based, useful only when there's
  plausibly something to reflect on.
- `schedule.txt` cron — picks a comfortable cadence regardless of
  signal.

`idle_timeout` is the same principle inside a conversation. Too
short → cleanup/bootstrap fires on every gap (re-injects up to
three summaries each time). Too long → holds the slot warm between
meaningful interactions.

Test for any schedule: of the last N fires, how many produced an
action? Mostly none → over-eager; raise the interval or convert to
event-triggered.

See `anti-patterns.md` § *Cadence without signal*.

## 5. Read with a question, not as a survey

"Boiling the ocean" — research agents told to *look at everything*,
skills that say *read all of memory before answering*, bootstraps
that load five files just in case. Let the question shape the read.
Narrow before you widen. Search/grep before Read. Ask a peer who
already has the answer instead of re-deriving.

The inverse of eager bootstrap (principle 1): bootstrap is "load
everything at session start"; survey-mode is "load everything
mid-turn because the question wasn't framed." Same disease,
different organ.

Teach narrow-first patterns in prompts and skills. When delegating,
hand the sub-agent the tight question, not the broad task. When
asking a peer, frame *"is the X case handled?"* — not *"tell me
about your work."*

See `anti-patterns.md` § *Boiling the ocean*.

---

## Two corollaries

- **Trust the seam.** Don't re-derive what a peer already
  established; don't re-send what the peer can infer.
- **The cheapest token is the one you don't load.** Most wins
  aren't compressing context — they're *not assembling it in the
  first place*.

## Where each principle is felt hardest

| Principle | Highest-leverage surface |
|---|---|
| 1. Load-bearing context | `identity/*.md`, `bootstrap.md`, `agent-context.md`, capabilities |
| 2. Seams follow judgment | Multi-agent decomposition, channel design |
| 3. Conclusions not deliberation | `<cast:query>` payloads, push text, tool signatures |
| 4. Cadence matches signal | `schedule.txt`, `task__schedule`, `idle_timeout` |
| 5. Read with a question | `prompt.md`, `skills.md`, bootstrap composition |

Biggest savings cluster on 1 and 2 — context that rides every turn
forever, and seams that pay full agent overhead at every chop. 3–5
are per-turn margin.

## Where this is enforced

- **All-Agents Design** applies it at *design time* (`design-manager.md`).
  Seam placement is the central call — fold before splitting.
- **All-Agents Review** applies it as the *Economy lens*, the fourth
  lens of the QA gate (`security-manager.md`). Surfaces bad economy
  as concerns the operator can act on.

Designer is the upstream fix; reviewer is the safety net. Both
speak the vocabulary in this manual and `anti-patterns.md`.

## Further reading

- `anti-patterns.md` — the smells the principles correct, with
  worked examples and which recipe to reach for instead.
- `recipes/` — read with the economics lens: each recipe's seam
  exists because a real categorical difference justifies it.
- `primitives.md` — vocabulary; cost notes inline where they help
  pick a primitive.
- `what-is-an-agent.md` — the scaffolding principle is the *what
  for* behind principle 1.
