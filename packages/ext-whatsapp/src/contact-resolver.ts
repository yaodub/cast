/**
 * WhatsApp extension — contact identity layer.
 *
 * Replaces the previous JID-keyed model. A `contacts` row represents one
 * logical human (or group); `jid_aliases` maps every JID form to its
 * contact. When WhatsApp reveals that two JIDs are the same human, we
 * merge the contacts instead of rewriting JID keys across the messages
 * table.
 *
 * Display name is materialized on write using the hierarchy:
 *   phonebook_name → verified_name → given_name (push_name) →
 *   formatted-phone-from-PN-alias → raw primary JID.
 *
 * Every pair source (message key alts, Contact records, group participants,
 * auth/lid-mapping files, self pair from creds.me) feeds through
 * `learnPair()` which handles both discovery of a new alias for an
 * existing contact AND merging two contacts that turn out to be the
 * same human.
 */
import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';
import type { Logger } from '@getcast/extension-schema';

import { isGroupJid, isLidJid, isPnJid, normalizeJid } from './helpers.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContactRow {
  contact_id: number;
  is_group: number;
  display_name: string | null;
  phonebook_name: string | null;
  given_name: string | null;
  verified_name: string | null;
  unread_count: number;
  last_ts: number;
}

export interface ContactHints {
  phonebookName?: string;
  givenName?: string;   // push_name / Contact.notify
  verifiedName?: string;
  isGroup?: boolean;
  lastTs?: number;
  unreadCount?: number;
}

type AliasForm = 'pn' | 'lid' | 'group' | 'other';

function classifyJid(jid: string): AliasForm {
  if (isPnJid(jid)) return 'pn';
  if (isLidJid(jid)) return 'lid';
  if (isGroupJid(jid)) return 'group';
  return 'other';
}

// ---------------------------------------------------------------------------
// ContactResolver
// ---------------------------------------------------------------------------

export class ContactResolver {
  /** Hot cache: canonical JID → contact_id. */
  private readonly jidToContactId = new Map<string, number>();
  /** Hot cache: contact_id → row. */
  private readonly contactById = new Map<number, ContactRow>();
  /** Hot cache: contact_id → list of alias JIDs. */
  private readonly aliasesByContactId = new Map<number, Set<string>>();

  private stmts!: ReturnType<typeof prepareStatements>;

  /**
   * Hook called inside `mergeContacts` so the store can rewrite any tables
   * that reference `contact_id` (messages, sender_contact_id, …). Runs in
   * the same transaction as the alias/metadata changes.
   */
  onMerge: ((surviving: number, subsumed: number) => void) | null = null;

  constructor(
    private db: Database.Database,
    private log: Logger,
  ) {
    this.createSchema();
    this.stmts = prepareStatements(db);
    this.hydrate();
  }

  // =========================================================================
  // Schema + hydration
  // =========================================================================

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        contact_id      INTEGER PRIMARY KEY AUTOINCREMENT,
        is_group        INTEGER NOT NULL DEFAULT 0,
        display_name    TEXT,
        phonebook_name  TEXT,
        given_name      TEXT,
        verified_name   TEXT,
        unread_count    INTEGER NOT NULL DEFAULT 0,
        last_ts         INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS jid_aliases (
        jid             TEXT PRIMARY KEY,
        contact_id      INTEGER NOT NULL,
        form            TEXT NOT NULL,
        last_seen_ts    INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (contact_id) REFERENCES contacts(contact_id)
      );

      CREATE INDEX IF NOT EXISTS idx_aliases_contact ON jid_aliases(contact_id);
    `);
  }

  private hydrate(): void {
    const contactRows = this.db.prepare('SELECT * FROM contacts').all() as ContactRow[];
    for (const row of contactRows) {
      this.contactById.set(row.contact_id, row);
      this.aliasesByContactId.set(row.contact_id, new Set());
    }
    const aliasRows = this.db.prepare('SELECT jid, contact_id FROM jid_aliases').all() as { jid: string; contact_id: number }[];
    for (const { jid, contact_id } of aliasRows) {
      this.jidToContactId.set(jid, contact_id);
      const set = this.aliasesByContactId.get(contact_id);
      if (set) set.add(jid);
    }
  }

  // =========================================================================
  // Seeding from Baileys auth dir
  // =========================================================================

  /**
   * Read every `auth/lid-mapping-*.json` file (forward + reverse) plus
   * `creds.me` and feed the pairs through `learnPair`. Called once at
   * store construction. Idempotent.
   */
  seedFromAuthDir(authDir: string): void {
    if (!fs.existsSync(authDir)) return;

    // Self pair from creds.json
    try {
      const creds = JSON.parse(fs.readFileSync(path.join(authDir, 'creds.json'), 'utf-8'));
      const meId = typeof creds?.me?.id === 'string' ? normalizeJid(creds.me.id) : null;
      const meLid = typeof creds?.me?.lid === 'string' ? normalizeJid(creds.me.lid) : null;
      if (meId && meLid && isPnJid(meId) && isLidJid(meLid)) {
        this.learnPair(meId, meLid);
      }
    } catch {
      // unpaired or unreadable — nothing to seed from creds
    }

    let entries: string[];
    try { entries = fs.readdirSync(authDir); } catch { return; }

    for (const name of entries) {
      if (!name.startsWith('lid-mapping-') || !name.endsWith('.json')) continue;
      const stem = name.slice('lid-mapping-'.length, -'.json'.length);
      const isReverse = stem.endsWith('_reverse');
      const leftUser = isReverse ? stem.slice(0, -'_reverse'.length) : stem;
      if (!/^\d+$/.test(leftUser)) continue;
      try {
        const rightUser = JSON.parse(fs.readFileSync(path.join(authDir, name), 'utf-8'));
        if (typeof rightUser !== 'string' || !/^\d+$/.test(rightUser)) continue;
        const pn = isReverse ? `${rightUser}@s.whatsapp.net` : `${leftUser}@s.whatsapp.net`;
        const lid = isReverse ? `${leftUser}@lid` : `${rightUser}@lid`;
        this.learnPair(pn, lid);
      } catch {
        // skip malformed
      }
    }
  }

  // =========================================================================
  // Primary resolver
  // =========================================================================

  /**
   * Return the contact_id for this JID. Creates a new contact if the JID
   * is unknown. `hints` update the contact's metadata and trigger
   * display_name recomputation.
   */
  resolveContactId(rawJid: string, hints?: ContactHints): number {
    const jid = normalizeJid(rawJid);
    if (!jid) throw new Error('resolveContactId: empty jid');

    const existing = this.jidToContactId.get(jid);
    if (existing != null) {
      if (hints) this.updateContact(existing, hints);
      this.bumpAliasSeen(jid);
      return existing;
    }

    // New JID — create a contact and attach this as its first alias
    const isGroup = hints?.isGroup ?? isGroupJid(jid);
    const row = this.insertContact(isGroup, hints);
    this.insertAlias(jid, row.contact_id);
    // display_name depends on alias (for phone-number fallback), so recompute now
    this.recomputeDisplayName(row.contact_id);
    return row.contact_id;
  }

  /**
   * Resolve without creating. Returns null if the JID isn't known.
   */
  tryResolveContactId(rawJid: string): number | null {
    const jid = normalizeJid(rawJid);
    return this.jidToContactId.get(jid) ?? null;
  }

  // =========================================================================
  // Pair learning (union-find over contacts)
  // =========================================================================

  /**
   * Record that `pn` and `lid` are the same human. Four cases:
   *   - both unknown → create one contact, add both aliases
   *   - only one known → add the other as an alias of the existing contact
   *   - both known, same contact → no-op
   *   - both known, different contacts → merge (surviving = older contact_id)
   */
  learnPair(rawPn: string, rawLid: string): void {
    const pn = normalizeJid(rawPn);
    const lid = normalizeJid(rawLid);
    if (!isPnJid(pn) || !isLidJid(lid)) return;

    const pnContact = this.jidToContactId.get(pn);
    const lidContact = this.jidToContactId.get(lid);

    if (pnContact != null && lidContact != null) {
      if (pnContact === lidContact) return; // already unified
      // Merge — prefer the older contact_id as survivor (stable ids)
      const surviving = Math.min(pnContact, lidContact);
      const subsumed = Math.max(pnContact, lidContact);
      this.mergeContacts(surviving, subsumed);
      return;
    }

    if (pnContact != null) {
      this.insertAlias(lid, pnContact);
      this.recomputeDisplayName(pnContact);
      return;
    }
    if (lidContact != null) {
      this.insertAlias(pn, lidContact);
      this.recomputeDisplayName(lidContact);
      return;
    }

    // Both new — create one contact with both aliases
    const row = this.insertContact(false, undefined);
    this.insertAlias(pn, row.contact_id);
    this.insertAlias(lid, row.contact_id);
    this.recomputeDisplayName(row.contact_id);
  }

  /**
   * Merge `subsumed` into `surviving`. Rewrites jid_aliases and invokes the
   * `onMerge` hook so the store can re-key messages and sender_contact_id.
   * Everything runs inside the caller's transaction (better-sqlite3 treats
   * nested transactions as savepoints).
   */
  mergeContacts(surviving: number, subsumed: number): void {
    if (surviving === subsumed) return;
    const survivor = this.contactById.get(surviving);
    const loser = this.contactById.get(subsumed);
    if (!survivor || !loser) return;

    // Merge metadata — prefer non-null survivor values, fill from loser where null
    const merged: Partial<ContactRow> = {
      phonebook_name: survivor.phonebook_name ?? loser.phonebook_name,
      given_name: survivor.given_name ?? loser.given_name,
      verified_name: survivor.verified_name ?? loser.verified_name,
      is_group: (survivor.is_group || loser.is_group) ? 1 : 0,
      unread_count: Math.max(survivor.unread_count, loser.unread_count),
      last_ts: Math.max(survivor.last_ts, loser.last_ts),
    };
    this.stmts.updateContactMeta.run({
      contact_id: surviving,
      phonebook_name: merged.phonebook_name ?? null,
      given_name: merged.given_name ?? null,
      verified_name: merged.verified_name ?? null,
      is_group: merged.is_group ?? 0,
      unread_count: merged.unread_count ?? 0,
      last_ts: merged.last_ts ?? 0,
    });
    Object.assign(survivor, merged);

    // Re-home aliases
    this.db.prepare('UPDATE jid_aliases SET contact_id = ? WHERE contact_id = ?').run(surviving, subsumed);
    const subsumedAliases = this.aliasesByContactId.get(subsumed);
    if (subsumedAliases) {
      const survivorAliases = this.aliasesByContactId.get(surviving) ?? new Set<string>();
      for (const jid of subsumedAliases) {
        survivorAliases.add(jid);
        this.jidToContactId.set(jid, surviving);
      }
      this.aliasesByContactId.set(surviving, survivorAliases);
      this.aliasesByContactId.delete(subsumed);
    }

    // Let the store re-key messages and other contact_id references before
    // we delete the losing contact row.
    this.onMerge?.(surviving, subsumed);

    // Delete the subsumed contact row
    this.stmts.deleteContact.run(subsumed);
    this.contactById.delete(subsumed);

    this.recomputeDisplayName(surviving);
    this.log.info({ surviving, subsumed }, 'Merged WhatsApp contacts');
  }

  // =========================================================================
  // Contact metadata updates
  // =========================================================================

  /**
   * Update contact metadata from any source (message ingest, contact event,
   * chat event). Only fills fields where we have a non-empty hint. Phonebook
   * name is rank-higher than given_name, so a later given_name update will
   * NOT overwrite phonebook_name. Recomputes display_name.
   */
  updateContact(contactId: number, hints: ContactHints): void {
    const row = this.contactById.get(contactId);
    if (!row) return;

    let changed = false;
    if (hints.phonebookName && hints.phonebookName !== row.phonebook_name) {
      row.phonebook_name = hints.phonebookName;
      changed = true;
    }
    if (hints.givenName && hints.givenName !== row.given_name) {
      row.given_name = hints.givenName;
      changed = true;
    }
    if (hints.verifiedName && hints.verifiedName !== row.verified_name) {
      row.verified_name = hints.verifiedName;
      changed = true;
    }
    if (hints.isGroup && !row.is_group) {
      row.is_group = 1;
      changed = true;
    }
    if (hints.lastTs && hints.lastTs > row.last_ts) {
      row.last_ts = hints.lastTs;
      changed = true;
    }
    if (hints.unreadCount != null && hints.unreadCount !== row.unread_count) {
      row.unread_count = hints.unreadCount;
      changed = true;
    }

    if (!changed) return;
    this.stmts.updateContactMeta.run({
      contact_id: contactId,
      phonebook_name: row.phonebook_name,
      given_name: row.given_name,
      verified_name: row.verified_name,
      is_group: row.is_group,
      unread_count: row.unread_count,
      last_ts: row.last_ts,
    });
    this.recomputeDisplayName(contactId);
  }

  /**
   * Advance last_ts (and reinsert the alias with updated last_seen_ts).
   * Called when we observe a message for the contact.
   */
  bumpLastTs(contactId: number, ts: number): void {
    if (!ts) return;
    const row = this.contactById.get(contactId);
    if (!row) return;
    if (ts <= row.last_ts) return;
    row.last_ts = ts;
    this.stmts.updateContactMeta.run({
      contact_id: contactId,
      phonebook_name: row.phonebook_name,
      given_name: row.given_name,
      verified_name: row.verified_name,
      is_group: row.is_group,
      unread_count: row.unread_count,
      last_ts: row.last_ts,
    });
  }

  // =========================================================================
  // Lookups
  // =========================================================================

  getContact(contactId: number): ContactRow | undefined {
    return this.contactById.get(contactId);
  }

  getAliases(contactId: number): string[] {
    const set = this.aliasesByContactId.get(contactId);
    return set ? [...set] : [];
  }

  /**
   * Pick the best JID to route an outbound message through. Prefer the
   * most recently-seen LID, then most recent PN, then any alias.
   */
  getPreferredJid(contactId: number): string | undefined {
    const rows = this.db.prepare(`
      SELECT jid, form, last_seen_ts FROM jid_aliases
      WHERE contact_id = ?
      ORDER BY
        CASE form WHEN 'lid' THEN 0 WHEN 'pn' THEN 1 WHEN 'group' THEN 2 ELSE 3 END,
        last_seen_ts DESC
      LIMIT 1
    `).all(contactId) as { jid: string }[];
    return rows[0]?.jid;
  }

  /**
   * All contacts that have had a direct conversation, sorted by last_ts DESC.
   * Contacts created purely as group-participant records (no last_ts) are
   * excluded — otherwise hundreds of group senders would crowd out the real
   * chat list.
   */
  listContacts(limit = 500): ContactRow[] {
    return this.db.prepare(`
      SELECT * FROM contacts
      WHERE last_ts > 0
      ORDER BY last_ts DESC
      LIMIT ?
    `).all(limit) as ContactRow[];
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  private insertContact(isGroup: boolean, hints: ContactHints | undefined): ContactRow {
    const res = this.stmts.insertContact.run({
      is_group: isGroup ? 1 : 0,
      phonebook_name: hints?.phonebookName ?? null,
      given_name: hints?.givenName ?? null,
      verified_name: hints?.verifiedName ?? null,
      unread_count: hints?.unreadCount ?? 0,
      last_ts: hints?.lastTs ?? 0,
    });
    const contactId = Number(res.lastInsertRowid);
    const row: ContactRow = {
      contact_id: contactId,
      is_group: isGroup ? 1 : 0,
      display_name: null,
      phonebook_name: hints?.phonebookName ?? null,
      given_name: hints?.givenName ?? null,
      verified_name: hints?.verifiedName ?? null,
      unread_count: hints?.unreadCount ?? 0,
      last_ts: hints?.lastTs ?? 0,
    };
    this.contactById.set(contactId, row);
    this.aliasesByContactId.set(contactId, new Set());
    return row;
  }

  private insertAlias(jid: string, contactId: number): void {
    this.stmts.insertAlias.run({
      jid,
      contact_id: contactId,
      form: classifyJid(jid),
      last_seen_ts: Math.floor(Date.now() / 1000),
    });
    this.jidToContactId.set(jid, contactId);
    let set = this.aliasesByContactId.get(contactId);
    if (!set) { set = new Set(); this.aliasesByContactId.set(contactId, set); }
    set.add(jid);
  }

  private bumpAliasSeen(jid: string): void {
    this.stmts.bumpAliasSeen.run(Math.floor(Date.now() / 1000), jid);
  }

  /**
   * Recompute display_name from the hierarchy and persist.
   * phonebook_name → verified_name → given_name → formatted PN → raw JID.
   */
  private recomputeDisplayName(contactId: number): void {
    const row = this.contactById.get(contactId);
    if (!row) return;
    const aliases = this.getAliases(contactId);
    const name = computeDisplayName(row, aliases);
    if (name === row.display_name) return;
    row.display_name = name;
    this.stmts.setDisplayName.run({ contact_id: contactId, display_name: name });
  }
}

// ---------------------------------------------------------------------------
// Display-name hierarchy (exported for tests)
// ---------------------------------------------------------------------------

export function computeDisplayName(row: ContactRow, aliases: string[]): string {
  if (row.phonebook_name) return row.phonebook_name;
  if (row.verified_name) return row.verified_name;
  if (row.given_name) return row.given_name;
  // Formatted phone number from PN alias
  const pnAlias = aliases.find(isPnJid);
  if (pnAlias) {
    const digits = pnAlias.replace(/@.*$/, '');
    // International formatting: a "+" prefix is almost always an improvement
    // over a raw JID. We don't split into country-code groups — that requires
    // country metadata we don't maintain.
    return `+${digits}`;
  }
  // Last resort: whichever alias we have
  return aliases[0] ?? `contact-${row.contact_id}`;
}

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

function prepareStatements(db: Database.Database) {
  return {
    insertContact: db.prepare(`
      INSERT INTO contacts (is_group, phonebook_name, given_name, verified_name, unread_count, last_ts)
      VALUES (@is_group, @phonebook_name, @given_name, @verified_name, @unread_count, @last_ts)
    `),
    updateContactMeta: db.prepare(`
      UPDATE contacts SET
        phonebook_name = @phonebook_name,
        given_name = @given_name,
        verified_name = @verified_name,
        is_group = @is_group,
        unread_count = @unread_count,
        last_ts = @last_ts
      WHERE contact_id = @contact_id
    `),
    setDisplayName: db.prepare(`
      UPDATE contacts SET display_name = @display_name WHERE contact_id = @contact_id
    `),
    deleteContact: db.prepare(`
      DELETE FROM contacts WHERE contact_id = ?
    `),
    insertAlias: db.prepare(`
      INSERT INTO jid_aliases (jid, contact_id, form, last_seen_ts)
      VALUES (@jid, @contact_id, @form, @last_seen_ts)
      ON CONFLICT(jid) DO UPDATE SET
        contact_id = @contact_id,
        last_seen_ts = @last_seen_ts
    `),
    bumpAliasSeen: db.prepare(`
      UPDATE jid_aliases SET last_seen_ts = ? WHERE jid = ?
    `),
  };
}

