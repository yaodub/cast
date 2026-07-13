# Opt-in notification

**Use case.** An agent that watches something — a feed, a threshold, an
external signal — and tells *you* when it matters. The catch: *you* is
whoever asked to be told, not a name the author wrote into the blueprint.
One person subscribes today, a teammate subscribes next week, the agent
gets handed to a new owner, and it still works. The recipient is a
runtime fact, not a build-time constant.

**Building an agent, not a cron job.** A cron job hardwires who to
notify — *"email me every morning"* is a cron job wearing an agent's
clothes. An agent *has the capability* to reach people and *learns who*
at runtime. The moment a recipient is baked into the blueprint, the
three roles that are usually distinct — author, operator, runtime user —
collapse into one, and the agent works only while they happen to be the
same person. This is the failure named in `../anti-patterns.md` § Agent
with no users; this recipe is its positive shape.

**The shape.** Four moves, none of which names a person:

1. **A capability to reach a cell.** The agent can deliver into a
   participant's conversation — `conversation__push_to_participant` for a
   one-off reach, or a feed the subscriber watches (`file__append_feed`
   on the producer side, `file__watch_feed` on theirs) for a standing
   subscription. See `../primitives.md` § The verb layer.
2. **Surface the capability in the prompt.** The channel's `prompt.md`
   teaches the agent to *offer* the notification to whoever is in the
   conversation — *"I can ping you when X, want that?"* — rather than
   assume it. The offer is how a runtime user discovers the capability
   exists.
3. **Capture the opt-in at runtime.** When someone accepts, the agent
   records the subscription keyed by the participant it acquires from the
   live conversation (or `agent__list_participants`, or discovery). The
   subscriber list is runtime substrate — `/memory/subscribers/...`, or
   the watch registration itself — never a value in the blueprint. What
   each subscriber wants notified about lives there too.
4. **A recipient-free detector delivers.** The thing that notices the
   signal — a scheduled sweep, a feed append, a threshold check — knows
   nothing about people. It evaluates the signal and, on a real one,
   delivers to whoever subscribed: a push into each subscriber's cell, or
   an append to the feed they watch.

**What this enables.** An agent that can be handed to anyone. The same
blueprint serves its author, a teammate who pairs in later, and a new
owner after a handoff, because none of them is written down. Delivery
scales with the subscriber model: a feed plus watch is one registration
per subscriber and zero producer change as the audience grows
(`shared-feed-meeting-point.md`), which is why it beats a fan of repeated
pushes the moment there is more than one recipient
(`../anti-patterns.md` § Broadcast fan-out).

**Where it doesn't fit.** A single, fixed recipient the *operator* sets
deliberately — that is a Configure-set value, not a runtime opt-in (see
`../operator-values.md`). Synchronous *"answer me now"* exchanges — that
is a plain reply, not a notification. A signal so rare, or so universal,
that offer-and-subscribe is ceremony — just push to the participant in
the moment you already have them.

**Variants.**

- *Standing subscription (feed + watch).* The subscriber registers a
  durable watch on a feed; the detector only appends. The watch survives
  conversation expiry and restart, so the subscriber gets new rows live
  while warm and catches up on next spawn when cold — see
  `shared-feed-meeting-point.md` for that delivery behavior. Best when
  the audience is more than one, or may grow.
- *One-off reach (push).* No standing subscription — the agent decides in
  the moment to notify a specific participant it acquired this turn, via
  `conversation__push_to_participant`. Best for a single, contextual ping.
- *Cheap sentinel detector.* The recipient-free detector runs single-shot
  on a fast schedule with a small model, and only appends hot signal to
  the feed (single-shot channels get `file__append_feed`, not the watch
  tools). The richer reader and the subscribers live elsewhere, on the
  full model. Keeps the high-frequency check cheap without dragging the
  detector into synthesis.

**Composes.** `conversation__push_to_participant` (one-off reach),
`file__append_feed` + `file__watch_feed` (standing subscription),
`task__schedule` or `props/schedule.txt` (the recipient-free detector's
trigger), `/memory/` for the subscriber list, the channel `prompt.md`
that surfaces the offer and captures the opt-in.

**Cross-link.** The negatives this inverts: `../anti-patterns.md` § Agent
with no users (baked recipients) and § Broadcast fan-out (push where a
feed would do). The delivery substrate is `shared-feed-meeting-point.md`
(feeds) and `../primitives.md` § The verb layer (push, watch, schedule).
For the conceptual building-is-not-serving framing,
`../../what-is-an-agent.md`. A recipient-free detector that does light
editorial work before surfacing pairs with `quiet-processing-channel.md`;
an intent-seeded single fire to one known person is
`deferred-follow-up.md`.
