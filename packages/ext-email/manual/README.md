---
description: IMAP/SMTP email extension — search, read, send, subscriptions
---

# email

IMAP search, SMTP send, and subscription engine. Provider-agnostic — works with any IMAP/SMTP server (Gmail via app password, Fastmail, etc.).

## USAGE

The extension provides four on-demand tools and three subscription tools.

**Core workflow: search → fetch → act.**
1. `email__search` returns envelope summaries inline (ID, from, to, subject, date, snippet). Use to triage — decide which emails to fetch. Optional `folder` param (default: INBOX).
2. `email__fetch` downloads emails to staging. Writes `.md` (headers + body text + attachment summary + image stats) and `.eml` (raw MIME) per email. Accepts batch IDs. Agent reads `.md` files with the Read tool. Use `.eml` for raw MIME, attachments, or cleaning scripts.
3. `email__send` composes and sends. To reply, pass the `messageId` from a previous `email__fetch` result as `replyToMessageId` — this sets proper threading headers.
4. `email__list_folders` lists all available IMAP mailbox folders. Use to discover folder names for search/subscribe.

**Staging files are ephemeral** — cleared when the conversation ends. Copy to `/memory/` if needed long-term.

**Subscriptions** (requires a paired channel):
- `email__subscribe` creates a persistent watch. `"realtime"` uses IMAP IDLE push; cron expressions poll on schedule. Each subscription carries `instructions` that tell the agent what to do when matching emails arrive. Optional `folder` param selects which mailbox to watch (default: INBOX).
- Subscription notifications include email IDs — use `email__fetch` with those IDs to download full content. Notifications are delivered to the paired channel, but the agent fetches content in the participant's conversation (different staging directories).
- The agent should prefer few broad subscriptions over many narrow ones.

## CONFIG

Config is split into two sections: `inbound` (read surface) and `outbound` (send surface). Both share a three-tier `default` mode: `disabled` (off), `approval` (user prompt required), or `enabled` (no gate).

### Inbound

| Field | Type | Default | Effect |
|-------|------|---------|--------|
| `inbound.folders` | `string[]` | `[]` | Folder allowlist. Empty = all folders visible. Exact IMAP paths. |
| `inbound.senders` | `string[]` | `[]` | Sender allowlist. Empty = all senders. Patterns: exact address (`alice@acme.com`) or `@domain` (`@acme.com`). Enforced at IMAP query. |
| `inbound.blocked` | `string[]` | `[]` | Sender denylist. Same pattern syntax. Pushed to IMAP `not:` clause — matches never return. |
| `inbound.window_days` | `number` | `7` | How far back `email__search` can look. |
| `inbound.max_results` | `number` | `25` | Max envelopes per search. |
| `inbound.default` | `disabled \| approval \| enabled` | `approval` | Approval policy for `email__search` and `email__subscribe`. |
| `inbound.always_allow` | `string[]` | `[]` | Addresses that bypass approval even under `approval` default. |

### Outbound

| Field | Type | Default | Effect |
|-------|------|---------|--------|
| `outbound.recipients` | `string[]` | `[]` | Recipient allowlist. Empty = any recipient. Same pattern syntax as inbound. |
| `outbound.blocked` | `string[]` | `[]` | Recipient denylist — never send to these. |
| `outbound.default` | `disabled \| approval \| enabled` | `approval` | Approval policy for `email__send`. |
| `outbound.always_allow` | `string[]` | `[]` | Recipients that bypass approval (auto-send). |

### Address pattern syntax

- `alice@acme.com` — exact match (case-insensitive)
- `@acme.com` — any address in that domain

No regex, no globs.

### Gating summary

| Tool | Scope enforcement | Approval |
|------|-------------------|----------|
| `email__search` | `inbound.folders`, `senders`, `blocked` (IMAP-side) | per-call via `inbound.default` + `always_allow` |
| `email__fetch` | `inbound.senders`/`blocked` (handler-side) | none (inherited from search) |
| `email__subscribe` | `inbound.folders`, `senders`, `blocked` | per-call via `inbound.default` |
| `email__send` | `outbound.recipients`, `blocked` | per-recipient via `outbound.default` + `always_allow` |
| `email__list_folders` | Output filtered by `inbound.folders` | none |

## SECRETS

Stored in `config/ext/email/secrets.json`.

| Field | Description |
|-------|-------------|
| `EMAIL_ADDRESS` | Email address (used as SMTP sender) |
| `EMAIL_PASSWORD` | App password or account password |
| `IMAP_HOST` | IMAP server hostname (e.g. `imap.gmail.com`) |
| `IMAP_PORT` | IMAP port (typically `993`) |
| `SMTP_HOST` | SMTP server hostname (e.g. `smtp.gmail.com`) |
| `SMTP_PORT` | SMTP port (typically `465`) |

For Gmail: requires 2FA enabled, generate app password at https://myaccount.google.com/apppasswords.

## CHANNEL

The email extension optionally pairs with a dedicated channel for subscription processing.

**Delivered message format:** plain text notification with subscription ID, matched email count, and the subscription's `instructions` field.

**Channel prompt should instruct the agent to:** read the notification, use `email__fetch` to pull the relevant emails, process according to the subscription instructions, and delegate results to the appropriate user on the default channel.

**Without a channel:** subscription tools (`email__subscribe`, `email__unsubscribe`, `email__list_subscriptions`) are hidden. On-demand tools (search, fetch, send) work normally.

Set `"channel": "email"` in `capabilities.json` and provide a matching `channels/email/` directory.

## STORAGE

| Asset | Location | Format | Purpose |
|-------|----------|--------|---------|
| Subscriptions | `ext/email/subscriptions.json` | JSON array | Persistent subscription state (criteria, schedule, watermarks). Private runtime. |

The extension does not maintain a local email index or cache. Each search/fetch hits IMAP directly.

## SECURITY

### Input surface

The agent can enumerate and fetch any email within `inbound.window_days` that passes the inbound scope (senders allowlist minus blocked, within allowed folders). Email content may include sensitive personal, financial, or authentication data.

### Output surface

`email__send` — sends email as the configured account. The only outbound data channel.

### Config risk levels

| Setting | Safe | Unsafe | Dangerous |
|---------|------|--------|-----------|
| `inbound.default` | `approval` (default) | `enabled` with scope | `enabled` with empty `senders` |
| `inbound.senders` | Explicit list or `@domain` | Empty with `enabled` | — |
| `inbound.window_days` | `7` (default) | `30` | `365` — agent sees a year of email |
| `outbound.default` | `approval` (default) or `disabled` | — | `enabled` — sends without prompt |
| `outbound.recipients` | Explicit 1-2 addresses | Broader list | Empty with `enabled` outbound |
| `outbound.always_allow` | Empty | One trusted address | Many addresses |

### Composer guidance

Start with `outbound.default: disabled`. Only enable sending with a narrow `outbound.recipients` after explicit user request. Leave `inbound.default: approval` unless the user explicitly opts in to open reads. Subscriptions amplify input surface — a broad subscription on a frequent schedule continuously feeds email content to the agent.

## ADMIN

### Secrets fields

All six secrets fields should be editable. Group as two sections: **Account** and **Server**.

| Field | Input type | Help text |
|-------|-----------|-----------|
| `EMAIL_ADDRESS` | text | Email address used for sending and IMAP login |
| `EMAIL_PASSWORD` | password | App password (Gmail: requires 2FA, generate at myaccount.google.com/apppasswords) |
| `IMAP_HOST` | text | IMAP server hostname, e.g. `imap.gmail.com` |
| `IMAP_PORT` | number | IMAP port, typically `993` (SSL) |
| `SMTP_HOST` | text | SMTP server hostname, e.g. `smtp.gmail.com` |
| `SMTP_PORT` | number | SMTP port, typically `465` (SSL) or `587` (STARTTLS) |

### Config fields

Group as two sections: **Inbound** and **Outbound**. Each section's fields follow the same pattern (allowlist, denylist, default mode, always-allow).

### Connect state

The extension's `connect` hook authenticates via IMAP and discovers mailbox folders. Returns `EmailAdminState`:

```typescript
{ folders: Array<{ path: string; name: string }> }
```

Exported from `@getcast/ext-email/schemas`. Parse with `EmailAdminState.parse(result.state)` in the admin UI. Discovered folders should be clickable chips that append to `inbound.folders`.

### Validation

The "Connect" button verifies IMAP credentials against the saved `secrets.json`, so save before testing. SMTP validation is optional (some providers don't allow test connections).

## SERVICE API

Public methods on `EmailExtension` for direct service-side use:

| Method | Signature | Description |
|--------|-----------|-------------|
| `search` | `(req: EmailSearchRequest) => Promise<EmailSearchResult>` | IMAP search with inbound scope injected |
| `send` | `(req: EmailSendRequest) => Promise<EmailSendResult>` | Send (no policy enforcement — caller trusted) |
| `read` | `(req: EmailReadRequest) => Promise<EmailReadResult>` | Fetch full email content (no scope check) |

`search` enforces inbound scope via IMAP query. `send` and `read` bypass policy — services are trusted; they must enforce their own policy when calling directly.

Request/result types are exported from `@getcast/ext-email/schemas`.
