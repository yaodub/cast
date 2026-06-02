# @getcast/agent-kit

CLI tooling for creating and managing Cast agents. Runs via `tsx` — no build step, no `dist/`.

The Cast server doesn't import this package at runtime. It reads agent folders directly; agent-kit is just the bootstrap helper.

## Structure

```
@getcast/agent-kit/
  src/                       # CLI implementation (pnpm agent ...)
    index.ts                 # Entry point — command routing
    init.ts                  # Stamp agent instance from template
    config.ts                # Interactive agent configuration (model, telegram)
    list.ts                  # List agents and templates
    check.ts                 # Validate template structure and staleness
    create.ts                # Interactive template creation wizard
    dev.ts                   # Dev harness (ephemeral instance, file watching, Cast subprocess)
    build-service.ts         # Bundle template services via esbuild
    paths.ts                 # Package and project path constants
    helpers.ts               # Shared utilities (copy, JSON, flags)
    templates/
      service-skeleton.ts    # Code template for new agent services
  templates/                 # Agent templates (independent git repos, gitignored)
```

## CLI

All commands run via `pnpm agent` from the project root.

### Agent commands

```bash
pnpm agent init <name> --template <template>   # Stamp instance from template (idempotent)
pnpm agent config [name]                       # Configure model, telegram, channels
pnpm agent list                                # List all agent instances
```

### Template commands

```bash
pnpm agent template list                       # List available templates
pnpm agent template create [name]              # Create template interactively
pnpm agent template check <name>               # Validate structure and staleness
pnpm agent template dev <name>                 # Dev harness with file watching
```

## Templates

A template is a directory of content — prompt fragments, channel configs, settings — that gets stamped into a runtime agent instance via `pnpm agent init`.

Each template's `service/` directory contains the agent service source code — an independent package with its own `package.json` and dependencies. It is compiled via esbuild during `pnpm agent init` and placed into the agent's `blueprint/service/`. The template's `service/` is source; the agent's `blueprint/service/` is the compiled artifact.

### Template layers (stamped to agent blueprint/)

| Directory | Purpose |
|-----------|---------|
| `identity/` | System prompt, skills, onboarding, tools → `blueprint/identity/` |
| `channels/` | Per-channel config and lifecycle hooks → `blueprint/channels/` |
| `props/` | Server-consumed settings → `blueprint/props/` |
| `assets/` | Static reference data → `blueprint/assets/` |
| `service/` | Agent service source (cron jobs, MCP tools) → `blueprint/service/` (compiled) |

### Instance layers (created at init, never overwritten)

| Directory | Purpose |
|-----------|---------|
| `config/` | Model, transport tokens, API keys |
| `state/` | Conversations, tasks, message log |
| `home/` | Agent working directory |
| `memory/` | Persistent memory |
| `ref/` | Reference data from service jobs |
| `sessions/` | Per-session IPC and settings |

For agent-folder reference and service-development guidance, see `packages/cast/manuals/dev/`.
