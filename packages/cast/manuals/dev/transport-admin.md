# Building Transport Admin Sections

Guide for adding a new routed transport to Cast. Each transport is a single
file in `packages/cast/src/transports/` exporting `defineTransport({...})`,
plus one `registerTransport(...)` line in `index.ts`. The admin UI surface
(token entry form, route list) is a separate, presently-hardcoded layer that
also needs touching — see [admin sections](#admin-ui-surface) below.

## Source of truth

Transport routes live in `routes.json` in `CAST_CONFIG_DIR`. Each transport
type is an array of route entries mapping credentials to agent addresses.
The file is hot-reloaded on change by `reconcileRoutedTransports()`
in `index.ts` (filesystem-watched, debounced) — no server restart required after edits.

The top-level shape of `routes.json` is `{ [transportName]: unknown[] }` —
the registry validates each slice against its transport's `configSchema` at
load time. The cast server doesn't know about specific transports at the
schema layer; per-transport schemas live on each transport's
`defineTransport({...})` value.

## Transport file

Create `packages/cast/src/transports/<name>.ts`:

1. Define a Zod schema for one route entry, e.g. `MyTransportRouteSchema`.
2. Define `MyTransportConfigSchema = z.array(MyTransportRouteSchema).default([])`.
3. Implement a `Transport` class with `connect`, `disconnect`, `isConnected`,
   `ownsParticipant`, `send`, `sendEvent`. The class owns one address-prefix
   namespace (e.g. `tg:`, `slack:`).
4. Export a `defineTransport({...})` value with `name`, `addressPrefix`,
   `configSchema`, and `create`.

Example:

```typescript
export const myTransport = defineTransport<MyTransportConfig>({
  name: 'myTransport',
  addressPrefix: 'mt',
  configSchema: MyTransportConfigSchema,
  create: (ctx, routes) => {
    if (routes.length === 0) return null;
    const bindings = /* ... validate, resolve addresses ... */;
    return new MyTransport(ctx, bindings);
  },
});
```

`addressPrefix` is the participant-address namespace this transport owns.
The registry rejects `RESERVED_PREFIXES` (`u`, `a`, `ext`, `cast`, `local`,
`cli`, `web`, `admin`, `console`) at registration time, plus any prefix
already claimed by another registered transport.

## Wire it into the server

In `packages/cast/src/index.ts`:

1. Add `import { myTransport } from './transports/myTransport.js';`
2. Add `registerTransport(myTransport);` near the other `registerTransport(...)` calls (lines ~55-57).

That's it. The bus prefix registration, hot-reload, and shutdown path all
flow through the registry — no `routedNames` set to update, no
`bus.register('mt', ...)` line to add, no bespoke `loadXxxTransports` block.

## Admin UI surface

The admin UI is **not** plugged into the registry today — the route list and
edit form are hardcoded to the existing transports (telegram, email, slack
as of this writing). Adding a transport to the admin UI is a separate,
mostly-mechanical port of the existing pattern. Genericizing this surface
to dispatch from the registry is a deferred refactor.

To extend the admin UI for a new transport:

### Backend (`packages/cast/src/admin/`)

1. **`schemas.ts`** — define `myTransportRouteInput` (Zod schema for the
   admin form payload, may differ slightly from the transport's own
   configSchema if you want the admin to mask/expand fields differently).
   Add `myTransport: z.array(myTransportRouteInput).default([])` to
   `routeUpdateInput`.

2. **`routers/route.ts`** — in `list`, parse the slice with
   `parseSlice<MyTransportRoute>(routes.myTransport, MyTransportRouteSchema)`,
   map to a UI-shape array (mask any secret fields with `maskToken`). In
   `update`, resolve masked secrets via `resolveSecret()` against existing
   on-disk values, then include the new array in the `updated` object
   written to disk.

### Frontend (`packages/web-ui/src/admin/`)

3. **`schemas/route.ts`** — add `MyTransportDraftSchema` to the discriminated
   union, extend `RouteDraft`. Extend `RoutesServerData` to mirror the new
   `list` response shape. Add a branch to `draftFromEntry` for editing, and
   to `routesFormToPayload` / `routesRemovePayload` for building the
   mutation. `buildBasePayload` is the single point that re-projects the
   server data into mutation shape — extend it once.

4. **`pages/routes.tsx`** — add the new type to `TransportType` and
   `TRANSPORT_LABELS`. Add an `<option>` to the dropdown. Add a per-type
   form fragment (mirror the `{type === 'telegram' && ...}` blocks). Add the
   transport's entries to the flattened `entries` list and update
   `entrySource()` to match.

### Secret masking convention

- **Mask on read**: `maskToken()` shows `••••` + last 4 chars
- **Preserve on write**: `resolveSecret()` checks if the incoming value
  starts with `••••` — if so, keeps the existing value
- Use `type="password"` in the UI for secret fields

## File locations

| What | Where |
|------|-------|
| Transport contract + registry | `packages/cast/src/transports/{schema,registry}.ts` |
| Transport implementations | `packages/cast/src/transports/<name>.ts` |
| Transport registration | `packages/cast/src/index.ts` |
| Admin tRPC schema | `packages/cast/src/admin/schemas.ts` |
| Admin tRPC router | `packages/cast/src/admin/routers/route.ts` |
| Admin UI page | `packages/web-ui/src/admin/pages/routes.tsx` |
| Admin UI schema | `packages/web-ui/src/admin/schemas/route.ts` |
| Sidebar nav | `packages/web-ui/src/admin/layout.tsx` |
| Admin router | `packages/web-ui/src/admin/router.tsx` |
| File cache | `packages/cast/src/lib/file-cache.ts` |
| Config file | `CAST_CONFIG_DIR/routes.json` |
