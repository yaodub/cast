/**
 * Unread decision logic — the pure core of the per-target unread tracker
 * (`use-admin-global-state.ts`). The hook + localStorage cursor are thin glue
 * around these; pinning the decision here covers the badge behavior without a
 * DOM/hook harness (none in this package). The away→return regression — a
 * message that arrives while the tracker is unmounted must badge on return —
 * is the `hasUnreadSince` "after cursor" case.
 */
import { describe, expect, it } from 'vitest';

import {
  hasUnreadSince,
  isBadgeworthy,
  newestBadgeworthyTimestamp,
  type UnreadMessage,
} from './chat-unread';

const T = (n: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

const agent = (ts: string): UnreadMessage => ({ from: 'agent:smith', type: 'conversation', timestamp: ts });
const operator = (ts: string): UnreadMessage => ({ from: 'local/admin:local', type: 'conversation', timestamp: ts });
const divider = (ts: string): UnreadMessage => ({ from: '', type: 'divider:fresh_conversation', timestamp: ts });

describe('isBadgeworthy', () => {
  it('counts an agent/console message', () => {
    expect(isBadgeworthy(agent(T(1)))).toBe(true);
  });
  it('skips the operator\'s own echo', () => {
    expect(isBadgeworthy(operator(T(1)))).toBe(false);
  });
  it('skips synthetic dividers', () => {
    expect(isBadgeworthy(divider(T(1)))).toBe(false);
  });
});

describe('newestBadgeworthyTimestamp', () => {
  it('returns the latest badge-worthy timestamp', () => {
    expect(newestBadgeworthyTimestamp([agent(T(1)), agent(T(3)), agent(T(2))])).toBe(T(3));
  });
  it('ignores operator echoes and dividers when picking newest', () => {
    // The operator echo / divider are newer in time but must not advance the cursor.
    expect(newestBadgeworthyTimestamp([agent(T(1)), operator(T(5)), divider(T(9))])).toBe(T(1));
  });
  it('returns empty string when there are no badge-worthy messages', () => {
    expect(newestBadgeworthyTimestamp([operator(T(1)), divider(T(2))])).toBe('');
    expect(newestBadgeworthyTimestamp([])).toBe('');
  });
});

describe('hasUnreadSince', () => {
  it('flags a message that arrived after the cursor', () => {
    expect(hasUnreadSince([agent(T(1)), agent(T(5))], T(3))).toBe(true);
  });
  it('does not flag when every message is at or before the cursor', () => {
    expect(hasUnreadSince([agent(T(1)), agent(T(3))], T(3))).toBe(false);
  });
  it('ignores operator echoes and dividers newer than the cursor', () => {
    expect(hasUnreadSince([operator(T(9)), divider(T(8))], T(1))).toBe(false);
  });
  it('regression: a message that landed while the tracker was away badges on return', () => {
    // cursor = last message the operator read before navigating to /chat/.
    const cursor = T(2);
    // On return, the snapshot includes the message that arrived while away (T(4)).
    const onReturn = [agent(T(1)), agent(T(2)), agent(T(4))];
    expect(hasUnreadSince(onReturn, cursor)).toBe(true);
  });
});
