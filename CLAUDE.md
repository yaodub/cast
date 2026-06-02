# Cast

Cast is a self-hosted harness for multi-user Claude Code agents that run as isolated container processes. See [README.md](README.md) for the project overview, philosophy, and setup.

You are reading this from a host-side Claude Code session on the Cast project (or on an agent folder under `$CAST_AGENTS_DIR/` — default `~/.cast/agents/`). You have the full authoring envelope: edit any package, customize agents, write services, add extensions or transports. Consoles inside Cast (Design, Configure, the All-Agents managers) operate within a constrained subset of the same docs and route work that exceeds their envelope to you. See `packages/cast/manuals/MODES.md` for the console-vs-advanced framing.

## Repository layout

| Path | Purpose |
|------|---------|
| `packages/cast/` | The Cast server — orchestration, transports, identity, ACL, scheduling |
| `packages/agent-runner/` | The in-container agent process (wraps the Claude Agent SDK) |
| `packages/ext-*` | First-party extensions (email, calendar, web-fetch, whatsapp) |
| `packages/extension-schema/`, `packages/agent-schema/`, `packages/admin-schema/` | Shared schema packages |
| `packages/web-ui/` | Admin and chat web UI |
| `~/.cast/agents/<name>/` | A runtime agent instance — `blueprint/`, `memory/`, `home/`, `config/`, `state/`, `ext/`, `sessions/`. Lives outside the repo by default; override with `CAST_AGENTS_DIR` |

## Working with agents

An agent is a folder under `~/.cast/agents/` (or whatever `CAST_AGENTS_DIR` resolves to). To create or modify an agent, edit files inside that folder. The server hot-reloads on the next message: new agent folders are discovered live, and blueprint, identity, channel, and config edits apply on the next message. Service code under `blueprint/service/` is the exception. A running service process does not reload its own source, so service-code changes need a service restart.

## Pick your task

Routing by intent — start at the entry doc, then follow the "then" column for deeper references.

| If you're... | Start here | Then |
|---|---|---|
| **Customizing an agent's blueprint** (identity, channels, props, capabilities) | `packages/cast/manuals/dev/agent-architecture.md` | `packages/cast/manuals/console/design/primitives.md` for the compositional vocabulary; `console/design/recipes/` for worked compositions; the deep references in `console/design/{operator-values, multi-agent-composition, service-and-schedule}.md` and `console/cross-agent-acl.md` (Configure's ACL manual) as needed |
| **Introspecting an agent or the fleet** (helping it look at itself; surfacing growth proposals from runtime + design) | `packages/cast/manuals/dev/agent-introspection.md` | — |
| **Writing or modifying a service** (cron jobs, MCP tools, OAuth) | `packages/cast/manuals/dev/service-development.md` | `packages/agent-schema/src/v1/SPEC.md` §9 for the mechanical contract |
| **Adding a new extension** | `packages/extension-schema/AUTHORING.md` | `packages/cast/manuals/dev/extension-admin.md` for admin-UI plumbing; existing `packages/ext-*/manual/README.md` for shape reference |
| **Adding a new transport** | `packages/cast/manuals/dev/transport-admin.md` | — |

## Ground truth, when you need it

- `packages/agent-schema/src/v1/SPEC.md` — canonical agent specification. Authoritative; reach for it when the framing docs leave you unsure.
- `packages/cast/manuals/MODES.md` — the console-vs-advanced trust model. What consoles can do, what they route out, why.
- `packages/cast/manuals/dev/README.md` — index of host-side authoring docs (the four `dev/*.md` files).

The console-facing manuals (`packages/cast/manuals/console/**`) describe what each in-Cast console does. They're constrained-envelope content but rich on agent-composition patterns — Claude Code can and should read them when relevant.

## Existing extensions

Don't reinvent these. Read the manual for usage, config, secrets, security posture, and admin behavior.

| Extension | Manual |
|---|---|
| email | `packages/ext-email/manual/README.md` |
| calendar | `packages/ext-calendar/manual/README.md` |
| web-fetch | `packages/ext-web-fetch/manual/README.md` |
| whatsapp | `packages/ext-whatsapp/manual/README.md` |

## Common commands

```bash
pnpm dev                       # Start the server
pnpm agent list                # List agents and their config
pnpm agent config [name]       # Configure an agent
```
