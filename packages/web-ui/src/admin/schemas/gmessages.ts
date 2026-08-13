/**
 * Google Messages extension config-save schema.
 *
 * Scope: the saved policy — modes, per-conversation overrides, per-number
 * (cold-send) overrides, and labels. The pairing flow stays outside RHF: it is
 * a multi-step state machine with async polling, not a form.
 */
import type { inferRouterOutputs } from '@trpc/server';
import { z } from 'zod';

import type { AppRouter } from '@getcast/server/admin';

/**
 * Form-state shape for one override row. Carries the `label` the extension's
 * canonical `Record<key, …>` config holds separately, so a row can render a
 * human name next to an opaque conversation id. `*Form` suffix keeps it from
 * being mistaken for the API contract.
 */
export const OverrideFormSchema = z.object({
  key: z.string(),
  label: z.string().optional(),
  read: z.enum(['allow', 'deny']).optional(),
  send: z.enum(['allow', 'deny']).optional(),
});
export type OverrideForm = z.infer<typeof OverrideFormSchema>;

export const GmessagesFormSchema = z.object({
  readMode: z.enum(['disabled', 'approval', 'open']),
  sendMode: z.enum(['disabled', 'approval', 'direct']),
  /** Keyed on conversationId. Covers groups. */
  chatOverrides: z.array(OverrideFormSchema),
  /** Keyed on E.164. 1:1 only — the cold-send authorisation surface. */
  contactOverrides: z.array(OverrideFormSchema),
});
export type GmessagesFormValues = z.infer<typeof GmessagesFormSchema>;

export type GmessagesServerData = inferRouterOutputs<AppRouter>['extension']['gmessages']['getConfig'];

type PolicyEntry = { read?: 'allow' | 'deny'; send?: 'allow' | 'deny' };

function asReadMode(v: unknown): GmessagesFormValues['readMode'] {
  return v === 'disabled' || v === 'open' ? v : 'approval';
}

function asSendMode(v: unknown): GmessagesFormValues['sendMode'] {
  return v === 'approval' || v === 'direct' ? v : 'disabled';
}

function asPolicyMap(v: unknown): Record<string, PolicyEntry> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, PolicyEntry> = {};
  for (const [key, entry] of Object.entries(v as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { read?: unknown; send?: unknown };
    const policy: PolicyEntry = {};
    if (e.read === 'allow' || e.read === 'deny') policy.read = e.read;
    if (e.send === 'allow' || e.send === 'deny') policy.send = e.send;
    out[key] = policy;
  }
  return out;
}

function asLabelMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, label] of Object.entries(v as Record<string, unknown>)) {
    if (typeof label === 'string' && label.trim()) out[key] = label;
  }
  return out;
}

export function gmessagesFormInitialValues(data: GmessagesServerData): GmessagesFormValues {
  const { config } = data;
  const chats = asPolicyMap(config['chats']?.value);
  const contacts = asPolicyMap(config['contacts']?.value);
  const labels = asLabelMap(config['labels']?.value);
  return {
    readMode: asReadMode(config['read_mode']?.value),
    sendMode: asSendMode(config['send_mode']?.value),
    chatOverrides: Object.entries(chats).map(([key, v]) => ({
      key,
      label: labels[key],
      read: v.read,
      send: v.send,
    })),
    contactOverrides: Object.entries(contacts).map(([key, v]) => ({
      key,
      read: v.read,
      send: v.send,
    })),
  };
}

/** Collapse rows back into the `Record<key, {read?, send?}>` the extension expects. */
function toPolicyObject(rows: OverrideForm[]): Record<string, PolicyEntry> {
  const out: Record<string, PolicyEntry> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    const entry: PolicyEntry = {};
    if (row.read) entry.read = row.read;
    if (row.send) entry.send = row.send;
    // A row with neither axis set is a no-op; leaving it out keeps config.json
    // readable and means "inherit" is genuinely the absence of an entry.
    if (entry.read || entry.send) out[key] = entry;
  }
  return out;
}

export function gmessagesFormToPayload(
  alias: string,
  v: GmessagesFormValues,
  data: GmessagesServerData,
): { alias: string; config: Record<string, unknown> } {
  const { config } = data;
  const configUpdates: Record<string, unknown> = {};
  if (!config['read_mode']?.locked) configUpdates['read_mode'] = v.readMode;
  if (!config['send_mode']?.locked) configUpdates['send_mode'] = v.sendMode;
  if (!config['chats']?.locked) configUpdates['chats'] = toPolicyObject(v.chatOverrides);
  if (!config['contacts']?.locked) configUpdates['contacts'] = toPolicyObject(v.contactOverrides);
  if (!config['labels']?.locked) {
    const labels: Record<string, string> = {};
    for (const row of v.chatOverrides) {
      const key = row.key.trim();
      if (key && row.label?.trim()) labels[key] = row.label.trim();
    }
    configUpdates['labels'] = labels;
  }
  return { alias, config: configUpdates };
}
