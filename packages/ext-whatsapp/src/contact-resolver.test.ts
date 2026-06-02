/**
 * Tests for the WhatsApp ContactResolver: pair learning, merge (with message
 * re-keying), and display-name hierarchy. Uses an in-memory SQLite DB so there
 * is no fixture filesystem.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import { noopLogger } from '@getcast/extension-schema';

import { ContactResolver, computeDisplayName } from './contact-resolver.js';

const PN_1 = 'xxxxxxxxxx@s.whatsapp.net';
const LID_1 = '111222333@lid';
const PN_2 = '12125551111@s.whatsapp.net';
const LID_2 = '444555666@lid';

function freshResolver(): { db: Database.Database; resolver: ContactResolver } {
  const db = new Database(':memory:');
  db.pragma('journal_mode = MEMORY');
  db.pragma('foreign_keys = ON');
  const resolver = new ContactResolver(db, noopLogger);
  return { db, resolver };
}

describe('ContactResolver.learnPair', () => {
  let db: Database.Database;
  let resolver: ContactResolver;

  beforeEach(() => {
    ({ db, resolver } = freshResolver());
  });

  it('creates one contact when both JIDs are new', () => {
    resolver.learnPair(PN_1, LID_1);
    const fromPn = resolver.tryResolveContactId(PN_1);
    const fromLid = resolver.tryResolveContactId(LID_1);
    expect(fromPn).not.toBeNull();
    expect(fromLid).toBe(fromPn);
    expect(resolver.getAliases(fromPn!).sort()).toEqual([LID_1, PN_1].sort());
  });

  it('attaches alias to existing contact when only one JID is known', () => {
    const cid = resolver.resolveContactId(PN_1, { phonebookName: 'Alice' });
    resolver.learnPair(PN_1, LID_1);
    expect(resolver.tryResolveContactId(LID_1)).toBe(cid);
    expect(resolver.getContact(cid)?.phonebook_name).toBe('Alice');
  });

  it('is a no-op when both JIDs already point to the same contact', () => {
    resolver.learnPair(PN_1, LID_1);
    const before = resolver.tryResolveContactId(PN_1);
    resolver.learnPair(PN_1, LID_1);
    expect(resolver.tryResolveContactId(PN_1)).toBe(before);
  });

  it('merges two contacts when they turn out to be the same human', () => {
    const cidPn = resolver.resolveContactId(PN_1, { phonebookName: 'Alice' });
    const cidLid = resolver.resolveContactId(LID_1, { givenName: 'Ally' });
    expect(cidPn).not.toBe(cidLid);

    resolver.learnPair(PN_1, LID_1);

    const afterPn = resolver.tryResolveContactId(PN_1);
    const afterLid = resolver.tryResolveContactId(LID_1);
    expect(afterPn).toBe(afterLid);
    // Survivor carries both name fields
    const row = resolver.getContact(afterPn!)!;
    expect(row.phonebook_name).toBe('Alice');
    expect(row.given_name).toBe('Ally');
    // Loser row deleted
    const survivor = Math.min(cidPn, cidLid);
    const subsumed = Math.max(cidPn, cidLid);
    expect(afterPn).toBe(survivor);
    const stillExists = db.prepare('SELECT contact_id FROM contacts WHERE contact_id = ?').get(subsumed);
    expect(stillExists).toBeUndefined();
  });

  it('fires onMerge hook so callers can re-key references', () => {
    const cidPn = resolver.resolveContactId(PN_1);
    const cidLid = resolver.resolveContactId(LID_1);
    const calls: Array<[number, number]> = [];
    resolver.onMerge = (surviving, subsumed) => { calls.push([surviving, subsumed]); };

    resolver.learnPair(PN_1, LID_1);

    const survivor = Math.min(cidPn, cidLid);
    const subsumed = Math.max(cidPn, cidLid);
    expect(calls).toEqual([[survivor, subsumed]]);
  });

  it('ignores non-conforming JID pairs', () => {
    resolver.learnPair('not-a-jid', 'also-not-a-jid');
    resolver.learnPair(PN_1, PN_2); // both PN
    resolver.learnPair(LID_1, LID_2); // both LID
    expect(resolver.tryResolveContactId(PN_1)).toBeNull();
  });
});

describe('ContactResolver.merge metadata reconciliation', () => {
  it('prefers survivor values, fills from loser where survivor is null', () => {
    const { resolver } = freshResolver();
    // Insert loser first so survivor = lower id = first inserted
    const a = resolver.resolveContactId(PN_1, { phonebookName: 'A-name' });
    const b = resolver.resolveContactId(LID_1, { phonebookName: 'B-name', givenName: 'B-given' });
    expect(a).toBeLessThan(b);

    resolver.learnPair(PN_1, LID_1);

    const row = resolver.getContact(Math.min(a, b))!;
    expect(row.phonebook_name).toBe('A-name');  // survivor had it, kept
    expect(row.given_name).toBe('B-given');     // survivor was null, filled from loser
  });
});

describe('computeDisplayName hierarchy', () => {
  const baseRow = {
    contact_id: 42,
    is_group: 0,
    display_name: null,
    phonebook_name: null,
    given_name: null,
    verified_name: null,
    unread_count: 0,
    last_ts: 0,
  };

  it('prefers phonebook_name above all others', () => {
    expect(computeDisplayName(
      { ...baseRow, phonebook_name: 'Phone', verified_name: 'Ver', given_name: 'Giv' },
      [PN_1],
    )).toBe('Phone');
  });

  it('falls back to verified_name then given_name', () => {
    expect(computeDisplayName({ ...baseRow, verified_name: 'Ver', given_name: 'Giv' }, [PN_1])).toBe('Ver');
    expect(computeDisplayName({ ...baseRow, given_name: 'Giv' }, [PN_1])).toBe('Giv');
  });

  it('formats PN alias as +digits when no name is known', () => {
    expect(computeDisplayName(baseRow, [PN_1])).toBe('+xxxxxxxxxx');
  });

  it('falls back to first alias when no PN is present', () => {
    expect(computeDisplayName(baseRow, [LID_1])).toBe(LID_1);
  });

  it('returns contact-N when no aliases at all', () => {
    expect(computeDisplayName(baseRow, [])).toBe('contact-42');
  });
});
