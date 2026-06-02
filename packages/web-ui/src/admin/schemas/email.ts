/**
 * Email extension form schema + transformer.
 *
 * Form holds string-shaped secrets and nested inbound/outbound policy config;
 * transformer splits them into { secrets, config } for the mutation. Only
 * non-empty secrets ship (blank means "keep existing"). Locked config fields
 * are omitted.
 */
import type { inferRouterOutputs } from '@trpc/server';
import { z } from 'zod';

import type { AppRouter } from '@getcast/server/admin';

const ModeEnum = z.enum(['disabled', 'approval', 'enabled']);
type ModeValue = z.infer<typeof ModeEnum>;

export const EmailFormSchema = z.object({
  emailAddress: z.string(),
  emailPassword: z.string(),
  imapHost: z.string(),
  imapPort: z.string(),
  smtpHost: z.string(),
  smtpPort: z.string(),
  // Inbound
  inboundFolders: z.array(z.string()),
  inboundSenders: z.array(z.string()),
  inboundBlocked: z.array(z.string()),
  inboundWindowDays: z.string(),
  inboundMaxResults: z.string(),
  inboundDefault: ModeEnum,
  inboundAlwaysAllow: z.array(z.string()),
  // Outbound
  outboundRecipients: z.array(z.string()),
  outboundBlocked: z.array(z.string()),
  outboundDefault: ModeEnum,
  outboundAlwaysAllow: z.array(z.string()),
});

export type EmailFormValues = z.infer<typeof EmailFormSchema>;

export type EmailServerData = inferRouterOutputs<AppRouter>['extension']['email']['getConfig'];

interface InboundConfigValue {
  folders?: string[];
  senders?: string[];
  blocked?: string[];
  window_days?: number;
  max_results?: number;
  default?: ModeValue;
  always_allow?: string[];
}

interface OutboundConfigValue {
  recipients?: string[];
  blocked?: string[];
  default?: ModeValue;
  always_allow?: string[];
}

function asMode(v: unknown, fallback: ModeValue): ModeValue {
  return v === 'disabled' || v === 'approval' || v === 'enabled' ? v : fallback;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

export function emailFormInitialValues(data: EmailServerData): EmailFormValues {
  const s = data.secrets;
  const inbound = (data.config['inbound']?.value ?? {}) as InboundConfigValue;
  const outbound = (data.config['outbound']?.value ?? {}) as OutboundConfigValue;
  return {
    emailAddress: s['EMAIL_ADDRESS']?.set ? s['EMAIL_ADDRESS'].value : '',
    emailPassword: '',
    imapHost: s['IMAP_HOST']?.set ? s['IMAP_HOST'].value : '',
    imapPort: s['IMAP_PORT']?.set ? s['IMAP_PORT'].value : '',
    smtpHost: s['SMTP_HOST']?.set ? s['SMTP_HOST'].value : '',
    smtpPort: s['SMTP_PORT']?.set ? s['SMTP_PORT'].value : '',
    inboundFolders:     asStringArray(inbound.folders),
    inboundSenders:     asStringArray(inbound.senders),
    inboundBlocked:     asStringArray(inbound.blocked),
    inboundWindowDays:  String(inbound.window_days ?? 7),
    inboundMaxResults:  String(inbound.max_results ?? 25),
    inboundDefault:     asMode(inbound.default, 'approval'),
    inboundAlwaysAllow: asStringArray(inbound.always_allow),
    outboundRecipients:  asStringArray(outbound.recipients),
    outboundBlocked:     asStringArray(outbound.blocked),
    outboundDefault:     asMode(outbound.default, 'approval'),
    outboundAlwaysAllow: asStringArray(outbound.always_allow),
  };
}

export function emailFormToPayload(
  alias: string,
  v: EmailFormValues,
  data: EmailServerData,
): { alias: string; config?: Record<string, unknown>; secrets?: Record<string, string> } {
  const c = data.config;
  const secretUpdates: Record<string, string> = {};
  if (v.emailAddress) secretUpdates['EMAIL_ADDRESS'] = v.emailAddress;
  if (v.emailPassword) secretUpdates['EMAIL_PASSWORD'] = v.emailPassword;
  if (v.imapHost) secretUpdates['IMAP_HOST'] = v.imapHost;
  if (v.imapPort) secretUpdates['IMAP_PORT'] = v.imapPort;
  if (v.smtpHost) secretUpdates['SMTP_HOST'] = v.smtpHost;
  if (v.smtpPort) secretUpdates['SMTP_PORT'] = v.smtpPort;

  const configUpdates: Record<string, unknown> = {};
  if (!c['inbound']?.locked) {
    configUpdates['inbound'] = {
      folders:      v.inboundFolders,
      senders:      v.inboundSenders,
      blocked:      v.inboundBlocked,
      window_days:  Number(v.inboundWindowDays),
      max_results:  Number(v.inboundMaxResults),
      default:      v.inboundDefault,
      always_allow: v.inboundAlwaysAllow,
    };
  }
  if (!c['outbound']?.locked) {
    configUpdates['outbound'] = {
      recipients:   v.outboundRecipients,
      blocked:      v.outboundBlocked,
      default:      v.outboundDefault,
      always_allow: v.outboundAlwaysAllow,
    };
  }

  return {
    alias,
    config: Object.keys(configUpdates).length > 0 ? configUpdates : undefined,
    secrets: Object.keys(secretUpdates).length > 0 ? secretUpdates : undefined,
  };
}
