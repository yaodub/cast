import { describe, it, expect } from 'vitest';

import type { ConversationSummary } from 'gmessages';

import { toView, resolveConversation, type ConversationView } from './resolver.js';

function summary(over: Partial<ConversationSummary>): ConversationSummary {
  return {
    conversationId: 'c0',
    type: 1,
    kind: 'sms',
    participants: [],
    raw: {} as never,
    ...over,
  };
}

function view(over: Partial<ConversationView>): ConversationView {
  return {
    conversationId: 'c0',
    label: 'C0',
    kind: 'sms',
    participants: [],
    isGroup: false,
    ...over,
  };
}

describe('toView', () => {
  it('prefers an operator label, then joined participants, then the id', () => {
    const labels = { c1: 'Landlord' };
    expect(toView(summary({ conversationId: 'c1', participants: ['+1555'] }), labels).label).toBe('Landlord');
    expect(toView(summary({ conversationId: 'c2', participants: ['Alice', 'Bob'] }), labels).label).toBe(
      'Alice, Bob',
    );
    expect(toView(summary({ conversationId: 'c3', participants: [] }), labels).label).toBe('c3');
  });

  it('flags more than one participant as a group (heuristic)', () => {
    expect(toView(summary({ participants: ['Alice'] }), {}).isGroup).toBe(false);
    expect(toView(summary({ participants: ['Alice', 'Bob'] }), {}).isGroup).toBe(true);
  });
});

describe('resolveConversation', () => {
  const views = [
    view({ conversationId: 'c1', label: 'Alice Chen', participants: ['Alice Chen'] }),
    view({ conversationId: 'c2', label: 'Alice Wong', participants: ['Alice Wong'] }),
    view({ conversationId: 'c3', label: 'Landlord', participants: ['+14155550000'] }),
  ];

  it('matches an exact conversation id first', () => {
    expect(resolveConversation('c2', views).match?.conversationId).toBe('c2');
  });

  it('matches an exact (case-insensitive) name over substrings', () => {
    // "Alice Chen" is an exact label match even though "Alice" is a substring of two.
    expect(resolveConversation('alice chen', views).match?.conversationId).toBe('c1');
  });

  it('matches a phone number held as a participant', () => {
    expect(resolveConversation('+14155550000', views).match?.conversationId).toBe('c3');
  });

  it('reports ambiguity when a substring hits several', () => {
    const r = resolveConversation('alice', views);
    expect(r.match).toBeUndefined();
    expect(r.ambiguous?.map((v) => v.conversationId)).toEqual(['c1', 'c2']);
  });

  it('returns nothing for no match or empty query', () => {
    expect(resolveConversation('nobody', views)).toEqual({});
    expect(resolveConversation('   ', views)).toEqual({});
  });
});
