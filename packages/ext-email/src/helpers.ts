/**
 * Email extension — pure helper functions.
 *
 * IMAP client factory, HTML→text conversion, search builder, envelope formatter.
 * No state, no logger, no side effects.
 */
import { convert } from 'html-to-text';
import { ImapFlow } from 'imapflow';
import type { SearchObject } from 'imapflow';

import { EmailAdminState } from './schemas.js';
import type { EmailSecrets, EmailSearchRequest, EmailEnvelope } from './schemas.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SNIPPET_LENGTH = 80;

// ---------------------------------------------------------------------------
// HTML → clean text
// ---------------------------------------------------------------------------

function domainFromHref(href: string): string {
  try {
    return new URL(href).hostname;
  } catch {
    return 'link';
  }
}

// html-to-text custom formatter API uses internal types (DomNode, RecursiveCallback,
// BlockTextBuilder) that are not exported from @types/html-to-text — `any` is unavoidable.
/* eslint-disable @typescript-eslint/no-explicit-any */
const HTML_CONVERT_OPTS = {
  wordwrap: false,
  formatters: {
    domainLink: (elem: any, walk: any, builder: any, _opts: any) => {
      const href: string = elem.attribs?.href || '';
      const hasText = elem.children?.some(
        (c: any) =>
          (c.type === 'text' && c.data?.trim()) ||
          (c.type === 'tag' && c.name !== 'img'),
      );
      walk(elem.children, builder);
      if (href && hasText) {
        if (href.startsWith('mailto:')) {
          const email = href.slice(7);
          const linkText = elem.children
            ?.filter((c: any) => c.type === 'text')
            .map((c: any) => c.data)
            .join('')
            .trim();
          if (linkText !== email) builder.addInline(` <${email}>`);
        } else {
          builder.addInline(` <${domainFromHref(href)}>`);
        }
      }
    },
  },
  selectors: [
    { selector: 'img', format: 'skip' as const },
    { selector: 'a', format: 'domainLink' },
  ],
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export function htmlToText(html: string): string {
  // Custom formatter name 'domainLink' in selectors widens the type beyond HtmlToTextOptions — cast required
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return convert(html, HTML_CONVERT_OPTS as any);
}

/** Count images in HTML by size bucket: 1x1 (tracking), ≤50px (small), else (large). */
export function countImages(html: string): { tracking: number; small: number; large: number } {
  const counts = { tracking: 0, small: 0, large: 0 };
  const re = /<img\s+([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const w = parseInt(attrs.match(/width=["']?(\d+)/i)?.[1] || '0') || 0;
    const h = parseInt(attrs.match(/height=["']?(\d+)/i)?.[1] || '0') || 0;
    if (w === 1 && h === 1) counts.tracking++;
    else if (w > 0 && w <= 50 && h > 0 && h <= 50) counts.small++;
    else counts.large++;
  }
  return counts;
}

/**
 * Format a parsed email as a .md sidecar file.
 * Headers + body text (html-to-text) + attachment summary + image stats footer.
 */
export function formatSidecar(opts: {
  from: string;
  to: string[];
  cc?: string[];
  date: string;
  subject: string;
  messageId: string;
  text: string;
  html?: string;
  attachments: { filename: string; contentType: string; size: number }[];
}): string {
  const lines = [
    `From: ${opts.from}`,
    `To: ${opts.to.join(', ')}`,
    ...(opts.cc && opts.cc.length > 0 ? [`Cc: ${opts.cc.join(', ')}`] : []),
    `Date: ${opts.date}`,
    `Subject: ${opts.subject}`,
    `Message-ID: ${opts.messageId}`,
    '',
    '---',
    '',
    opts.text,
  ];

  // Footer: attachments + image stats
  const footerLines: string[] = [];
  if (opts.attachments.length > 0) {
    footerLines.push('Attachments:');
    for (const a of opts.attachments) {
      const size = a.size ? `${Math.round(a.size / 1024)}KB` : 'unknown size';
      footerLines.push(`- ${a.filename} (${a.contentType}, ${size})`);
    }
  }
  if (opts.html) {
    const imgCounts = countImages(opts.html);
    if (imgCounts.small > 0 || imgCounts.large > 0) {
      const parts: string[] = [];
      if (imgCounts.small > 0) parts.push(`${imgCounts.small} small`);
      if (imgCounts.large > 0) parts.push(`${imgCounts.large} large`);
      footerLines.push(`Images: ${parts.join(', ')}`);
    }
  }
  if (footerLines.length > 0) {
    lines.push('', '---', ...footerLines);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// IMAP helpers
// ---------------------------------------------------------------------------

export function createImapClient(secrets: EmailSecrets): ImapFlow {
  return new ImapFlow({
    host: secrets.IMAP_HOST,
    port: secrets.IMAP_PORT,
    secure: true,
    auth: { user: secrets.EMAIL_ADDRESS, pass: secrets.EMAIL_PASSWORD },
    logger: false,
  });
}

// ---------------------------------------------------------------------------
// Folder discovery
// ---------------------------------------------------------------------------

export interface FolderInfo {
  path: string;
  name: string;
  specialUse?: string;
}

/** List all IMAP mailbox folders. */
export async function listFolders(secrets: EmailSecrets): Promise<FolderInfo[]> {
  const client = createImapClient(secrets);
  try {
    await client.connect();
    const folders = await client.list();
    return folders.map((f) => ({
      path: f.path,
      name: f.name,
      ...(f.specialUse ? { specialUse: f.specialUse } : {}),
    }));
  } finally {
    try { await client.logout(); } catch { /* already disconnected */ }
  }
}

/** Admin hook — verify IMAP credentials and discover mailbox folders. */
export async function connect(ctx: { secrets: EmailSecrets; privateDir: string }): Promise<{
  ok: boolean;
  message: string;
  state?: unknown;
}> {
  try {
    const folders = await listFolders(ctx.secrets);
    const state = EmailAdminState.parse({
      folders: folders.map((f) => ({ path: f.path, name: f.name })),
    });
    return { ok: true, message: `IMAP connection successful — ${folders.length} folder(s)`, state };
  } catch (err) {
    return { ok: false, message: `IMAP connection failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Find a SPECIAL-USE folder (e.g. '\\Drafts'). Falls back to name convention. */
export async function findSpecialFolder(
  client: ImapFlow,
  use: string,
): Promise<string | null> {
  const folders = await client.list();
  const special = folders.find((f) => f.specialUse === use);
  if (special) return special.path;
  const names: Record<string, string> = {
    '\\Drafts': 'Drafts',
    '\\Sent': 'Sent',
    '\\Trash': 'Trash',
  };
  const name = names[use];
  if (name) {
    const byName = folders.find((f) => f.name === name);
    if (byName) return byName.path;
  }
  return null;
}

/** Build ImapFlow SearchObject from structured criteria. */
export function buildSearchObject(req: EmailSearchRequest | { from?: string; to?: string; subject?: string; body?: string; since?: string; before?: string }): SearchObject {
  const search: SearchObject = {};
  if (req.from) search.from = req.from;
  if (req.to) search.to = req.to;
  if (req.subject) search.subject = req.subject;
  if (req.body) search.body = req.body;
  if ('since' in req && req.since) search.since = new Date(req.since);
  if ('before' in req && req.before) search.before = new Date(req.before);
  return search;
}

/**
 * Graft inbound scope onto a SearchObject:
 *   - `senders` → single `from` when 1 entry, else `or: [{from: s1}, ...]`
 *   - `blocked` → single `not: { from }` when 1 entry, else `not: { or: [...] }`
 *
 * Empty arrays are no-ops. IMAP's `from` predicate is a substring match, which
 * covers both exact (`alice@acme.com`) and domain (`@acme.com`) patterns.
 *
 * ImapFlow's `or` requires 2+ elements — single-element case is handled by
 * collapsing to the base `from` predicate instead.
 */
export function applyScope(
  search: SearchObject,
  scope: { senders: string[]; blocked: string[] },
): SearchObject {
  const out: SearchObject = { ...search };
  if (scope.senders.length === 1) {
    // If the caller already supplied `from` (agent's own filter), keep it —
    // the more specific predicate wins; the allowlist is enforced by the filter
    // decision, not double-enforced here.
    if (!out.from) out.from = scope.senders[0];
  } else if (scope.senders.length > 1) {
    out.or = scope.senders.map((s) => ({ from: s }));
  }
  if (scope.blocked.length === 1) {
    out.not = { from: scope.blocked[0] };
  } else if (scope.blocked.length > 1) {
    out.not = { or: scope.blocked.map((b) => ({ from: b })) };
  }
  return out;
}

/** Format envelope list as human-readable text for MCP tool results. */
export function formatEnvelopes(emails: EmailEnvelope[]): string {
  if (emails.length === 0) return 'No emails found.';
  return emails
    .map(
      (e) =>
        `ID: ${e.emailId}\nFrom: ${e.from}\nTo: ${e.to.join(', ')}\nDate: ${e.date}\nSubject: ${e.subject}\nSnippet: ${e.snippet}`,
    )
    .join('\n\n');
}
