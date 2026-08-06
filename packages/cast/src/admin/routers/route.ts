/**
 * Route router — transport routing (read + write), registry-driven.
 *
 * No transport names are hardcoded here. The list/update procedures walk
 * `getRegisteredTransports()`, project per-entry data through each transport's
 * admin descriptor (lensing nested paths via descriptor.fields[].path), mask
 * `secret` fields on read, and resolve masked secrets back against the
 * existing on-disk value on write.
 *
 * `update` receives the whole list on every save and pairs each row with its
 * stored entry by identity (address + channel), never by position — see
 * `identityKey`.
 */
import fs from 'fs';
import path from 'path';

import type { z } from 'zod';

import { TRPCError } from '@trpc/server';

import { CONFIG_DIR } from '../../config.js';
import { loadRoutes } from '../../gateway/routes.js';
import { getRegisteredTransports } from '../../transports/registry.js';
import type { AdminField, TransportDefinition } from '../../transports/schema.js';
import { writeAtomic } from '../../lib/utils.js';
import { routeEntryInput, routeUpdateInput } from '../schemas.js';
import { adminProcedure, router } from '../trpc.js';

type RouteFormRow = z.infer<typeof routeEntryInput>;
type StoredEntry = Record<string, unknown>;

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
// Form rows → stored entries: identity pairing + masked-secret resolution
// ---------------------------------------------------------------------------

/**
 * Identity of a route entry — the agent address plus the channel it binds.
 * That pair is what makes a route distinct at the gateway and what the
 * operator sees in the table.
 *
 * Position is *not* identity: the form submits the whole list on every save
 * and freely reorders, inserts and removes rows, so pairing by array index
 * hands a row its neighbour's credentials. An absent channel and an empty one
 * are the same route (`update` stores neither).
 */
function identityKey(address: unknown, channel: unknown): string {
  const chan = typeof channel === 'string' ? channel : '';
  return `${String(address ?? '')}\u0000${chan}`;
}

/**
 * Bucket the stored slice by identity, preserving file order within a bucket.
 *
 * Duplicate address+channel pairs are legal (two bots feeding the same
 * agent+channel differ only by credential) and indistinguishable from each
 * other, so duplicates pair in file order and every stored entry is claimed at
 * most once. A row that collides with an already-claimed entry therefore reads
 * as new rather than cloning its twin's secret.
 */
function bucketByIdentity(entries: StoredEntry[]): Map<string, StoredEntry[]> {
  const buckets = new Map<string, StoredEntry[]>();
  for (const entry of entries) {
    const key = identityKey(entry.address, entry.channel);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(entry);
    else buckets.set(key, [entry]);
  }
  return buckets;
}

/**
 * Validate a routes.json slice through the transport's own schema so callers
 * read canonical values rather than raw on-disk bytes. The registry erases
 * `configSchema` to `ZodType<unknown>`; routed transports parse to an array of
 * entries, which is what the admin surface is written against.
 */
function parseSlice(def: TransportDefinition<unknown>, slice: unknown): StoredEntry[] {
  const parsed = def.configSchema.safeParse(slice);
  return parsed.success ? (parsed.data as StoredEntry[]) : [];
}

/** Project one form row back onto the stored entry it came from (or a fresh one). */
function formRowToEntry(def: TransportDefinition<unknown>, draft: RouteFormRow, prev: StoredEntry | null): StoredEntry {
  // Start from the previous entry to preserve un-exposed fields
  // (slack's allowedTeamIds, email's whitelist, etc.).
  const entry: StoredEntry = prev ? { ...prev } : {};
  entry.address = draft.address;
  if (draft.channel) entry.channel = draft.channel;
  else delete entry.channel;

  // Lens form fields back onto the entry; resolve masked secrets.
  for (const f of def.admin.fields) {
    const formVal = draft.fields[f.key];
    const targetPath = fieldPath(f);
    if (f.secret && isMasked(formVal)) {
      // A mask means "unchanged", so it resolves against this row's own stored
      // entry and nothing else. With no stored value behind it there is nothing
      // to keep, and writing the mask (or a blank) would burn the credential —
      // reject instead, leaving routes.json exactly as it was.
      const kept = prev ? getPath(prev, targetPath) : undefined;
      if (kept == null || kept === '') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `No stored ${f.label} to keep for ${def.admin.displayLabel} route "${draft.address}". Enter it to save this route.`,
        });
      }
      setPath(entry, targetPath, kept);
      continue;
    }
    const coerced = f.type === 'number'
      ? (typeof formVal === 'number' ? formVal : Number(formVal))
      : formVal;
    setPath(entry, targetPath, coerced);
  }

  return entry;
}

/**
 * Rebuild one transport's routes.json slice from the submitted form rows.
 *
 * Pairing is by identity, never by position, so a save that reorders, inserts
 * or removes rows still resolves each masked secret against the route it came
 * from — and a route left untouched by the operator keeps its own credential.
 */
function resolveSlice(def: TransportDefinition<unknown>, incoming: RouteFormRow[], existingSlice: unknown[]): unknown[] {
  const buckets = bucketByIdentity(parseSlice(def, existingSlice));
  return incoming.map((draft) => {
    const prev = buckets.get(identityKey(draft.address, draft.channel))?.shift() ?? null;
    return formRowToEntry(def, draft, prev);
  });
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
        const validated = parseSlice(def, [raw])[0];
        if (!validated) continue;

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

      // Resolve every transport before writing anything — an unresolvable
      // masked secret throws, and the file must survive the rejection intact.
      for (const [name, def] of getRegisteredTransports()) {
        const incoming = input.byType[name];
        // A transport the payload omits is untouched, not emptied. The admin
        // page posts every registered transport (an empty array is how the
        // operator removes the last route of one), so a missing key is a
        // partial submission — clearing its routes would be silent data loss.
        if (!incoming) continue;
        updated[name] = resolveSlice(def, incoming, existing[name] ?? []);
      }

      const routesPath = path.join(CONFIG_DIR, 'routes.json');
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
      writeAtomic(routesPath, JSON.stringify(updated, null, 2));

      return { ok: true };
    }),
});
