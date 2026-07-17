# Migrating from 0.3 to 0.3.1

There are no migration scripts for this release. 0.3.1 changes no database schemas and no config formats; every on-disk change is additive with a compatibility fallback, so a 0.3 install starts cleanly on 0.3.1 with nothing run first.

This README exists so that "nothing to run" is a documented fact rather than an absence. There is one optional manual step, below.

## What changed on disk

1. **Extension reply bindings.** Email subscriptions (`ext/email/subscriptions.json`) and WhatsApp watches (`ext/whatsapp/watches.json`) gain optional `originChannel` and `createdBy` fields. New entries store the conversation that created them and deliver back to it. **Entries created before 0.3.1 lack `originChannel` and keep firing exactly as before** — on the extension's configured channel. A fire is never dropped for lack of a binding; each legacy fire logs an info line naming the subscription and suggesting the upgrade.
2. **Subscription/watch tools are no longer channel-gated.** On 0.3, `email__subscribe` / `whatsapp__watch` (and their list/remove tools) existed only when the extension had a dedicated `"channel"` configured in `capabilities.json`. On 0.3.1 they register whenever the extension is enabled. A configured channel keeps two roles: delivery fallback for legacy entries, and an optional home for agent-owned watches. Nothing requires removing it.
3. **Management tools are ownership-scoped.** `email__list_subscriptions` / `email__unsubscribe` (and the WhatsApp equivalents) now show and remove only the calling conversation's own entries; operator surfaces see all. If an agent's blueprint prompted users to manage each other's subscriptions, that flow now requires the operator.
4. **Extension fires are machine stimulus.** Subscription/watch notifications arrive wrapped in `<cast:watch>` and log under sender `system` in `message_log` (previously they logged as the participant's own words). Turns fired by schedules, watches, and services no longer stream previews, typing indicators, or intermediate "show steps" text to the participant — only the agent's final reply is delivered. Blueprint prompts that referenced the plain-text notification format still work; the wrapper surrounds the same body.

## Rebuild

Server bundle only (`pnpm bundle --outdir …`, or `pnpm install` for source installs). The web UI is unchanged in this release, and the agent container image is untouched — the bundle re-tags the existing image with the new version.

## Optional manual step: upgrade legacy bindings

To move a pre-0.3.1 subscription or watch to intent-cell delivery (fires return to the conversation that asked, authorized by that user's own channel grant):

1. Find legacy entries — any store without `originChannel`:

```bash
find "$CAST_AGENTS_DIR" \( -path '*/ext/email/subscriptions.json' -o -path '*/ext/whatsapp/watches.json' \) -exec grep -L originChannel {} +
```

A listed file containing only `[]` is an empty store — nothing to upgrade there.

2. From the conversation that should receive the results, ask the agent to re-create the subscription/watch **with the same explicit `id`**. The entry is replaced in place; for email, the watermark carries over when the criteria and folder are unchanged, so already-seen mail is not replayed.

Leaving legacy entries alone is fine indefinitely — the fallback is permanent, not deprecated.

## Still relevant from 0.2 → 0.3

The compound-target hazard (`"u:…@…/tg:…"` reply targets stored under 0.2) is unchanged: targets are routed participants and must be bare identities. If you skipped that step, see `../0.2-to-0.3/README.md` — the check there still applies to these same two stores.

## Verify

- Server starts and logs `Cast 0.3.1 ready`.
- An agent with the email extension enabled and **no** `"channel"` configured logs an `Extension activated` line listing all seven email tools, including `email__subscribe`.
- A legacy subscription's next fire logs `Legacy subscription (no originChannel) — delivering on the configured default channel…` and delivers as before.
