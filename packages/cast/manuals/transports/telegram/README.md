---
description: Telegram bot DMs and callback_query approvals via long polling.
---

# telegram transport

Routed transport for Telegram bot interactions. Uses long polling via
the grammy SDK; supports text messages, file attachments, and
button-based approvals via `callback_query`.

## What it routes

Two-way Telegram DMs between the bot and remote users. Remote handles
take the form `tg:<chat_id>` (unsigned integer for users, negative for
groups/channels).

## Configuration

Routed. Entries live in `routes.json` under the `telegram` key as an
array of `TelegramRoute` objects:

```jsonc
{
  "telegram": [
    {
      "token": "123456:ABC-DEF...",     // bot token from BotFather
      "address": "<agent-alias>",       // resolves to agent address
      "channel": "default"              // optional
    }
  ]
}
```

One bot serves one agent. Multiple bots can run side-by-side via
multiple route entries.

## Pairing flow

Operator-initiated:

1. Operator creates a bot in BotFather (`/newbot`) and copies the
   token.
2. Operator adds the route to `routes.json` via per-agent Configure.
3. Operator reconciles/restarts transports.

Chat IDs (`tg:<chat_id>`) mint upon first user message. The user's
identity is created on first contact; the operator pairs the
resulting identity in per-agent Configure to grant ACL access.

## Security

- Bot token in `routes.json`, plaintext on disk.
- Long-poll auto-restarts on `409 Conflict` (another poller running).
- Message debounce (1 s window) coalesces rapid-fire messages into a
  single ingestion.
- Media download size-gated by `MAX_ATTACHMENT_BYTES`.
- Approval `callback_query` data: `<agentAddress>:<approvalId>`.
- Recent user activity gate (60 s window) suppresses unsolicited
  lifecycle events.
