# Building Extension Admin Pages

Guide for building the tRPC router and admin UI page for a Cast extension. Each extension gets a sub-router under `extension.<name>` and a corresponding page in the admin UI.

## Source of truth

Each extension package has a `manual/README.md` with an `## ADMIN` section that defines:

- **SECRETS fields** — credentials stored in `config/ext/{name}/.env` (provider tokens, passwords, API keys)
- **CONFIG fields** — operator-tunable settings from `capabilities.json` (policies, limits, modes)
- **Field metadata** — input type, help text, default values, validation requirements
- **Setup flows** — any multi-step flows like OAuth consent or device pairing

Read the manual's ADMIN section. It is the spec for what the admin page should expose.

## Locked vs unlocked fields

Extension config has two layers:

1. **Author config** — `blueprint/props/capabilities.json` under `extensions.<name>`
2. **Operator config** — `config/ext/{name}/config.json` (overrides)

The author controls which fields the operator can change:

- **Bare value** = locked. Author wins, operator cannot override. Show as read-only in the UI with a lock indicator.
  ```json
  { "send_mode": "confirm" }
  ```

- **`{ unlocked: true, value: ... }`** = operator-editable. Show as a normal input.
  ```json
  { "send_mode": { "unlocked": true, "value": "confirm" } }
  ```

The `mergeExtensionConfig()` function in `extensions/registry.ts` implements this merge. The `enabled` and `channel` keys are framework concerns — strip them from config display.

## Shared helpers

Config reading, lock detection, secret masking, and config writing are shared across all extension routers. These live in `routers/extension/helpers.ts`. Reuse this file — do not duplicate the logic in each router.

```typescript
import { readExtensionConfig, writeExtensionConfig, maskSecret } from './helpers.js';
```

**`readExtensionConfig(folder, extName)`** — reads capabilities.json (author config with lock metadata) and config/ext/{name}/config.json (operator overrides). Returns `Record<string, { value, locked }>`.

**`writeExtensionConfig(folder, extName, updates)`** — rejects writes to locked fields, writes unlocked values to operator override file.

**`maskSecret(value)`** — masks a secret for display, showing only last 4 characters.

If helpers.ts doesn't exist yet, create it with these functions:

```typescript
import fs from 'fs';
import { agentPath } from '../../../config.js';

export function readExtensionConfig(
  folder: string,
  extName: string,
): Record<string, { value: unknown; locked: boolean }> {
  const capsPath = agentPath(folder, 'blueprint', 'props', 'capabilities.json');
  const caps = fs.existsSync(capsPath) ? JSON.parse(fs.readFileSync(capsPath, 'utf-8')) : {};
  const authorConfig = (caps.extensions?.[extName] ?? {}) as Record<string, unknown>;

  const overridePath = agentPath(folder, 'config', 'ext', extName, 'config.json');
  const overrides = fs.existsSync(overridePath)
    ? (JSON.parse(fs.readFileSync(overridePath, 'utf-8')) as Record<string, unknown>)
    : {};

  const fields: Record<string, { value: unknown; locked: boolean }> = {};
  for (const [key, raw] of Object.entries(authorConfig)) {
    if (key === 'enabled' || key === 'channel') continue;
    if (raw && typeof raw === 'object' && 'unlocked' in raw && 'value' in raw) {
      fields[key] = { value: overrides[key] ?? (raw as { value: unknown }).value, locked: false };
    } else {
      fields[key] = { value: raw, locked: true };
    }
  }
  return fields;
}

export function writeExtensionConfig(
  folder: string,
  extName: string,
  updates: Record<string, unknown>,
): void {
  const fields = readExtensionConfig(folder, extName);
  for (const key of Object.keys(updates)) {
    if (fields[key]?.locked) throw new Error(`Field "${key}" is locked by the author`);
  }
  const overridePath = agentPath(folder, 'config', 'ext', extName, 'config.json');
  const existing = fs.existsSync(overridePath)
    ? (JSON.parse(fs.readFileSync(overridePath, 'utf-8')) as Record<string, unknown>)
    : {};
  for (const [key, value] of Object.entries(updates)) existing[key] = value;
  fs.mkdirSync(agentPath(folder, 'config', 'ext', extName), { recursive: true });
  fs.writeFileSync(overridePath, JSON.stringify(existing, null, 2));
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return '••••';
  return '••••' + value.slice(-4);
}
```

## tRPC sub-router pattern

Create a file at `packages/cast/src/admin/routers/extension/<name>.ts`:

```typescript
import fs from 'fs';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { adminProcedure, router } from '../../trpc.js';
import { agentPath } from '../../../config.js';
import { readEnvFile, writeEnvFile } from '../../../lib/env-file.js';
import { readExtensionConfig, writeExtensionConfig, maskSecret } from './helpers.js';

const EXT_NAME = '<name>';
const folderInput = z.object({ folder: z.string() });

export const <name>Router = router({
  getConfig: adminProcedure.input(folderInput).query(({ input }) => {
    // Read secrets from .env, mask sensitive values
    const envPath = agentPath(input.folder, 'config', 'ext', EXT_NAME, '.env');
    const rawSecrets = readEnvFile(envPath);
    const secrets: Record<string, { value: string; set: boolean }> = {};
    for (const key of SECRET_KEYS) {
      const val = rawSecrets[key];
      secrets[key] = val ? { value: maskSecret(val), set: true } : { value: '', set: false };
    }

    // Read config with lock metadata
    const config = readExtensionConfig(input.folder, EXT_NAME);

    return { secrets, config };
  }),

  setConfig: adminProcedure
    .input(z.object({
      folder: z.string(),
      config: z.record(z.string(), z.unknown()).optional(),
      secrets: z.record(z.string(), z.string()).optional(),
    }))
    .mutation(({ input }) => {
      if (input.config) writeExtensionConfig(input.folder, EXT_NAME, input.config);
      if (input.secrets) {
        const envPath = agentPath(input.folder, 'config', 'ext', EXT_NAME, '.env');
        fs.mkdirSync(agentPath(input.folder, 'config', 'ext', EXT_NAME), { recursive: true });
        writeEnvFile(envPath, input.secrets);
      }
      return { ok: true };
    }),

  // Add extension-specific procedures as needed (OAuth, pairing, validation)
});
```

Register the router in `extension/index.ts`:

```typescript
import { <name>Router } from './<name>.js';

export const extensionRouter = router({
  <name>: <name>Router,
});
```

## Connect — extensions own auth and discovery

### Design rationale

The admin layer must **not** import protocol libraries (imapflow, tsdav, baileys, etc.) or reimplement connection logic. Each extension knows its own protocol, credentials, and what resources it can discover. Centralizing this in the admin layer would mean the admin reimplements every extension — and breaks every time an extension changes.

Instead, the extension definition declares an optional `connect` hook that does two things in one call: **verify credentials work** and **discover available resources**. The admin layer calls it generically via the extension registry — one shared tRPC procedure for all extensions.

The return type uses `state?: unknown` on the generic interface. Each extension exports a Zod schema (`AdminState`) that defines its specific state shape. The admin UI imports the schema and calls `.parse(result.state)` to recover full types. The extension self-validates its own output by calling `AdminState.parse()` before returning — this prevents drift between the schema and the implementation.

This gives us: auth and discovery owned by the extension, typed state consumed by the admin UI, compile-time safety via schema imports, and zero protocol knowledge in the admin layer.

### Extension side

The extension defines `connect` and exports an `AdminState` schema:

```typescript
// ext-email/src/schemas.ts
export const EmailAdminState = z.object({
  folders: z.array(z.object({ path: z.string(), name: z.string() })),
});

// ext-email/src/helpers.ts
export async function connect(privateDir: string): Promise<{
  ok: boolean; message: string; state?: unknown;
}> {
  // Read .env, validate secrets, attempt connection
  // On success, discover resources and self-validate:
  const state = EmailAdminState.parse({ folders: [...] });
  return { ok: true, message: '...', state };
}

// ext-email/src/index.ts
import { connect } from './helpers.js';
export const email = defineExtension({ ..., connect });
```

The `privateDir` parameter is the full path to `ext/{name}/` (private runtime). The extension reads its own `.env` from `config/ext/{name}/.env`. The `.parse()` call ensures the schema and implementation can't drift.

### Admin router side

One generic procedure in `helpers.ts` — calls `def.connect(privateDir)` via the extension registry:

```typescript
connect: adminProcedure
  .input(z.object({ folder: z.string(), extension: z.string() }))
  .mutation(async ({ input }) => {
    const def = getRegisteredExtensions().get(input.extension);
    if (!def?.connect) return { ok: true, message: 'No connection test available', state: null };
    const privateDir = agentPath(input.folder, 'ext', input.extension);
    return def.connect(privateDir);
  }),
```

### Admin UI side

The page imports the extension's schema for typed access to `state`:

```typescript
import { EmailAdminState } from '@getcast/ext-email/schemas';

const result = await trpc.extension.shared.connect.mutate({ folder, extension: 'email' });
if (result.ok && result.state) {
  const state = EmailAdminState.parse(result.state);
  // state.folders is fully typed: Array<{ path: string; name: string }>
}
```

### What state contains

Each extension defines its own state shape. The admin UI reads the manual's ADMIN section to understand what the fields mean and how to render them. Examples:

- **email** — `{ folders: [{ path, name }] }` — discovered IMAP mailbox folders
- **calendar** — `{ provider, calendars: [{ id, name, primary? }] }` — discovered calendars
- **whatsapp** — `{ paired }` — whether auth session exists (discovery needs running instance)
- **web-fetch** — no `connect` hook (config-only, no credentials)

## Shared UI components

Extension admin pages share the same form patterns — text inputs, password inputs, dropdowns, toggles, list editors, lock indicators, save buttons, status messages. These live in `packages/web-ui/src/admin/pages/extensions/shared.tsx`. Reuse these components — do not rebuild form primitives in each extension page.

Key components:
- `TextInput` / `NumberInput` — with `locked` prop for read-only display + lock icon
- `SecretInput` — password input with `isSet` indicator
- `SelectInput` — dropdown with `locked` prop
- `ToggleInput` — boolean toggle with `locked` prop
- `ListInput` — tag-style list editor (add/remove items) with `locked` prop
- `LockIcon` — visual indicator for author-locked fields
- `SectionHeading` — consistent section headers
- `SaveButton` — with pending/loading state
- `StatusMessage` — success/error feedback
- `InfoBox` — help text container

If shared.tsx doesn't exist yet, create it with these components following the dark mode styling (gray-950 backgrounds, gray-700 borders, blue-500 accents, disabled inputs use gray-900/gray-800).

## Admin UI page pattern

Create a page component at `packages/web-ui/src/admin/pages/extensions/<name>.tsx`. The component receives `{ folder: string }` as props and is rendered by the Extensions tab in the agent detail page.

```typescript
export function <Name>ExtensionPage({ folder }: { folder: string }) {
  const configQuery = trpc.extension.<name>.getConfig.useQuery({ folder });
  const setConfig = trpc.extension.<name>.setConfig.useMutation({ ... });
  // ...
}
```

The page should:

1. Call `trpc.extension.<name>.getConfig.useQuery({ folder })` to load current state
2. **Secrets masking:** Only mask actual passwords and tokens. Public identifiers (email addresses, hostnames, client IDs, URLs, ports) should be returned unmasked by the backend and pre-filled as input values in `useEffect`, not shown as placeholders. Use `SecretInput` only for passwords/tokens.
3. Render config fields using the shared input components — check `locked` flag per field:
   - `locked: true` → component renders disabled with `LockIcon`
   - `locked: false` → normal editable input
4. **Show current state without extra steps.** If a value is already configured (e.g. a selected calendar, a connected account), display it immediately on page load. Don't require the user to click Connect/Discover just to see what's already saved.
5. On submit, call `trpc.extension.<name>.setConfig.useMutation()` with only changed values
6. For multi-step flows (OAuth, device pairing), add extension-specific procedures and corresponding UI states

### Wiring into the agent detail page

Every page in the agent detail view is URL-routed — tabs, extension list, and individual extension pages all have their own URLs. Navigation uses `<a>` tags with wouter's `useLocation()` for client-side routing. No `useState` for navigation state.

**URL structure:**
- `/agents/{folder}` — overview tab (default)
- `/agents/{folder}/{tab}` — specific tab (settings, conversations, channels, access, extensions, mcp-servers)
- `/agents/{folder}/extensions/{name}` — specific extension page (email, calendar, etc.)

The Extensions tab in `packages/web-ui/src/admin/pages/agent-detail.tsx` shows only extensions enabled for the current agent. It queries `extension.shared.listEnabled` which reads `capabilities.json` and returns only extension names where `enabled: true`. The tab renders a grid of link cards for enabled extensions.

To add a new extension page, add entries to the two lookup maps in `agent-detail.tsx`:
- `EXTENSION_LABELS` — maps extension name to display label (e.g. `'email': 'Email'`)
- `EXTENSION_PAGES` — maps extension name to page component (e.g. `'email': EmailExtensionPage`)

**Do not hardcode a list of extensions.** The enabled set comes from capabilities.json, not from the UI code. Extensions not in `EXTENSION_LABELS`/`EXTENSION_PAGES` still show up as cards (using the raw name) but display "No admin page for this extension" when clicked.

## Page manual — `pageManual` export

Every admin page (both `admin/pages/*.tsx` and `admin/pages/extensions/*.tsx`) exports a `pageManual: PageManualEntry`. These entries tell the Configure console what pages exist, what each is for, and what section anchors are available — so the bot can land the user on a specific spot via `admin__navigate({ target, within, reason })` without guessing.

### Shape

The canonical schema lives in `@getcast/admin-schema/v1` (`packages/admin-schema/src/v1/page-manual.ts`) — both the producer (web-ui) and the consumer (cast) import the same Zod definition. See that file for the full type; in summary:

- `purpose` — one line on what the page is for (required)
- `actions?` — operator-visible actions when the page has no sections
- `sections?` — array of `{ anchor, purpose, actions? }` entries

Granularity is capped at section. No per-field / per-button entries — the bot can read the DOM if it needs finer detail.

### Examples

**Minimal** — `packages/web-ui/src/admin/pages/overview.tsx`:

```typescript
import type { PageManualEntry } from '@getcast/admin-schema/v1';

export const pageManual: PageManualEntry = {
  purpose: 'Server overview — agent list with live conversation counts, transport route health, pending approval indicators. Entry point; links out to detail pages.',
};
```

**With actions** — an extension page like `pages/extensions/email.tsx`:

```typescript
export const pageManual: PageManualEntry = {
  purpose: 'Email extension config for this agent — IMAP/SMTP credentials, inbound scope + read policy, outbound recipients + send policy. Secret writes happen through this form, not chat.',
  actions: [
    'Fill EMAIL_ADDRESS / EMAIL_PASSWORD / IMAP & SMTP host+port (secret write)',
    'Test IMAP/SMTP connection',
    'Set inbound read policy (all / unseen / flagged)',
    'Set outbound send policy (confirm / auto)',
  ],
};
```

**With sections** — pages that have distinct scrollable regions (e.g. `access.tsx`, `config.tsx`) list them so the bot can anchor-link. Each `anchor` must match the DOM id on the corresponding section heading, and that heading should have `scroll-mt-20` so the anchor lands below the sticky nav.

### Build wiring

1. `packages/web-ui/src/admin/manual.ts` imports every page module and builds an `AdminManual` map keyed by route pattern (e.g. `/agents/:folder/access`, `/agents/:folder/extensions/email`).
2. `packages/web-ui/vite-plugin-admin-manual.ts` runs as a Vite plugin — in dev it serves the registry via a dev endpoint; in prod it writes `dist/admin-manual.json` alongside the bundle.
3. Server-side, `packages/cast/src/console/shared/page-manual.ts` loads that JSON at startup and exposes it via `ConsoleMcpDeps`. The Configure prompt assembly injects a formatted index into the dynamic snapshot.
4. `admin__navigate` does not validate `target` — it forwards whatever the bot emits as a `ui_directive` SSE event. Cast does not classify the directive's target; the admin UI interprets it (route push, drawer tab, modal, anchor scroll). The page-manual injected into the prompt is the bot's catalogue of valid targets, not a runtime gate.

### Engineer checklist for a new admin page

1. Export `pageManual: PageManualEntry` at the top of the component file.
2. Add the route mapping to `packages/web-ui/src/admin/manual.ts` (it uses a hardcoded route-pattern → module-path map).
3. If you're using sections, add a `scroll-mt-20` class on each section heading so anchor scrolling lands correctly.
4. `pnpm -F @getcast/web-ui build` re-emits `dist/admin-manual.json`. In dev, Vite HMR picks up changes automatically.
5. In a live Configure session, verify the bot can see and navigate to the new page: *"take me to the access page on agent foo"* → bot calls `admin__navigate({ target: '/agents/foo/access', reason: '...' })` → the browser navigates.

## OAuth redirect flows

If the extension requires OAuth (browser redirects), add the Express routes **in the same router file** as the tRPC router — tRPC cannot handle HTTP redirects. Export a factory function alongside the tRPC router:

```typescript
// In routers/extension/<name>.ts

export const myExtRouter = router({ /* tRPC procedures */ });

// OAuth routes — colocated with the tRPC router
export function createMyExtOAuthRouter(): RouterType {
  const oauthRouter = Router();

  // /start is a browser redirect — no Bearer token possible.
  // CSRF protection is on the callback side (random state).
  oauthRouter.get('/<provider>/start', (req, res) => {
    const folder = req.query['agent'] as string;
    const state = crypto.randomUUID();
    pendingFlows.set(state, { folder, uiOrigin: /* from Referer */ });
    setTimeout(() => pendingFlows.delete(state), 10 * 60 * 1000).unref();
    // Build consent URL, redirect to provider
    res.redirect(consentUrl);
  });

  oauthRouter.get('/<provider>/callback', async (req, res) => {
    const flow = pendingFlows.get(req.query['state']);
    pendingFlows.delete(req.query['state']);
    // Exchange code for tokens, write to config/ext/{name}/.env
    // Redirect back to the extension's own admin page (not the extension list):
    // `${flow.uiOrigin}/admin/agents/${folder}/extensions/<name>?oauth=success`
  });

  return oauthRouter;
}
```

Then register it in `routers/extension/index.ts`:

```typescript
import { createMyExtOAuthRouter } from './<name>.js';

export function createExtensionOAuthRouter(): RouterType {
  const oauthRouter = Router();
  oauthRouter.use(createCalendarOAuthRouter());
  oauthRouter.use(createMyExtOAuthRouter());  // add here
  return oauthRouter;
}
```

The collected OAuth router is mounted at `/api/oauth` in `admin/index.ts`.

**Deep-link routing:** OAuth callbacks redirect to `/admin/agents/{folder}/extensions/{name}` — the extension's own admin page, not the extension list. The admin UI router matches `/agents/:folder/:tab/:subtab` and passes the subtab as `initialExtension` to `ExtensionsTab`, which renders the extension page directly. This means the user lands back on the calendar (or whichever) page with the `?oauth=success` banner visible. All extension pages are bookmarkable and support browser back/forward.

**Redirect URI:** The callback URL registered with the OAuth provider is `http://127.0.0.1:{WEB_PORT}/api/oauth/<provider>/callback`. Document this in the extension's `manual/README.md` and show it in the admin UI page (see calendar extension for the pattern).

**UI-side:** Use `API_BASE` (from `trpc.ts`) when linking to OAuth start routes, since the admin UI and API server may run on different ports:

```typescript
import { API_BASE } from '../../trpc';
window.location.href = `${API_BASE}/api/oauth/<provider>/start?agent=${encodeURIComponent(folder)}`;
```

## Validation

**Config validation** happens automatically via Zod schemas — the extension's `configSchema` and `secretsSchema` validate inputs. The admin router should parse with these schemas on save.

**Connection validation** uses the `connect` hook described above. The UI should show a "Connect" button that calls the generic `extension.shared.connect` procedure. Display the result with `StatusMessage`. If the extension has no `connect` hook, hide the button. If the result includes `state`, parse it with the extension's exported `AdminState` schema and render discovered resources (selectable calendars, folder list, etc.).

## File locations

| What | Where |
|------|-------|
| Extension manual | `packages/ext-{name}/manual/README.md` |
| tRPC sub-router | `packages/cast/src/admin/routers/extension/{name}.ts` |
| Shared server helpers | `packages/cast/src/admin/routers/extension/helpers.ts` |
| Router index | `packages/cast/src/admin/routers/extension/index.ts` |
| OAuth routes | `packages/cast/src/admin/oauth.ts` |
| UI page | `packages/web-ui/src/admin/pages/extensions/{name}.tsx` |
| Shared UI components | `packages/web-ui/src/admin/pages/extensions/shared.tsx` |
| Agent detail (wiring) | `packages/web-ui/src/admin/pages/agent-detail.tsx` |
| Author config | `$CAST_AGENTS_DIR/{folder}/blueprint/props/capabilities.json` |
| Operator config | `$CAST_AGENTS_DIR/{folder}/config/ext/{name}/config.json` |
| Secrets | `$CAST_AGENTS_DIR/{folder}/config/ext/{name}/.env` |
| Config merge logic | `packages/cast/src/extensions/registry.ts` → `mergeExtensionConfig()` |
| Env file utility | `packages/cast/src/lib/env-file.ts` |
