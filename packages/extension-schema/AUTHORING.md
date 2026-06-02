# Extension Authoring Guide

How to build a Cast extension. Read this before creating a new extension package.

## What an extension is

An extension is a self-contained capability unit that provides MCP tools to agents. It connects to an external service (email server, calendar API, web browser) and exposes that service through tools the agent can call.

An extension is defined by `defineExtension()` and produces instances via `create()`. The definition is registered with the server at startup. The server creates one instance per agent that has the extension enabled.

```typescript
import { defineExtension } from '@getcast/extension-schema';

export const myExtension = defineExtension({
  name: 'my-extension',
  configSchema: MyConfigSchema,
  secretsSchema: MySecretsSchema,
  create: (ctx) => new MyExtension(ctx),
  connect: myConnect,  // optional — admin auth + discovery
});
```

## Package structure

Each extension is a package under `packages/ext-{name}/`:

```
packages/ext-{name}/
  package.json          # @getcast/ext-{name}
  src/
    index.ts            # exports defineExtension() result + class
    ...                 # internal modules as needed
  manual/
    README.md           # required — mechanical reference (tools, config, secrets, security, admin)
    SKILL.md            # standard — behavioral skill (prompt, bootstrap, cleanup)
```

`package.json` should have `@getcast/extension-schema` and `zod` as peer dependencies. Any external libraries the extension uses (protocol clients, parsers) are direct dependencies.

## Schemas

Every extension declares two Zod schemas:

**`configSchema`** — behavioral policy. What the extension is allowed to do and how it behaves. Written by the agent author in `capabilities.json`, optionally overridden by the operator in `config/ext/{name}/config.json`. The server merges these with locked-by-default semantics before passing to the extension.

**`secretsSchema`** — credentials. Parsed from `config/ext/{name}/.env` by the server. The extension receives validated secrets in `ctx.secrets`.

Define schemas in `@getcast/agent-schema` if they're shared across process boundaries (agent-schema is the shared type package). Otherwise define them in the extension package.

## ExtensionContext

The server injects context when creating an instance:

| Field | Purpose |
|-------|---------|
| `config` | Merged and validated config |
| `secrets` | Validated credentials from `.env` |
| `privateDir` | `ext/{name}/` — persistent private runtime (databases, subscription state, auth tokens). Never mounted. |
| `sharedDir` | `shared/ext/{name}/` — output visible to the agent (mounted at `/shared/{name}`) |
| `hasChannel` | Whether a dedicated processing channel is configured for this extension |
| `deliver` | Push a message to the agent. Channel is baked in by the host. Pass `replyTo` for user context. |
| `log` | Structured logger (pino-compatible interface). Falls back to `noopLogger` if not provided. |
| `agentFolder` | Agent instance folder name |

Use `ctx.log` for all logging. Never import a logger directly.

## Tools

Tools are the extension's public interface to the agent. Return them from a `tools` getter on the instance.

**Naming:** `{extension}__{action}` — double underscore separates namespace from action. Examples: `email__search`, `calendar__list`, `web__fetch`.

**Schema:** Each tool has a Zod schema for its parameters. Keep parameter descriptions concise — the agent reads them.

**handle():** Single dispatch method that routes by tool name. Parse arguments with the relevant Zod schema, enforce policy from config, call internal methods, return `ToolResult` via `textResult()`.

**Policy enforcement:** Tools are the policy boundary. Config restricts what the tool allows (send mode, allowed recipients, domain policy). Public client methods below the tool layer skip policy — they're for service-side direct use where the service applies its own rules.

## promptSection

Optional string injected into the agent's system prompt. Tells the agent what tools are available and how to use them. Keep it concise — it's consumed every conversation turn.

Condition content on config where relevant (e.g. "sending is disabled" vs "send mode: draft"). Condition on `hasChannel` to include or exclude subscription-related guidance.

## Connect hook (admin)

Optional hook for the admin dashboard. Verifies credentials work and discovers available resources — in one call. The admin layer calls it generically via the extension registry; the admin UI never imports protocol libraries.

```typescript
connect?: (privateDir: string) => Promise<{
  ok: boolean;
  message: string;
  state?: unknown;
}>;
```

`privateDir` is the full path to `ext/{name}/` (private runtime). The extension's `.env` lives in `config/ext/{name}/.env` — the host loads and injects it via `ctx.secrets`. The `state` field carries extension-specific discovery data (calendars, folders, chats, etc.).

**Type safety:** Export an `AdminState` Zod schema from the extension's schemas module. Self-validate the return with `.parse()` before returning — this prevents drift between the schema and the implementation. The admin UI imports the schema and calls `.parse(result.state)` to recover types.

```typescript
// schemas.ts
export const MyAdminState = z.object({
  resources: z.array(z.object({ id: z.string(), name: z.string() })),
});

// connect.ts
export async function connect(privateDir: string) {
  // ... authenticate, discover ...
  const state = MyAdminState.parse({ resources: [...] });
  return { ok: true, message: 'Connected', state };
}
```

Skip this hook if the extension has no credentials to validate (e.g. web-fetch).

## Lifecycle

```
Server start  →  def.onServerStart(log)        # optional, shared resources
Agent load    →  def.create(ctx)                # instance created
              →  instance.onAgentStart()         # optional, background tasks
Tool calls    →  instance.handle(name, args, call)
Agent unload  →  instance.onAgentStop()          # optional, cleanup
Server stop   →  def.onServerStop(log)           # optional, cleanup
Admin connect →  def.connect(privateDir)          # optional, credential check + discovery
```

**`onServerStart` / `onServerStop`** — definition-level. For shared resources that span all agents (subprocess pools, shared connections). Most extensions don't need these.

**`onAgentStart` / `onAgentStop`** — instance-level. For per-agent background tasks (IMAP IDLE connections, cron timers, polling loops). Start in `onAgentStart`, clean up in `onAgentStop`.

## Channel pairing

An extension can optionally pair with a dedicated conversation channel for processing notifications (subscription results, incoming events). The channel is a framework concern — configured in `capabilities.json` as `"channel": "channel-name"`, read and stripped by the server before config merge.

The extension receives `ctx.hasChannel` (boolean). When true, `ctx.deliver()` routes to that channel. When false, subscription/notification features should be hidden (omit those tools, adjust `promptSection`).

The channel itself (`blueprint/channels/{name}/`) is provided by the agent template author, not the extension. The extension delivers messages; the channel prompt defines what the agent does with them.

## Service-side use

Extensions are portable. A service can import and instantiate an extension directly:

```typescript
import { myExtension } from '@getcast/ext-my-extension';

const instance = myExtension.create({
  config: { ... },
  secrets: { ... },
  privateDir: svc.serviceDir,      // ext/service/ (private runtime)
  sharedDir: svc.sharedDir,        // shared/ext/service/ (agent-visible)
  deliver: (text, opts) => svc.routeMessage('default', text),
  log: console,
});
```

To support this, expose public methods on the instance class beyond the `ExtensionInstance` interface. These methods provide direct access to the underlying capability without MCP tool wrapping or policy enforcement. Document them in the manual's SERVICE API section.

## State and storage

- **`privateDir`** (`ext/{name}/`) — for persistent runtime state only the extension needs: subscription state, databases, caches, auth tokens. Never mounted anywhere.
- **`sharedDir`** (`shared/ext/{name}/`) — for output the agent should see. Mounted read-only in the container at `/shared/{name}`.
- **Operator config + secrets** live in `config/ext/{name}/` — operator territory, managed by the host. Extensions receive merged config and validated secrets via `ctx.config` and `ctx.secrets`; they do not read this directory themselves.
- **Staging** (`call.stagingDir`) — per-conversation temporary files. Write tool output here (fetched pages, email content). The agent reads these with the Read tool. Cleaned up when the conversation ends.

Don't write to `memory/`, `state/`, `home/`, or `config/` — those are not extension-owned.

## Manual

Every extension package must include `manual/README.md` (mechanical reference: tools, config, secrets, security, admin) and should include `manual/SKILL.md` (behavioral skill: prompt fragments, bootstrap/cleanup hooks). The README is read by authoring actors (Claude Code on the host, Design console, Design Manager) and by the admin page developer. The SKILL.md is authoring-actor source material — any authoring actor weaves it into agent blueprints with judgment.

## Registration

The server imports extensions explicitly and registers them at startup:

```typescript
import { myExtension } from '@getcast/ext-my-extension';
registerExtension(myExtension);
```

No dynamic loading. Adding an extension means adding an import and a `registerExtension()` call in the server entry point.
