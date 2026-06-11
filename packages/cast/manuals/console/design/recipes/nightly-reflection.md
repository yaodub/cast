# Nightly reflection and memory consolidation

**Use case.** Every evening, the agent looks back over the day's
conversations, surfaces patterns, and writes the one or two things
worth remembering. Over weeks, it's a journal you didn't have to
keep.

Underlying pattern: memory accumulates linearly. Without periodic
consolidation, old entries stay forever, the structure that worked
at 100 entries is wrong at 1000, cross-entry patterns never get
noticed, and bootstrap reads become a haystack to wade through. You
want the agent to apply its own judgment to its own state on a
regular cadence — compress what's been distilled, notice patterns,
surface things to the user when something warrants saying.

**The shape.** A scheduled fire (either `task__schedule` for
adaptive cadences, or a line in `props/schedule.txt` for an
operator-locked nightly time) lands into a dedicated `reflection`
channel. The channel is single-shot (`idle_timeout: null`) — each
fire is a fresh session with no resumption needed; reflection is
stateless work by nature. The channel's `disabled_tools` is narrow:
no peer push, no extension write tools, no `task__schedule` (the
fire arrives; the channel doesn't initiate further fires). The
question-driven directives live in `channels/reflection/prompt.md`:
*what surprised me? what did I get wrong? what patterns emerge
across this user's recent asks? what notes do I keep re-reading and
should consolidate?* Question-driven, not summarization-driven;
that's where the richer signal lives.

What the fire reads is a design choice; the access shape of the
recall verbs from a system-fire context matters (see
`primitives.md` § Recall). One well-fit composition: user-channel
`cleanup.md` writes distillations to known substrate paths during
conversation close — recognition in-context with the original
conversation, cheapest moment — and the reflection reads those
paths. Other shapes work; pick what fits.

`reflection` earns its own channel because it differs from
`default` on lifecycle (single-shot vs. persistent), trigger source
(schedule vs. user), tool surface (narrow vs. full), and substrate
posture (silent maintenance vs. user-facing) — four of the seven
rationale dimensions, well above the merge-or-split threshold.

Output goes to two places: reflection notes written to
`/memory/reflections/<date>.md` (using the SDK's Write tool — these
are journal notes, not a coordination feed peers watch, so Write is
the right tool rather than `file__append_feed`), and a one-line
audit entry appended to `/memory/reflection-log.md` recording what
the pass did. If something warrants the user's attention, the agent
ends with `push_to_channel` to the user's channel; otherwise it
wraps in `<cast:internal>` and exits.

**What this enables.** Memory that doesn't just grow but
iteratively improves. The agent applies its own intelligence to its
own substrate — compression, pattern-spotting, prioritization — on
a cadence the substrate deserves. Reflection that produces action
(a surface to the user, a structural memory edit) is the full
value; reflection that only ever stays internal is half the value.
The user benefits without re-prompting.

Whether the user channel's `bootstrap.md` references the latest
`/memory/reflections/<date>.md` is a design choice. A daily-check-in
agent might pull the previous night's reflection on each
conversation start so the agent enters with consolidated context;
an agent where reflections are pure maintenance keeps them invisible
to the user channel and the substrate accumulates silently. The
spec must say which.

**Where it doesn't fit.** Agents whose memory is small or stable
(consolidation creates more risk than it solves). Workflows where
operator approval is required for any memory change — use a
proposal-log variant rather than direct edits. Agents whose
user-facing voice shouldn't be interrupted by background insights —
restrict to silent-only.

**Variants.**

- *Cadence stack.* Nightly compresses recent activity. Weekly
  refactors memory *structure* (rename files, consolidate
  categories, prune dead anchors). Monthly reviews direction. Each
  cadence asks different questions on a different time horizon —
  the nightly pass shouldn't be doing structural refactor; the
  monthly shouldn't be touching last night's notes.
- *Persistent maintenance channel.* If the reflection log should be
  watch-eligible (e.g. an operator dashboard wants to subscribe),
  drop single-shot and use a persistent channel — you regain
  `file__append_feed` and can structure the reflection log as a feed
  rather than a plain markdown file. Most cases don't need this.
- *Interactive reflection.* Instead of background-only, the fire
  opens with `push_to_participant`: *"My nightly review surfaced a
  few things — got a minute?"* Different posture; worth its own
  variant rather than the default.
- *Preserve before destroy.* Reflection writes to parallel files
  rather than overwriting source, and archives raw entries before
  compressing. The cost of bad reflection is real; this discipline
  is the recipe's seatbelt.
- *Plan-fan-out (forward, not retrospective).* Same scheduling
  primitive, opposite direction. Instead of consolidating yesterday,
  the fire *plans today*: reads memory, decides what micro-tasks
  should run, and calls `task__schedule` N times to seed independent
  execution fires through the day. Each execution fire runs in its
  own fresh session, does one piece, returns. The retrospective fire
  (the default shape above) closes the loop in the evening and feeds
  tomorrow's planner. Useful for paced execution — language-tutor
  micro-lessons, dripfeed research, scheduled outreach. The teaching
  is *separating planning sessions from execution sessions*: the
  planner reads broad context and chooses; each executor stays
  narrow and focused.
- *Self-tuning recurring task.* A different shape of fire on the
  same primitive: a recurring task that adapts itself rather than
  consolidating memory. Each fire reads past run logs in
  `/memory/run-log.jsonl`, does its primary work, writes a brief
  self-evaluation back ("surfaced 3 items, user engaged with 1, two
  seemed off"), and — if the schedule itself should change — calls
  `task__schedule` to reschedule with refined parameters (different
  time, different target window, different focus area). User
  pushback in chat is the strongest learning signal: when the user
  says *"don't surface that kind again,"* the agent records the
  rule into a filter file the next fire reads as part of its
  context. The cron adapts; you don't re-tune it manually. For
  tasks that must run at exactly fixed times, use `props/schedule.txt`
  instead — operator-locked, agent-immutable.

**Composes.** `task__schedule`, single-shot channel with narrow
`disabled_tools`, `<cast:internal>` (silent default),
`conversation__list_summaries` and `message_log__search` (recall
inputs), `/memory/` (substrate and destination), `push_to_channel`
(when reflection produces an action worth surfacing).

**Cross-link.** This is the single-agent counterpart to
[Reviewer that interviews the team](reviewer-interviews-team.md) —
both are scheduled reflection, but this one's input is the agent's
own memory and the other's is peer Q&A.
