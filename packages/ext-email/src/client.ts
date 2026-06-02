/**
 * Email extension — stateless client methods.
 *
 * search(), send(), read() — no policy enforcement, no state.
 * These are the public API that services call directly.
 */
import { simpleParser } from 'mailparser';
import { createTransport } from 'nodemailer';

import type {
  EmailConfig,
  EmailSecrets,
  EmailSearchRequest,
  EmailSearchResult,
  EmailEnvelope,
  EmailSendRequest,
  EmailSendResult,
  EmailReadRequest,
  EmailReadResult,
} from './schemas.js';

import {
  SNIPPET_LENGTH,
  createImapClient,
  buildSearchObject,
  applyScope,
  htmlToText,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Search emails via IMAP. Returns envelope summaries. Inbound scope (senders/blocked) is pushed into the IMAP query. */
export async function searchEmails(
  secrets: EmailSecrets,
  req: EmailSearchRequest,
  config: EmailConfig,
): Promise<EmailSearchResult> {
  const client = createImapClient(secrets);
  await client.connect();

  try {
    const folder = req.folder ?? 'INBOX';
    const lock = await client.getMailboxLock(folder);

    try {
      const searchObj = applyScope(buildSearchObject(req), {
        senders: config.inbound.senders,
        blocked: config.inbound.blocked,
      });
      let uids = await client.search(searchObj, { uid: true });
      if (!Array.isArray(uids) || uids.length === 0) {
        return { emails: [], total: 0 };
      }

      const total = uids.length;
      const limit = req.limit ?? 25;
      if (uids.length > limit) {
        uids = uids.slice(-limit); // Most recent UIDs (highest = newest)
      }

      const emails: EmailEnvelope[] = [];
      for await (const msg of client.fetch(
        uids,
        { envelope: true, source: true },
        { uid: true },
      )) {
        const envelope = msg.envelope;
        if (!envelope) continue;
        let snippet = '';
        if (msg.source) {
          try {
            const parsed = await simpleParser(msg.source);
            const rawText = parsed.html
              ? htmlToText(parsed.html)
              : parsed.text || '';
            snippet = rawText
              .slice(0, SNIPPET_LENGTH)
              .replace(/\s+/g, ' ')
              .trim();
          } catch {
            /* skip unparseable */
          }
        }

        emails.push({
          emailId: String(msg.emailId),
          messageId: envelope.messageId || String(msg.emailId),
          from: envelope.from?.[0]?.address || '',
          to: (envelope.to || []).map((a) => a.address || ''),
          subject: envelope.subject || '',
          date: envelope.date?.toISOString() || new Date().toISOString(),
          snippet,
        });
      }

      // Sort by date descending (newest first)
      emails.sort((a, b) => b.date.localeCompare(a.date));

      return { emails, total };
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      /* already disconnected */
    }
  }
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

/** Send an email via SMTP. No policy enforcement — caller is expected to have approved. */
export async function sendEmail(
  secrets: EmailSecrets,
  req: EmailSendRequest,
): Promise<EmailSendResult> {
  // RFC 3834 stamp on all agent-authored mail. `auto-replied` for replies
  // (catches OOO loops + signals to peer cast instances that this is bot
  // mail); `auto-generated` for first-touch composes. The parenthesized
  // comment lets operators identify cast traffic in MTA logs. Compliant
  // receivers suppress their own auto-responders on either value.
  const headers: Record<string, string> = {
    'Auto-Submitted': req.replyToMessageId
      ? 'auto-replied (cast-agent)'
      : 'auto-generated (cast-agent)',
  };
  if (req.replyToMessageId) {
    headers['In-Reply-To'] = req.replyToMessageId;
    headers['References'] = req.replyToMessageId;
  }

  try {
    const transport = createTransport({
      host: secrets.SMTP_HOST,
      port: secrets.SMTP_PORT,
      secure: true,
      auth: {
        user: secrets.EMAIL_ADDRESS,
        pass: secrets.EMAIL_PASSWORD,
      },
    });

    try {
      const info = await transport.sendMail({
        from: secrets.EMAIL_ADDRESS,
        to: req.to,
        subject: req.subject,
        text: req.body,
        headers,
      });

      return { ok: true, mode: 'sent', messageId: info.messageId };
    } finally {
      transport.close();
    }
  } catch (err) {
    return {
      ok: false,
      mode: 'sent',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Read a full email by ID. Returns parsed content with HTML→text conversion. */
export async function readEmail(
  secrets: EmailSecrets,
  req: EmailReadRequest,
): Promise<EmailReadResult> {
  const client = createImapClient(secrets);
  await client.connect();

  try {
    const folder = req.folder ?? 'INBOX';
    const lock = await client.getMailboxLock(folder);

    try {
      const uids = await client.search(
        { emailId: req.emailId },
        { uid: true },
      );
      if (!Array.isArray(uids) || uids.length === 0) {
        throw new Error(`Email not found: ${req.emailId}`);
      }

      let source: Buffer | undefined;
      let emailId = req.emailId;
      for await (const msg of client.fetch(
        uids.slice(0, 1),
        { source: true },
        { uid: true },
      )) {
        source = msg.source;
        if (msg.emailId) emailId = String(msg.emailId);
      }

      if (!source) {
        throw new Error(`Email source not available: ${req.emailId}`);
      }

      const parsed = await simpleParser(source);
      const text = parsed.html ? htmlToText(parsed.html) : parsed.text || '';
      const html = parsed.html || undefined;
      const attachments = (parsed.attachments ?? [])
        .filter((a) => !a.cid) // Skip inline images
        .map((a) => ({
          filename: a.filename || 'unnamed',
          contentType: a.contentType || 'application/octet-stream',
          size: a.size || 0,
        }));

      return {
        emailId,
        messageId: parsed.messageId || emailId,
        from: parsed.from?.value[0]?.address || '',
        to: (parsed.to
          ? Array.isArray(parsed.to)
            ? parsed.to
            : [parsed.to]
          : []
        ).flatMap((a) => a.value.map((v) => v.address || '')),
        cc: (parsed.cc
          ? Array.isArray(parsed.cc)
            ? parsed.cc
            : [parsed.cc]
          : []
        ).flatMap((a) => a.value.map((v) => v.address || '')),
        subject: parsed.subject || '',
        date: parsed.date?.toISOString() || new Date().toISOString(),
        text,
        html,
        attachments,
        rawSource: source,
      };
    } finally {
      lock.release();
    }
  } finally {
    try {
      await client.logout();
    } catch {
      /* already disconnected */
    }
  }
}
