/**
 * RouteForm schema + transformer (registry-driven).
 *
 * The form holds one draft entry at a time: `{ type, address, channel, fields }`.
 * Server-side data is `{ byType: Record<transportName, Array<entry>> }`. The
 * transformer rebuilds the full `byType` payload from the current server list
 * plus the current draft (added or edited in place).
 *
 * No transport names are referenced by this module — the descriptor list
 * fetched from the server (`route.transportTypes`) drives form rendering.
 */
import { z } from 'zod';
import type { routeUpdateInput } from '@getcast/server/admin/schemas';

export const RouteDraftSchema = z.object({
  type: z.string().min(1),
  address: z.string().min(1),
  channel: z.string(),
  fields: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type RouteDraft = z.infer<typeof RouteDraftSchema>;

export const EMPTY_DRAFT: RouteDraft = { type: '', address: '', channel: '', fields: {} };

/** Server-side route entry shape (one row of `byType[name]`). */
export interface RouteEntry {
  address: string;
  channel: string | null;
  online: boolean;
  summary: string;
  fields: Record<string, unknown>;
}

/** Server-side `route.list` response. */
export interface RoutesServerData {
  byType: Record<string, RouteEntry[]>;
}

/** Build an edit draft from an existing entry. */
export function draftFromEntry(
  data: RoutesServerData,
  type: string,
  idx: number,
): RouteDraft {
  const entry = data.byType[type]?.[idx];
  if (!entry) return { ...EMPTY_DRAFT, type };
  // Form fields are string-typed at the input layer; coerce display values.
  const fields: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(entry.fields)) {
    fields[k] = typeof v === 'number' ? v : String(v ?? '');
  }
  return {
    type,
    address: entry.address,
    channel: entry.channel ?? '',
    fields,
  };
}

function entryFromDraft(draft: RouteDraft): { address: string; channel?: string; fields: Record<string, unknown> } {
  return {
    address: draft.address,
    channel: draft.channel || undefined,
    fields: draft.fields,
  };
}

/** Reproject the server data into the mutation payload (entries only). */
function buildBasePayload(data: RoutesServerData): z.infer<typeof routeUpdateInput> {
  const byType: Record<string, Array<{ address: string; channel?: string; fields: Record<string, unknown> }>> = {};
  for (const [type, entries] of Object.entries(data.byType)) {
    byType[type] = entries.map((e) => ({
      address: e.address,
      channel: e.channel ?? undefined,
      fields: e.fields,
    }));
  }
  return { byType };
}

/** Build the mutation payload from the current server data + one draft. */
export function routesFormToPayload(
  data: RoutesServerData,
  draft: RouteDraft,
  editTarget: { type: string; idx: number } | null,
): z.infer<typeof routeUpdateInput> {
  const payload = buildBasePayload(data);
  if (editTarget) {
    payload.byType[editTarget.type]?.splice(editTarget.idx, 1);
  }
  if (!payload.byType[draft.type]) payload.byType[draft.type] = [];
  payload.byType[draft.type]!.push(entryFromDraft(draft));
  return payload;
}

/** Build a remove-mutation payload by splicing one entry out. */
export function routesRemovePayload(
  data: RoutesServerData,
  type: string,
  idx: number,
): z.infer<typeof routeUpdateInput> {
  const payload = buildBasePayload(data);
  payload.byType[type]?.splice(idx, 1);
  return payload;
}
