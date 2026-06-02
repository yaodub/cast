/**
 * WhatsApp extension config-save schema.
 *
 * Scope: only the saved policy + per-chat override fields. The pairing flow
 * stays outside RHF because it's a multi-step state machine with async
 * polling, not a form.
 */
import type { inferRouterOutputs } from '@trpc/server';
import { z } from 'zod';

import type { AppRouter } from '@getcast/server/admin';

// Form-state shape: adds `jid`/`name` UI metadata that the extension's
// canonical `ChatOverrideSchema` (in @getcast/ext-whatsapp/schemas) carries
// implicitly via the Record<jid, …> key. `*Form` suffix avoids accidental
// reuse as if it were the API contract.
export const ChatOverrideFormSchema = z.object({
  jid: z.string(),
  name: z.string().optional(),
  read: z.enum(['allow', 'deny']).optional(),
  send: z.enum(['allow', 'deny']).optional(),
});
export type ChatOverrideForm = z.infer<typeof ChatOverrideFormSchema>;

export const WhatsAppFormSchema = z.object({
  readMode: z.enum(['disabled', 'approval', 'open']),
  sendMode: z.enum(['disabled', 'approval', 'direct']),
  chatOverrides: z.array(ChatOverrideFormSchema),
  pairingHistoryDepth: z.enum(['standard', 'extended']),
});
export type WhatsAppFormValues = z.infer<typeof WhatsAppFormSchema>;

export type WhatsAppServerData = inferRouterOutputs<AppRouter>['extension']['whatsapp']['getConfig'];

type ChatPolicyEntry = { read?: 'allow' | 'deny'; send?: 'allow' | 'deny' };

function asReadMode(v: unknown): WhatsAppFormValues['readMode'] {
  return v === 'disabled' || v === 'open' ? v : 'approval';
}

function asSendMode(v: unknown): WhatsAppFormValues['sendMode'] {
  return v === 'approval' || v === 'direct' ? v : 'disabled';
}

function asChatsMap(v: unknown): Record<string, ChatPolicyEntry> {
  if (!v || typeof v !== 'object') return {};
  const out: Record<string, ChatPolicyEntry> = {};
  for (const [jid, entry] of Object.entries(v as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { read?: unknown; send?: unknown };
    const policy: ChatPolicyEntry = {};
    if (e.read === 'allow' || e.read === 'deny') policy.read = e.read;
    if (e.send === 'allow' || e.send === 'deny') policy.send = e.send;
    out[jid] = policy;
  }
  return out;
}

export function whatsappFormInitialValues(data: WhatsAppServerData): WhatsAppFormValues {
  const { config } = data;
  const chatsMap = asChatsMap(config['chats']?.value);
  return {
    readMode: asReadMode(config['read_mode']?.value),
    sendMode: asSendMode(config['send_mode']?.value),
    chatOverrides: Object.entries(chatsMap).map(([jid, v]) => ({
      jid,
      read: v.read,
      send: v.send,
    })),
    pairingHistoryDepth:
      config['pairing_history_depth']?.value === 'extended' ? 'extended' : 'standard',
  };
}

export function whatsappFormToPayload(
  alias: string,
  v: WhatsAppFormValues,
  data: WhatsAppServerData,
): { alias: string; config: Record<string, unknown> } {
  const { config } = data;
  const configUpdates: Record<string, unknown> = {};
  if (!config['read_mode']?.locked) {
    configUpdates['read_mode'] = v.readMode;
  }
  if (!config['send_mode']?.locked) {
    configUpdates['send_mode'] = v.sendMode;
  }
  if (!config['chats']?.locked) {
    const chatsObj: Record<string, ChatPolicyEntry> = {};
    for (const o of v.chatOverrides) {
      const trimmed = o.jid.trim();
      if (!trimmed) continue;
      const entry: ChatPolicyEntry = {};
      if (o.read) entry.read = o.read;
      if (o.send) entry.send = o.send;
      // Skip entries where both axes are unset — they'd be no-ops.
      if (entry.read || entry.send) {
        chatsObj[trimmed] = entry;
      }
    }
    configUpdates['chats'] = chatsObj;
  }
  if (!config['pairing_history_depth']?.locked) {
    configUpdates['pairing_history_depth'] = v.pairingHistoryDepth;
  }
  return { alias, config: configUpdates };
}
