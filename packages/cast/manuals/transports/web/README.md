---
description: Browser WebSocket clients reaching the agent via /chat/*; user-minted self-handles at registration.
---

# web transport

Always-on default transport. Serves the user-facing chat surface at
`/chat/*` on the Cast server. Distinct from the admin UI (which uses
the `console` transport for operator pill-drawer chats).

## What it routes

Two-way messaging between a browser client and one or more agents.
Each browser client owns a handle of the form `web:<10hex>` (e.g.
`web:a1b2c3d4e5`), minted server-side at registration time.

## Configuration

Bespoke. Constructed directly in `packages/cast/src/index.ts`; no
`routes.json` entry. Always enabled when the Cast server is running.

## Onboarding flow

User-initiated:

1. Browser connects to the `/chat/*` WebSocket endpoint.
2. Client sends a `register` message with a chosen display name.
3. Server mints a random handle (`web:` + 10 hex chars via
   `randomBytes(5).toString('hex')`), creates an identity in the IdP,
   and replies with the handle + identity UUID.
4. Browser persists the handle locally; reconnects replay missed
   packets from `gateway.db` (deferred ACK, cache-like).

Operators do not mint web handles — users do. When a web identity
first reaches an agent it isn't granted on, the message is held while
the agent's owner approves access in-band (allow-once, or allow-always
to persist the grant). The owner can also pre-grant the identity into
the agent's ACL via per-agent Configure.

## Security

- `web:` is a reserved address prefix; clients cannot supply
  `admin:` or `cli:` handles.
- `/discover` endpoint is localhost-only.
- Per-packet ACL gating: clients only receive packets and events for
  agents they hold the `i` (interact) bit on.
- Deferred ACK with persisted packets means a disconnected browser
  receives missed packets on reconnect.
