/**
 * Rendering decoded reads into the plain text the agent sees. Pure, so the
 * formatting is testable without a connection.
 */
import type { InboundMessage } from 'gmessages';

import type { ConversationView } from './resolver.js';
import { formatMicros } from './helpers.js';

/** One line for the chats listing: `Alice Chen · rcs · <id>` (group tagged). */
export function renderConversationLine(v: ConversationView): string {
  const parts = [v.label];
  if (v.isGroup) parts.push('group');
  parts.push(v.kind);
  parts.push(v.conversationId);
  return parts.join(' · ');
}

/**
 * The message body: text, media placeholders, or both.
 *
 * Each attachment is rendered SEPARATELY with its index, because a message can carry several and the
 * download tool addresses them by index. Collapsing them into one placeholder advertised media the
 * agent then had no way to name — it could see two images and only ever reach the first.
 */
function renderBody(m: InboundMessage): string {
  if (m.attachments.length === 0) return m.text || '(empty)';
  const single = m.attachments.length === 1;
  const media = m.attachments
    .map((a, i) => {
      const kind = a.mimeType || 'file';
      // The index is only worth the noise when there is a choice to make.
      return single
        ? `[media: ${kind}] (id: ${m.messageId})`
        : `[media: ${kind}] (id: ${m.messageId}, index: ${i})`;
    })
    .join(' ');
  return m.text ? `${m.text} ${media}` : media;
}

/**
 * One rendered message line, with the sender resolved to a name where possible.
 *
 * `ownParticipantId` is this account's participant id (the paired device's
 * source id); a message from it is "You". For a 1:1 the other party is the
 * conversation's own label; in a group the raw participant id is shown, since
 * mapping a group participant to a display name needs a read this does not do.
 */
export function renderMessage(
  m: InboundMessage,
  ctx: { ownParticipantId: string; view: ConversationView },
): string {
  const ts = formatMicros(m.timestampMicros);
  const sender =
    ctx.ownParticipantId !== '' && m.participantId === ctx.ownParticipantId
      ? 'You'
      : ctx.view.isGroup
        ? m.participantId
        : ctx.view.label;
  const prefix = ts ? `[${ts}] ` : '';
  const reactions = m.reactions.length > 0 ? ` {${m.reactions.join('')}}` : '';
  return `${prefix}${sender}: ${renderBody(m)}${reactions}`;
}
