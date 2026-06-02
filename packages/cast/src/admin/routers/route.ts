/**
 * Route router — transport routing (read + write), registry-driven.
 *
 * No transport names are hardcoded here. The list/update procedures walk
 * `getRegisteredTransports()`, project per-entry data through each transport's
 * admin descriptor (lensing nested paths via descriptor.fields[].path), mask
 * `secret` fields on read, and resolve masked secrets back against the
 * existing on-disk value on write.
 */
import fs from 'fs';
import path from 'path';

import { CONFIG_DIR } from '../../config.js';
import { loadRoutes } from '../../gateway/routes.js';
import { getRegisteredTransports } from '../../transports/registry.js';
import type { AdminField } from '../../transports/schema.js';
import { writeAtomic } from '../../lib/utils.js';
import { routeUpdateInput } from '../schemas.js';
import { adminProcedure, router } from '../trpc.js';

const MASK = '••••';

function maskSecret(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  if (value.length <= 8) return MASK;
  return MASK + value.slice(-4);
}

function isMasked(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(MASK);
}

// ---------------------------------------------------------------------------
// Path lens — getPath / setPath for descriptor `path` fields ('imap.host')
// ---------------------------------------------------------------------------

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

function setPath(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    const next = cur[k];
    if (next == null || typeof next !== 'object') {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

function fieldPath(field: AdminField): string {
  return field.path ?? field.key;
}

// ---------------------------------------------------------------------------
// Per-entry projection: stored entry → form fields (with secret masking)
// ---------------------------------------------------------------------------

function entryToFormFields(
  entry: Record<string, unknown>,
  fields: readonly AdminField[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const raw = getPath(entry, fieldPath(f));
    out[f.key] = f.secret ? maskSecret(raw) : (raw ?? '');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Routes file IO
// ---------------------------------------------------------------------------

function readRoutesFile(): Record<string, unknown[]> {
  const all = loadRoutes() as Record<string, unknown>;
  const out: Record<string, unknown[]> = {};
  for (const [k, v] of Object.entries(all)) {
    out[k] = Array.isArray(v) ? v : [];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const routeRouter = router({
  /**
   * Per-transport admin descriptors — drives the generic add/edit form on
   * the web side. Excludes `summarize` (server-side only) since tRPC can't
   * ship functions; the server pre-computes summaries in `list`.
   */
  transportTypes: adminProcedure.query(() => {
    return Array.from(getRegisteredTransports().values(), (def) => ({
      name: def.name,
      displayLabel: def.admin.displayLabel,
      fields: def.admin.fields.map((f) => ({
        key: f.key,
        type: f.type,
        label: f.label,
        placeholder: f.placeholder,
        helpText: f.helpText,
        group: f.group,
        secret: f.secret ?? false,
        optional: f.optional ?? false,
      })),
      setupInstructions: def.admin.setupInstructions,
    }));
  }),

  list: adminProcedure.query(({ ctx }) => {
    const file = readRoutesFile();
    const transports = ctx.deps.getTransports();
    const isOnline = (name: string) => transports.some((t) => t.name === name && t.isConnected());

    const byType: Record<string, Array<{
      address: string;
      channel: string | null;
      online: boolean;
      summary: string;
      fields: Record<string, unknown>;
    }>> = {};

    for (const [name, def] of getRegisteredTransports()) {
      const slice = file[name] ?? [];
      const entries: Array<{
        address: string;
        channel: string | null;
        online: boolean;
        summary: string;
        fields: Record<string, unknown>;
      }> = [];

      for (const raw of slice) {
        // Parse against the transport's own schema; entries that don't pass
        // are dropped from the admin view (would also fail at boot — surfacing
        // them here adds noise without giving the operator a useful action).
        const parsed = (def.configSchema as { safeParse: (v: unknown) => { success: true; data: unknown } | { success: false } })
          .safeParse([raw]);
        if (!parsed.success) continue;
        const validated = (parsed.data as unknown[])[0] as Record<string, unknown>;

        entries.push({
          address: String(validated.address ?? ''),
          channel: typeof validated.channel === 'string' ? validated.channel : null,
          online: isOnline(name),
          summary: def.admin.summarize(validated),
          fields: entryToFormFields(validated, def.admin.fields),
        });
      }

      byType[name] = entries;
    }

    return { byType };
  }),

  update: adminProcedure
    .input(routeUpdateInput)
    .mutation(({ input }) => {
      const existing = readRoutesFile();
      const updated: Record<string, unknown[]> = { ...existing };

      for (const [name, def] of getRegisteredTransports()) {
        const incoming = input.byType[name] ?? [];
        const existingSlice = existing[name] ?? [];

        // Validate the existing slice through the transport's schema so secret
        // resolution reads canonical values (not raw on-disk bytes).
        const parsedExisting = (def.configSchema as { safeParse: (v: unknown) => { success: true; data: unknown } | { success: false } })
          .safeParse(existingSlice);
        const validatedExisting = (parsedExisting.success ? (parsedExisting.data as unknown[]) : []) as Array<Record<string, unknown>>;

        const next: unknown[] = [];
        for (let i = 0; i < incoming.length; i++) {
          const draft = incoming[i]!;
          const prev = validatedExisting[i] ?? null;

          // Start from the previous entry to preserve un-exposed fields
          // (slack's allowedTeamIds, email's whitelist, etc.).
          const entry: Record<string, unknown> = prev ? { ...prev } : {};
          entry.address = draft.address;
          if (draft.channel) entry.channel = draft.channel;
          else delete entry.channel;

          // Lens form fields back onto the entry; resolve masked secrets.
          for (const f of def.admin.fields) {
            const formVal = draft.fields[f.key];
            const targetPath = fieldPath(f);
            if (f.secret && isMasked(formVal)) {
              // Keep the existing value at this path.
              if (prev) {
                const prevVal = getPath(prev, targetPath);
                setPath(entry, targetPath, prevVal);
              }
              continue;
            }
            const coerced = f.type === 'number'
              ? (typeof formVal === 'number' ? formVal : Number(formVal))
              : formVal;
            setPath(entry, targetPath, coerced);
          }

          next.push(entry);
        }

        updated[name] = next;
      }

      const routesPath = path.join(CONFIG_DIR, 'routes.json');
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      writeAtomic(routesPath, JSON.stringify(updated, null, 2));

      return { ok: true };
    }),
});
