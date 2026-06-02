---
description: Slack DMs via Socket Mode WebSocket; multi-workspace handle format and team/user allowlists.
---

# slack transport

Routed transport for Slack DMs. Uses Socket Mode (no public HTTPS
endpoint required); supports text messages, file downloads with MIME
validation, and Block Kit `actions` approvals.

## What it routes

Two-way Slack direct messages between the bot and remote users.
Remote handles take the form `slack:T<teamId>:U<userId>` — literal
Slack IDs, no double-prefixing.

## Configuration

Routed. Entries live in `routes.json` under the `slack` key as an
array of `SlackRoute` objects:

```jsonc
{
  "slack": [
    {
      "botToken": "xoxb-...",           // OAuth bot token
      "appToken": "xapp-...",           // app-level token (connections:write)
      "address": "<agent-alias>",       // resolves to agent address
      "channel": "default",             // optional
      "allowedTeamIds": ["T0123..."],   // optional workspace allowlist
      "allowedUserIds": ["U9876..."],   // optional user allowlist
      "botUserId": "U..."               // optional; discovered at connect() if omitted
    }
  ]
}
```

One Slack app serves one agent. Multiple apps run side-by-side via
multiple route entries.

## Pairing flow

Operator-initiated:

1. Operator creates a Slack app at `api.slack.com/apps`.
2. Operator mints bot + app tokens and installs the app to a
   workspace.
3. Operator adds the route to `routes.json` via per-agent Configure.
4. Operator reconciles/restarts transports.

User IDs mint upon first DM. The user's identity is created on first
contact; the operator pairs the resulting identity in per-agent
Configure to grant ACL access.

## Security

- Both tokens (`botToken`, `appToken`) live in `routes.json`,
  plaintext on disk.
- Socket Mode WebSocket — no public HTTPS endpoint required.
- Handle format `slack:T<teamId>:U<userId>` is multi-workspace-aware;
  team-scoped collisions are impossible.
- File downloads validate `Content-Type` to gate missing `files:read`
  scope.
- Approval buttons use Block Kit `actions` blocks with callback data
  `<agentAddress>:<approvalId>`.
- Recent user activity gate (60 s window) suppresses unsolicited
  lifecycle events.
- DM channels cached per `(bot, user)` pair indefinitely.
- `allowedTeamIds` / `allowedUserIds` are coarse pre-filters; ACL
  still gates participant access after ingest.
