# Service Development Reference

> For the mechanical service contract (entrypoint resolution, environment variables, IPC message catalog), see `@getcast/agent-schema` `src/v1/SPEC.md` §9. This document covers how to write and build services.

An agent service is an independent Node.js package that runs as a long-lived child process alongside the agent.

## Why Services Exist

Most agent capabilities are provided by **extensions** — self-contained packages enabled via `capabilities.json`. Email, web-fetch, and calendar are all extensions. Extensions provide tools, prompt sections, and lifecycle hooks with zero service code.

Services are for **custom logic that extensions don't cover**: proprietary API integrations, multi-source data aggregation, custom background jobs, or advanced use cases like multi-account email orchestration. Before writing a service, check whether an extension already handles the capability.

The service runs **outside** the container on the host, with unrestricted network access. It can call any API, query any database, sync from any source. It exposes capabilities to the agent through MCP tools (which the agent calls during conversation) and through data written to `shared/ext/service/` (which the agent can read at `/shared/service`).

## What a Service Does

A service provides three things to the agent:

1. **MCP tools** — custom tools the agent can call during conversation. Served on a Unix socket that the agent runner connects to automatically.
2. **Shared data** — files written to `shared/ext/service/` that the agent can read. Read-only to the agent at runtime (mounted at `/shared/service` in container).
3. **Dynamic context** — `shared/ext/service/agent-context.md` is injected into the system prompt (layer 9, wrapped in `<service-context>`) on every conversation. Use this to tell the agent what data is currently available. Service databases stay in `ext/service/` (the service CWD, not mounted in the container).

## Process Boundary

The service runs as a separate host-side process. It **cannot** import from `@getcast/host` or `@getcast/agent-runner`. It communicates with the server exclusively via IPC messages (see SPEC.md §9.4 for the full message catalog). Duplicated utilities across boundaries are acceptable — coupling is worse.

The service has full filesystem access to the agent folder but should only write to `shared/ext/service/` (agent-visible output, mounted at `/shared/service` in container) and service-local databases in `ext/service/` (service CWD, not mounted). Writing to `memory/`, `state/`, `config/`, or other directories risks corrupting agent or server state.

## Directory Structure

The simplest way to author a service is directly inside the live agent's `blueprint/service/` folder. The source lives in the blueprint, you bundle it in place, and restart the service. This is the pattern to start with: the agent folder is self-contained, with nothing to maintain elsewhere.

```
blueprint/service/
  src/
    index.ts                 Source: IPC listener, MCP server startup, jobs, admin handler
  package.json               Service dependencies (independent from host)
  manifest.json              Service identity (name, version) + settings/secrets/admin declarations
  index.js                   Bundled output, sits beside the source
  index.js.map
  checksum.txt
```

The runtime service CWD is `ext/service/` (private runtime: databases, caches). Operator-owned files live in `config/ext/service/`: `secrets.json` for credentials and `config.json` for settings, declared in the manifest's `secrets` and `config` fields and edited from the admin UI. `svc.secrets` and `svc.settings` are startup snapshots of those files; the server restarts the service whenever either changes (admin save or hand edit alike), so the snapshots are always current. See "Operator Settings and Secrets" below.

### Building and reloading

`src/index.ts` is bundled with esbuild (ESM, node20 target, sourcemaps) to `blueprint/service/index.js`, beside the source. A manifest with no `entry` field runs that bundle under plain `node`, which is the production shape: self-contained, no toolchain needed at the runtime. Native modules (e.g. `better-sqlite3`) install into the service folder separately. Rebuild after each source change. esbuild only transpiles, so the build never type-checks the service. Type-check it explicitly (see [Type-checking a service](#type-checking-a-service)).

There is no first-class CLI command to rebuild a **live** agent's in-place service, so the repo ships one: `pnpm deploy:service <agent>/blueprint/service`, then restart. It bundles the way `buildService` (`packages/agent-kit/src/build-service.ts`) does for a fresh agent, but to a throwaway dir, and copies the four artifacts (`index.js`, `index.js.map`, `checksum.txt`, stripped `manifest.json`) back over `blueprint/service/`.

The throwaway dir matters: `buildService` wipes its output dir first, so pointing it at `blueprint/service/` itself would delete your `src/`. (`init` may pass the agent's `blueprint/service` as the output only because that folder is being created fresh from a template.)

Restarting the service is the only step that loads new service code (admin UI → the agent's ⋯ menu → **Restart Agent Service**, or restart the Cast server). Blueprint, identity, channels, and config hot-reload on their own, and a brand-new agent folder is discovered live.

> For quick local iteration you can set `"entry": "src/index.ts"` in the manifest to run the TypeScript source directly via tsx, skipping the bundle. This needs the service's dependencies resolvable from the agent folder and a server launched with tsx on PATH, so it fits a `pnpm dev` workspace rather than a bundled deploy.

### Type-checking a service

esbuild and the `tsx` path above both strip types without checking them, so building or running a service never type-checks it. Run `tsc` yourself before shipping a change.

The check is non-obvious because a service is an independent package whose dependency closure is not the workspace's. A naive `tsc` from the repo, or one pointed at the agent folder, resolves the wrong things or nothing at all:

- **Workspace deps** (`@getcast/*`, declared `workspace:*`) export their **source `.ts`**, not a built `.d.ts`. tsc resolves those only with `allowImportingTsExtensions`, and pnpm does not always expose them under the repo-root `node_modules`.
- **Registry deps can differ in version from the workspace.** A service on `zod@3` checked against the repo root's `zod@4` is checked against the wrong types.
- `@types/node` and any service-only dep (its own `zod`, a tokenizer, an API client) are not installed anywhere tsc can see from the agent folder, which lives outside the workspace.

Run `pnpm check:service <agent>/blueprint/service`. It gives tsc the service's real closure, mirroring how `buildService` resolves deps for esbuild (`packages/agent-kit/src/build-service.ts` is the authority for the algorithm):

1. Split the service `package.json` deps into workspace (`workspace:*`) and registry.
2. `pnpm install --ignore-workspace` the registry deps plus `@types/node` into a throwaway dir. `--ignore-workspace` yields **real `node_modules`** rather than pnpm symlinks, which break package `exports` resolution.
3. Alias each workspace dep to its source entry (`exports['.']`) through tsconfig `paths`.
4. Copy the service `src/*.ts` beside that `node_modules` and run `tsc` with `moduleResolution: NodeNext`, `allowImportingTsExtensions: true`, `strict`, `noEmit`.

A service-only dep that ships without bundled types can be covered by dropping a one-line `declare module` `.d.ts` into the service's `src/` (it gets copied into the check).

## Adding an MCP Tool

MCP tools are registered via `@getcast/agent-service-base` and served on a Unix socket at `{agent}/mcp/agent.sock`. This is separate from the server's `cast.sock` — both live in the `mcp/` directory but serve different tool sets.

Tools are registered using the `svc.tool()` method from `@getcast/agent-service-base`, which has the same signature as `McpServer.tool()`:

```typescript
import { createService } from '@getcast/agent-service-base';
import { z } from 'zod';

const svc = createService({ name: 'myservice' });

svc.tool(
  'myservice__search',           // namespace__action naming
  'Search the index',             // description
  { query: z.string(), limit: z.number().default(20) },  // input schema (zod)
  async ({ query, limit }) => {
    // Tool implementation — query service databases, call APIs, etc.
    return { content: [{ type: 'text', text: JSON.stringify(results) }] };
  },
);

await svc.start();
```

Tool names should use a namespace prefix to avoid collisions with server tools (e.g., `slack__search_fts`, `fireflies__list`).

For capabilities that are normally handled by extensions (email, calendar, web-fetch), the service can instantiate the extension class directly for advanced use cases like multi-account or custom policy:

```typescript
import { CalendarExtension } from '@getcast/ext-calendar';

// Direct instantiation — service manages its own context
const cal = new CalendarExtension(ctx);
const events = await cal.listEvents({ after: '2026-04-01' });
```

**Error handling in tool handlers:** Always catch errors and return them as `{ isError: true }` results. Critically, **log errors to stderr via `console.error`** so they appear in the server logs — the agent's error message is often truncated and the LLM may rephrase it. Without server-side logging, tool errors are invisible to operators:

```typescript
svc.tool('myservice__action', 'Do something', { id: z.string() }, async ({ id }) => {
  try {
    const result = await doSomething(id);
    return { content: [{ type: 'text', text: result }] };
  } catch (err) {
    console.error(`[service:${svc.agentFolder}] myservice__action error:`, err instanceof Error ? err.stack ?? err.message : String(err));
    return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
});
```

**After adding a tool**, the service should describe the tool via `svc.prompt` so the agent knows it exists. You may also update `identity/skills.md` for static tool documentation.

## Adding a Cron Job

Jobs are functions that run on a schedule. A job typically pulls data from an external source, writes results to `shared/ext/service/`, and optionally routes a summary message to the agent.

Services schedule cron jobs directly using `croner`:

```typescript
import { Cron } from 'croner';

if (svc.secrets.SLACK_BOT_TOKEN) {
  new Cron('*/30 * * * *', async () => {
    const result = await pullSlack(svc.agentDir, svc.secrets);
    if (result.newMessages > 0) {
      svc.routeMessage('summarize', `New Slack messages: ${desc}`);
    }
    updatePromptVars();
  });
}
```

### Routing messages to the agent

Use `svc.routeMessage()` to send a message to the agent after a job completes:

```typescript
if (result.newMessages > 0) {
  await svc.routeMessage('summarize', `New Slack messages: ${desc}`);
}
```

### Pushing to a specific participant

Use the optional `target` parameter to route a message that should be delivered to a specific participant. The agent on the target channel decides whether to respond (message delivered) or suppress with `<cast:internal>` tags (no notification):

```typescript
// Route to the default channel, targeting a specific Telegram user
await svc.routeMessage('default', `Important email from ${sender}: ${subject}`, 'tg:12345');
```

## Service Prompt Contribution

Services contribute dynamic context to the agent's system prompt via `svc.prompt`, which writes `shared/ext/service/agent-context.md`.

### Section mode (default)

Each subsystem owns a named section. Sections are independent — set and commit at any time without affecting other sections. `commit()` concatenates all non-empty sections and writes to disk.

```typescript
// Each subsystem sets its own section and commits independently
svc.prompt.set('gmail', '## Gmail\n- 5 channels synced');
svc.prompt.commit();

// Later, another subsystem updates its section
svc.prompt.set('calendar', '## Calendar\n- Connected');
svc.prompt.commit();
```

No `init()` needed. Each `commit()` writes all currently-set sections. Empty sections are omitted.

### Template mode (optional)

For cases where multiple vars compose a single section, call `init()` with `{{var}}` placeholders. `commit()` then validates all vars are filled before rendering.

```typescript
svc.prompt.init('## Status\n- Slack: {{slack_status}}\n- Send: {{gmail_send_status}}');
svc.prompt.set('slack_status', '5 channels synced');
svc.prompt.set('gmail_send_status', 'enabled');
svc.prompt.commit();
```

Template mode is activated by calling `init()`. Call `reset()` to return to section mode.

The server reads `shared/ext/service/agent-context.md` synchronously during prompt assembly and injects it as layer 9 of the system prompt.

## Key Dependencies

Services use `@getcast/agent-service-base` which bundles the common dependencies (MCP SDK, dotenv, zod). Additional service-specific deps:
- `better-sqlite3` — SQLite for service databases
- `@slack/web-api`, `imapflow`, etc. — domain-specific clients

## Operator Settings and Secrets

Declare the values your service needs in `blueprint/service/manifest.json`; the admin UI generates a form from the declaration (the Service card on the agent's Capabilities page):

```json
{
  "config": {
    "SCAN_INTERVAL": { "label": "Scan interval (minutes)", "type": "number", "default": 30 }
  },
  "secrets": {
    "HN_USERNAME": { "label": "HN username" },
    "HN_PASSWORD": { "label": "HN password", "secret": true, "required": true }
  }
}
```

Settings land in `config/ext/service/config.json` (native JSON types, read as `svc.settings`); credentials land in `config/ext/service/secrets.json` (flat strings, read as `svc.secrets`). Both are startup snapshots — saving from the admin UI (or hand-editing either file) restarts the service, so a startup read is always current. The admin surface rejects undeclared keys; keys you add to the files by hand are preserved on admin saves. Declared `default`s are displayed, not persisted — apply fallbacks in code (`svc.settings.SCAN_INTERVAL ?? 30`).

This declarative form covers flat values. Anything richer — multi-step setup, OAuth dances, status views — belongs on your own admin page (below).

## Admin Pages

Services can provide an admin UI accessible at `/agents/{folder}/admin/`. The cast server reverse-proxies these requests to a unix socket at `{agentDir}/admin.sock`. Declaring `"admin": true` in `blueprint/service/manifest.json` surfaces an "Open service admin page" link on the agent's Service card; the link authorizes the browser via a path-scoped cookie session set by an authenticated admin call (API callers send the admin Bearer header instead). The page is reachable only while the service is running — credentials that crash the service are fixed on the host-rendered form, which works regardless of service state.

### Simple handler (svc.admin)

For status pages and simple forms, use `svc.admin()`:

```typescript
svc.admin((req) => {
  // req: { path: string, method: string, query: Record<string, string>, body?: string }
  // body is the raw request body (≤ 1 MB) — parse forms with URLSearchParams, JSON with JSON.parse
  if (req.path === '/' || req.path === '') {
    return { status: 200, contentType: 'text/html', body: '<h1>Admin</h1>' };
  }
  return { status: 404, contentType: 'text/html', body: 'Not found' };
});
```

This starts an `http.createServer` on `svc.adminSocketPath`. Handles socket cleanup on startup and shutdown automatically.

### Advanced (direct socket)

For full HTTP features (Express, static assets, middleware), skip `svc.admin()` and listen on the socket directly:

```typescript
import express from 'express';
const app = express();
app.use(express.static('public'));
app.get('/', (req, res) => res.render('dashboard'));
app.listen(svc.adminSocketPath);
```

## OAuth Integration

For standard capabilities (Google Calendar, email), OAuth is handled by extensions and their server-side admin pages — not by services. See each extension's `manual/README.md` ADMIN section for OAuth setup details.

For custom OAuth integrations in services, `@getcast/agent-service-base` provides utilities:

| Import | From | Purpose |
|--------|------|---------|
| `oauth` | `@getcast/agent-service-base` | Pure functions: `buildConsentUrl()`, `exchangeCode()`, `refreshAccessToken()`, `GOOGLE_ENDPOINTS` |
| `createTokenManager` | `@getcast/agent-service-base` | Token lifecycle: lazy refresh, single-flight concurrency, expiry tracking |
| `loadCredentials` / `saveCredentials` | `@getcast/agent-service-base` | Persist refresh tokens in `ext/service/credentials.json` (private runtime) |

The service admin handler (`svc.admin()`) can host OAuth callback routes at `/agents/{folder}/admin/auth/{provider}/callback`. See `@getcast/agent-service-base` source for API details.

## Connecting to the Agent Contract

When you add service capabilities, the agent contract often needs updates:

- **New MCP tool** → describe via `svc.prompt` for dynamic docs, or update `identity/skills.md` for static guidance
- **New shared data** → update `identity/skills.md` if the agent should read it directly from `/shared/service`, or describe via `svc.prompt`
- **New cron job that routes messages** → may need a dedicated channel in `channels/` to receive those messages (e.g., a `summarize` channel with appropriate TTL and lifecycle)
- **New settings or secrets required** → declare them in the `config` / `secrets` fields of `blueprint/service/manifest.json`. The admin UI generates the form from the declaration; saves write `config/ext/service/{config,secrets}.json` and restart the service automatically (see "Operator Settings and Secrets")
