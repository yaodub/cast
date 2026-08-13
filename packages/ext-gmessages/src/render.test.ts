import { describe, it, expect } from 'vitest';

import type { InboundMessage } from 'gmessages';

import { renderConversationLine, renderMessage } from './render.js';
import type { ConversationView } from './resolver.js';

const oneToOne: ConversationView = {
  conversationId: 'c1',
  label: 'Alice Chen',
  kind: 'rcs',
  participants: ['Alice Chen'],
  isGroup: false,
};

const group: ConversationView = {
  conversationId: 'g1',
  label: 'Family',
  kind: 'rcs',
  participants: ['Alice', 'Bob'],
  isGroup: true,
};

function msg(over: Partial<InboundMessage>): InboundMessage {
  return {
    messageId: 'm1',
    conversationId: 'c1',
    participantId: 'them',
    text: '',
    timestampMicros: 0n,
    statusCode: 0,
    statusLabel: null,
    reactions: [],
    attachments: [],
    ...over,
  };
}

describe('renderConversationLine', () => {
  it('renders name, kind, and id, tagging groups', () => {
    expect(renderConversationLine(oneToOne)).toBe('Alice Chen · rcs · c1');
    expect(renderConversationLine(group)).toBe('Family · group · rcs · g1');
  });
});

describe('renderMessage', () => {
  // 2021-01-01T00:00:00Z in microseconds.
  const ts = BigInt(Date.UTC(2021, 0, 1)) * 1000n;

  it('labels own messages "You" and 1:1 counterpart by conversation label', () => {
    expect(renderMessage(msg({ participantId: 'me', text: 'hi', timestampMicros: ts }), {
      ownParticipantId: 'me',
      view: oneToOne,
    })).toBe('[2021-01-01 00:00] You: hi');

    expect(renderMessage(msg({ participantId: 'them', text: 'yo', timestampMicros: ts }), {
      ownParticipantId: 'me',
      view: oneToOne,
    })).toBe('[2021-01-01 00:00] Alice Chen: yo');
  });

  it('shows the raw participant id for a group sender', () => {
    expect(renderMessage(msg({ participantId: 'p7', text: 'hey', timestampMicros: ts }), {
      ownParticipantId: 'me',
      view: group,
    })).toBe('[2021-01-01 00:00] p7: hey');
  });

  it('renders a media placeholder with the message id, keeping any caption', () => {
    const media = msg({
      participantId: 'them',
      messageId: 'm9',
      attachments: [
        { mediaId: 'x', partId: 'p1', key: new Uint8Array(), mimeType: 'image/jpeg', sizeBytes: 1n, fileName: '' },
      ],
    });
    expect(renderMessage(media, { ownParticipantId: 'me', view: oneToOne })).toBe(
      'Alice Chen: [media: image/jpeg] (id: m9)',
    );
    const withCaption = { ...media, text: 'look' };
    expect(renderMessage(withCaption, { ownParticipantId: 'me', view: oneToOne })).toBe(
      'Alice Chen: look [media: image/jpeg] (id: m9)',
    );
  });

  it('names each attachment with an index when a message carries several', () => {
    // Without this the listing showed "[media: image/jpeg, image/png]" and the agent had no way to
    // ask for the second one — it could see two and only ever reach the first.
    const two = msg({
      participantId: 'them',
      messageId: 'm9',
      attachments: [
        { mediaId: 'a', partId: 'pa', key: new Uint8Array(), mimeType: 'image/jpeg', sizeBytes: 1n, fileName: '' },
        { mediaId: 'b', partId: 'pb', key: new Uint8Array(), mimeType: 'image/png', sizeBytes: 1n, fileName: '' },
      ],
    });
    const line = renderMessage(two, { ownParticipantId: 'me', view: oneToOne });
    expect(line).toContain('[media: image/jpeg] (id: m9, index: 0)');
    expect(line).toContain('[media: image/png] (id: m9, index: 1)');
  });

  it('omits the index when there is only one attachment', () => {
    const one = msg({
      participantId: 'them',
      messageId: 'm9',
      attachments: [
        { mediaId: 'a', partId: 'pa', key: new Uint8Array(), mimeType: 'image/jpeg', sizeBytes: 1n, fileName: '' },
      ],
    });
    expect(renderMessage(one, { ownParticipantId: 'me', view: oneToOne })).toContain(
      '[media: image/jpeg] (id: m9)',
    );
  });

  it('appends reactions', () => {
    expect(renderMessage(msg({ participantId: 'them', text: 'ok', reactions: ['❤️'] }), {
      ownParticipantId: 'me',
      view: oneToOne,
    })).toBe('Alice Chen: ok {❤️}');
  });
});
