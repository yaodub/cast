# Recipes

What's possible — concrete patterns operators can adapt for their
own agents. Each recipe leads with the visible use case (what it
does for the user) and then walks through the composition (channels,
lifecycle, mounts, what enables / where it breaks / variants) that
per-agent Design needs when actually building it.

Two indexes below for two readers: operators looking for a shape
that resonates (the *Browse by scenario* axis — DM surfaces this in
Browse mode), and per-agent Design composing an agent from a
pattern (the *Browse by pattern* axis).

## Browse by scenario (for operators)

- *Household or roommate agent your family talks to* —
  [Connecting two or more users](connecting-multiple-users.md)
- *Public agent strangers message; private agent has your data* —
  [Specialist agent behind a query-only door](specialist-behind-query.md)
- *Reviewer that periodically checks in across your agents* —
  [Reviewer that interviews the team](reviewer-interviews-team.md)
- *Evening journal that writes itself* —
  [Nightly reflection and memory consolidation](nightly-reflection.md)
- *Long-term check-in on commitments you made* —
  [Deferred follow-up on stored intent](deferred-follow-up.md)
- *Background watcher that only pings you when it matters* —
  [Quiet processing channel](quiet-processing-channel.md)
- *Group of friends or members coordinating over time* —
  [Shared feed as a meeting point](shared-feed-meeting-point.md)
- *An agent that asks who wants updates, then notifies whoever opted in* —
  [Opt-in notification](opt-in-notification.md)
- *Many parallel threads of the same kind — a review per PR, a client
  per account* — [Per-entity workroom](per-entity-workroom.md)
- *One public contact; specialist agents own the conversations behind
  it* — [Front desk that routes users](front-desk-handoff.md)
- *Reading hostile content without handing it your agent's tools* —
  [Untrusted-content airlock](untrusted-content-airlock.md)
- *Checking something often without paying strong-model prices each
  time* — [Two-speed agent](two-speed-agent.md)
- *Consequential actions only ever happen with you in the room* —
  [Approval-gated execution](approval-gated-execution.md)

## Browse by pattern (for per-agent Design composing)

- [Quiet processing channel](quiet-processing-channel.md) — handle
  automatic events on a side channel and only surface what matters
  to the user.
- [Shared feed as a meeting point](shared-feed-meeting-point.md) —
  agents (or humans through one agent) coordinate over time via
  append-only feeds; mount-asymmetry handles one-way trust beyond
  feeds as a variant.
- [Opt-in notification](opt-in-notification.md) — notification as a
  runtime capability, not a baked recipient: surface the capability,
  capture opt-in at runtime, a recipient-free detector delivers to
  subscribers. The agent-vs-cron-job seam; the positive of
  anti-patterns' "agent with no users."
- [Specialist agent behind a query-only door](specialist-behind-query.md) —
  sensitive capability isolated behind structured query/answer;
  variants cover public front-door agents and pure read-only
  observer/auditor roles.
- [Nightly reflection and memory consolidation](nightly-reflection.md) —
  scheduled fire into a single-shot reflection channel; variants
  cover plan-fan-out and self-tuning-cron shapes on the same
  primitive.
- [Deferred follow-up on stored intent](deferred-follow-up.md) —
  user states a decision; agent writes the intent and schedules a
  far-future single-shot fire to ask how it actually went.
  Intent-driven, not cadence-driven.
- [Reviewer that interviews the team](reviewer-interviews-team.md) —
  one agent periodically interviews peers via Q&A and synthesizes a
  report; specialist-behind-query in reverse.
- [Connecting two or more users](connecting-multiple-users.md) —
  one agent, multiple participants. Discreet mode (cross-cut
  awareness without quotation) and mediated mode (shared log in the
  agent's voice for awkward, async, or conflict-prone coordination).
- [Per-entity workroom](per-entity-workroom.md) — one sharded
  channel hosting qualifier-keyed sub-conversations: per-slice
  continuity and substrate that materialize at runtime, plus the
  janitor that closes the loop.
- [Front desk that routes users](front-desk-handoff.md) — the
  `p`/`h` handoff worked end-to-end: routing judgment at a public
  desk, users handed to the specialists who own their threads,
  pairing prerequisite named.
- [Untrusted-content airlock](untrusted-content-airlock.md) — the
  `r`/`a` edge worked end-to-end: hostile content parsed in a cage
  that can only write files, re-entering through an RO mount onto a
  low-privilege reader channel.
- [Two-speed agent](two-speed-agent.md) — per-channel model tiering:
  a cheap single-shot sentinel on a fast cadence detects; a
  strong-model synthesis channel wakes only on signal.
- [Approval-gated execution](approval-gated-execution.md) — the
  consequential verb enabled on exactly one operator-only channel;
  every other channel can only write proposals. Includes the
  entry-path audit that keeps the gate structural.

The [Degrees of zone safety](../zone-safety.md) composition reference
(formerly in this folder) sits one level up — it composes the
recipes above rather than standing alone, and reads as architecture
per-agent Design reaches for when wiring isolation, not as a use
case on its own.

## Working with recipes

These are inspiration, not templates. The worked examples make the
moves concrete; the moves themselves are what to carry forward into
novel work. Read a few early in your authoring work to develop a
feel for what's compositionally possible.

Recipes are composed of primitives documented in `../primitives.md`.
If a primitive name in a recipe is unfamiliar, that's where to read
about it. Recipes don't repeat primitive documentation — they assume
the vocabulary.

When a recipe shape doesn't quite fit your case, ask which primitive
you'd substitute, drop, or add to make it fit. The structure of the
recipe usually survives the adjustment; the primitives are the
adjustable parameters.

Each recipe is also a *spec exemplar*. Every loader names its file
(`/memory/reflections/<date>.md` written by the reflection channel's
cleanup; `/memory/decisions/<date>-<topic>.md` referenced by the
schedule fire's payload), every channel names its lifecycle
(single-shot for the reflection channel, persistent for user
channels), every loop names its closer. That density of named
joints — paths, channel names, trigger verbs, end-to-end — is what
the spec discipline in `../primitives.md` calls for. Read the
recipes with both lenses: as patterns to adapt, and as what a
finished spec looks like.

The inverse is in `../anti-patterns.md` — the shapes that *don't*
earn their overhead. Recipes name seams that pay for themselves
(access, judgment, filtering, independent goals); anti-patterns
name seams and habits that don't (couriers, process-decomposition,
verbatim handoffs, cadence-without-signal). The two pair: if a
proposed shape doesn't match a recipe but does match a smell in
anti-patterns, that's a strong tell.

## Coverage map

Which recipe exercises which primitive — for finding a worked
example of the move you're reaching for, and for spotting coverage
gaps when adding recipes. ✓ core to the recipe, ○ in a variant,
— absent. (Memory substrate and `disabled_tools` appear in nearly
every recipe and aren't columned.)

| Recipe | Lifecycle | Edge | Sharding | Push | Feed+watch | Mounts/slots | Schedule | Multi-participant | Model tiers |
|---|---|---|---|---|---|---|---|---|---|
| [Quiet processing](quiet-processing-channel.md) | single-shot (○ persistent) | ○ q/a | — | ✓ intra | ○ | ○ | ✓ | — | — |
| [Nightly reflection](nightly-reflection.md) | single-shot | — | — | ✓ intra | — | — | ✓ | — | — |
| [Deferred follow-up](deferred-follow-up.md) | persistent target | — | — | — | — | — | ✓ once | — | — |
| [Specialist behind query](specialist-behind-query.md) | single-shot | ✓ q/a | — | — | — | ○ | — | ✓ visibility off | — |
| [Shared feed](shared-feed-meeting-point.md) | persistent | — | — | — | ✓ | ✓ | — | ✓ | — |
| [Reviewer interviews team](reviewer-interviews-team.md) | single-shot | ✓ q/a | — | ✓ intra | ○ heartbeat | ○ heartbeat | ✓ | — | — |
| [Connecting multiple users](connecting-multiple-users.md) | persistent | — | — | ✓ participant | ○ | — | ○ | ✓ | — |
| [Opt-in notification](opt-in-notification.md) | both | — | — | ✓ participant | ✓ | — | ✓ | ✓ | ○ |
| [Per-entity workroom](per-entity-workroom.md) | persistent, sharded | ○ q/a | ✓ | ✓ composite | — | — | ✓ janitor | ○ substrate | — |
| [Front desk](front-desk-handoff.md) | persistent | ✓ p/h (○ q/a) | — | ✓ cross-agent | — | — | — | ✓ | — |
| [Untrusted-content airlock](untrusted-content-airlock.md) | single-shot | ✓ r/a | — | ✓ intra | ✓ | ✓ | ○ | — | ○ |
| [Two-speed agent](two-speed-agent.md) | both | — | — | ✓ intra | ✓ | — | ✓ | — | ✓ |
| [Approval-gated execution](approval-gated-execution.md) | persistent | — | — | ✓ subtracted | — | — | ✓ nudge | — | — |

The edge column's `q/a` / `r/a` / `p/h` shapes are
`../multi-agent-composition.md`'s vocabulary;
[zone-safety](../zone-safety.md) composes rows of this table rather
than appearing in it.
