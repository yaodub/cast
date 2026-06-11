# Two-speed agent

**Use case.** Something needs checking far more often than it
changes — a feed, a queue, a threshold — and the synthesis that
makes the signal worth having needs a strong model, broad context,
and time. Run the strong model on the fast cadence and you pay
synthesis prices for "nothing new" forty-seven times a day. Drop
the cadence and you miss the window where reacting mattered. Split
the agent into two speeds instead: a cheap fast loop that only
*detects*, and an expensive slow loop that only fires *on signal*.

This is `economics.md` § 4 (cadence matches signal) reconciled with
the case where the cadence genuinely can't drop: when most fires
will find nothing, make the finding-nothing fire nearly free.

**The shape — two channels, two models, one agent.**

- `sentinel` — single-shot (`idle_timeout: null`), fired by a
  `props/schedule.txt` line on the fast cadence. `disabled_tools`
  cuts it to the bone: no `task__*`, no extension writes — it
  reads its source, applies one binary judgment, and exits. The
  channel `prompt.md` is correspondingly small: *what counts as
  signal* (pointing at `/memory/signal-criteria.md` so the bar is
  tunable without a blueprint edit), wrap everything in
  `<cast:internal>`, and on a real hit do exactly two things —
  `file__append_feed` one structured row to
  `/memory/signals.jsonl`, and `conversation__push_to_channel` a
  one-line nudge to `synthesis` (no `target_agent` — intra-agent).
- `synthesis` — persistent, modest `idle_timeout`,
  `lifecycle: "full"`. Its `bootstrap.md` registers
  `file__watch_feed` on `/memory/signals.jsonl` and reads any
  unprocessed backlog. The feed carries the data and the cursor;
  the sentinel's push is the interrupt that wakes the channel when
  it's cold (a watch survives expiry and catches up on next spawn,
  but something has to *cause* the spawn — the push is that
  something). Warm, the `<cast:watch>` fire alone is enough and
  the push is a cheap duplicate the prompt teaches it to ignore.
- **The model split lives in operator config**, not the blueprint:
  `config/agent.json` —

  ```json
  { "modelOverrides": [ { "channel": "sentinel", "model": "<small-fast-model>" } ] }
  ```

  Top-level `model` (or a second override entry) keeps `synthesis`
  on the strong tier. This is Configure's lane — Design names the
  channel split and the intended tiers in the handoff; Configure
  writes the override (`../operator-values.md`).

**Why the split is honest.** The sentinel's job is deliberately
beneath the strong model: one comparison against named criteria,
emitting a row. That's what makes the small model safe there — and
the design test is exactly that. If writing the sentinel's prompt
requires judgment words (*"assess whether this is significant"*),
the detection itself needs the strong model and this recipe doesn't
fit; if it can be phrased as a check (*"does the count exceed N;
does the new row match any watch term"*), it tiers cleanly. Push
the judgment to the criteria file, authored by the strong model and
the user, and let the cheap loop merely apply it.

**What this enables.** High-frequency vigilance at sustainable
cost. The expensive context — identity layers, memory, synthesis
reasoning — is assembled only on the fires that carry signal; the
empty checks cost a minimal prompt on a cheap model. The criteria
file makes sensitivity a runtime knob: *"stop flagging those"* is a
memory edit from the user channel, read by the next sentinel fire —
the same adaptation loop as
[Quiet processing channel](quiet-processing-channel.md)'s filters.

**Where it doesn't fit.** Detection that *is* judgment — a small
model's false negatives are silent, and no synthesis pass can
recover a signal the sentinel never recorded. Sources that are
already event-shaped — a feed someone appends to can be watched
directly; don't poll what can fire (`../anti-patterns.md` §
Cadence without signal). Cadences that could simply drop — fix the
cadence first; tier the model only when the residual frequency is
real.

**Variants.**

- *Phase tiering.* `modelOverrides` entries take an optional
  `phase` (`bootstrap` / `cleanup`): a channel whose lifecycle
  prompts are mechanical (read these files; write this summary
  shape) can run them on the cheap tier while turns stay on the
  strong one. Same recipe at a finer grain.
- *Escalation ladder.* Three speeds: sentinel appends, a mid-tier
  channel triages rows into routine/notable, and only notable
  wakes the strong synthesis. Each rung is the same
  channel + override pair; add rungs only when the middle tier
  provably filters.
- *Sentinel for the airlock.* The cheap loop decides what's worth
  a parse before a quarantined parser spends a session on it —
  compose with
  [Untrusted-content airlock](untrusted-content-airlock.md).

**Composes.** `props/schedule.txt` (the fast cadence,
operator-locked), single-shot channel + narrow `disabled_tools`
(the sentinel's cage), `config/agent.json::modelOverrides`
(per-channel, optionally per-phase — Configure's lane),
`file__append_feed` / `file__watch_feed` (data + cursor),
intra-agent push (the cold-wake interrupt), `<cast:internal>`
(empty fires surface nothing), `/memory/signal-criteria.md`
(runtime-tunable bar).

**Cross-link.** Grown from the *cheap sentinel detector* variant
of [Opt-in notification](opt-in-notification.md) — that recipe
decides *who hears about it*, this one decides *what it costs to
notice*. [Quiet processing channel](quiet-processing-channel.md)
is the same editorial posture with one model;
[Nightly reflection](nightly-reflection.md)'s self-tuning variant
supplies the loop that retunes the criteria file from outcomes.
