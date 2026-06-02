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

```
service/
  package.json               Dependencies (independent from host)
  manifest.json              Service identity: name, version
  src/
    index.ts                 Entry point: IPC listener, cron scheduling, MCP server startup
    mcp.ts                   MCP tool definitions (served on Unix socket)
```

The service source lives in `blueprint/service/` within the agent folder. The agent's runtime service CWD is `ext/service/` (private runtime — databases, caches) with operator-owned secrets in `config/ext/service/.env` and agent-visible output in `shared/ext/service/`.

**During development**, set `"entry": "src/index.ts"` in `blueprint/service/manifest.json`. The server will run the TypeScript source directly via tsx (no bundle step). Edit the source, then restart the agent's service to load the new code (admin UI → the agent's ⋯ menu → **Restart Agent Service**, or restart the Cast server). Only service *source* needs a restart. Blueprint, identity, channels, and config hot-reload on their own, and a brand-new agent folder is discovered live.

**For production**, the service is bundled to `blueprint/service/index.js` via esbuild (ESM, node20 target, sourcemaps). Native modules (e.g., `better-sqlite3`) are installed separately in the output directory.

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

## Admin Pages

Services can provide an admin UI accessible at `/agents/:agent/admin/`. The cast server reverse-proxies these requests to a unix socket at `{agentDir}/admin.sock`.

### Simple handler (svc.admin)

For status pages and simple forms, use `svc.admin()`:

```typescript
svc.admin((req) => {
  // req: { path: string, method: string, query: Record<string, string> }
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
- **New secrets required** → document in `config/ext/service/.env.example` and update operator instructions
