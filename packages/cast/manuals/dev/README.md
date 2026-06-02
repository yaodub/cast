# Cast manuals — dev surface

These manuals are for working on agents **directly via Claude Code** (or any other host-side editor) on the Cast project folder or an individual agent folder. They are *not* mounted into console containers.

## Audience boundary

| | Console agents | Claude Code on host |
|---|---|---|
| Reads `manuals/console/` | yes | yes |
| Reads `manuals/extensions/` | yes | yes |
| Reads `manuals/dev/` (this folder) | **no** | yes |

The split exists because consoles run in a constrained envelope: no service authoring, no transport authoring, no admin-API extension. The operator routes those requests to Claude Code (advanced mode) on the host, where this folder applies.

## Contents

- `agent-architecture.md` — agent folder reference. What every directory does, who owns it, and how the layers compose.
- `service-development.md` — building agent services (cron jobs, MCP tools, extension instantiation). Service code lives in each agent's `blueprint/service/` directory.
- `extension-admin.md` — adding a new extension to the admin dashboard surface (config, secrets, connect hook, UI plumbing).
- `transport-admin.md` — adding a new transport (Telegram-style integration: defineTransport, registry, route schema, admin UI).
- `agent-introspection.md` — interactive Claude Code session in which the operator and Claude Code help an agent look at itself, surfacing growth proposals from runtime + design. Method spec for `/cast-refine`; upstream of `/cast-build`.
- `debugging.md` — end-to-end message-pipeline reference: layer-by-layer reads (gateway, agent.db, runner log, session transcripts) for diagnosing agent or pipeline behavior. Method spec for `/cast-debug`.

For agent-folder reference inside a console, the server inlines the contract subset that consoles need into prompts — consoles do not need to read this directory.
