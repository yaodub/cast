<!--
  TEMPORARILY DISCONNECTED. This manual has been moved out of
  `packages/cast/manuals/transports/` so the transport-manual aggregator
  (packages/cast/src/console/shared/transport-manuals.ts) does not pick it
  up. The corresponding registerTransport() call in packages/cast/src/index.ts
  is also commented out. To re-enable: move this directory back to
  `packages/cast/manuals/transports/email/` and restore the two
  email-transport lines in `packages/cast/src/index.ts`.
-->

---
description: Inbound IMAP / outbound SMTP for two-way email with granted users.
---

# email transport

Routed transport for two-way email. Inbound via IMAP IDLE, outbound
via SMTP. Works with any IMAP + SMTP provider (Gmail, Fastmail,
generic hosting).

## What it routes

Email between the agent's mailbox and remote correspondents.
Remote handles take the form `email:<rfc822>` (percent-encoded at the
address layer, e.g. `email:user%40example.com`).

## Configuration

Routed. Entries live in `routes.json` under the `email` key as an
array of `EmailRoute` objects:

```jsonc
{
  "email": [
    {
      "address": "<agent-alias>",       // resolves to agent address
      "email": "agent@example.com",
      "channel": "default",             // optional; routes to a specific channel
      "whitelist": ["*@example.com"],   // optional sender allowlist
      "requireAuth": true,              // DKIM/DMARC alignment check (default: true)
      "imap": { "host": "...", "port": 993, "user": "...", "pass": "...", "tls": true },
      "smtp": { "host": "...", "port": 465, "user": "...", "pass": "...", "secure": true }
    }
  ]
}
```

Each route maps one mailbox to one agent. Multiple routes can serve
multiple agents from the same Cast server.

## Onboarding flow

Operator sets up the transport:

1. Operator provisions the mailbox at the email provider.
2. Operator adds the route to `routes.json` via per-agent Configure
   (or by editing the file directly).
3. Operator reconciles/restarts transports.

Remote senders are externally addressable: the agent receives mail
from anyone the `whitelist` allows (or anyone, if no whitelist is
set). A sender's identity is created on first contact; the first
ungranted message is held while the agent's owner approves access
in-band (allow-once, or allow-always to persist the grant).

## Security

- Credentials live in `routes.json`, **plaintext on disk**. Operator
  is responsible for filesystem protection.
- IMAP IDLE keeps a persistent connection; UID watermark tracked in
  `transport-email.db`.
- `requireAuth` enables DKIM/DMARC alignment check; defends against
  From-header spoofing when senders' domains publish proper records.
  On by default; set `requireAuth: false` to accept unauthenticated
  mail (spoofable From).
- `whitelist` supports exact match and `*@domain` wildcards.
- Threads tracked via `Message-ID` for reply context.
- ACL still gates participant access after the transport ingests
  mail; `whitelist` is a coarse pre-filter, not a substitute for ACL.

## Note on the email *extension*

Cast also ships an `email` *extension* (`packages/ext-email/`) that
exposes mailbox-action tools to the agent (read inbox, send mail,
etc.). The transport and the extension share a name and underlying
protocols but are independent: one routes chat *to* the agent, the
other gives the agent tools to *act on* its mailbox. See
`console/overview.md` § *Extensions vs. transports*.
