/**
 * Identity provider — resolves transport handles to stable identities.
 *
 * LocalIdentityProvider stores identities in a SQLite database (identities.db).
 * Operator handles (`cli:*`/`admin:*`) bypass the IdP — the self-identifying
 * handle IS the identity (a machine-trust tier, not an IdP record). Telegram
 * and other handles require explicit registration (via pairing).
 */
import Database from 'better-sqlite3';
import { createHash, createPublicKey, createPrivateKey, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { isOperatorHandle } from './address.js';
import { asIdentityId } from './address.js';
import type { IdentityId } from './address.js';
import { queryAll, queryOne } from '../lib/db-query.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Row schemas (Zod validation for better-sqlite3 results)
// ---------------------------------------------------------------------------

const ServerIdRow = z.object({ server_id: z.string() });
const IdentityRow = z.object({ id: z.string(), declared_name: z.string() });
const HandleRow = z.object({ handle: z.string() });
const IdentityWithHandleRow = z.object({
  id: z.string(),
  declared_name: z.string(),
  created_at: z.string(),
  paired_via: z.string().nullable(),
  handle: z.string().nullable(),
});
const AgentNameGuidRow = z.object({ name: z.string(), guid: z.string() });
const GuidRow = z.object({ guid: z.string() });
const AgentRegistrationRow = z.object({
  name: z.string(),
  guid: z.string(),
  fingerprint: z.string(),
  registered_at: z.string(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedIdentity {
  /** Identity ID — bare `u:<guid>@<issuer>`, or a self-identifying operator
   *  surface (`cli:…`/`admin:…`). Branded: the IdP is the minting boundary
   *  for identity ids — consumers trust the brand without re-validating. */
  id: IdentityId;
  /** User-chosen display name. */
  declaredName: string;
  /** The transport handle that was resolved. */
  handle: string;
}

export interface AgentRegistration {
  name: string;
  guid: string;
  fingerprint: string;
  registeredAt: string;
}

export interface IdentityRecord {
  id: string;
  declaredName: string;
  createdAt: string;
  pairedVia: string | null;
  handles: string[];
}

export interface AgentVerifyResult {
  verified: boolean;
  /** Canonical bus address: `a:<guid>@<issuer>`. Empty on verify failure. */
  address: string;
  /** IdP-minted stable identifier. Empty on verify failure. */
  guid: string;
}

export interface IdentityProvider {
  resolve(handle: string): ResolvedIdentity | null;
  register(handle: string, declaredName: string, pairedVia?: string): ResolvedIdentity;
  updateDeclaredName(identityId: string, name: string): void;
  getIdentity(identityId: string): IdentityRecord | null;
  /** Handles owned by an identity (reverse of `resolve`). List-typed: today 0..1, multi-transport-ready. `local` → []. */
  getHandlesForIdentity(identityId: string): string[];
  linkHandle(identityId: string, handle: string): void;
  verifyAgent(alias: string, keyPem: string): AgentVerifyResult;
  listIdentities(): IdentityRecord[];
  listAgentRegistrations(): AgentRegistration[];
  readonly idpIdentifier: string;
}

// ---------------------------------------------------------------------------
// LocalIdentityProvider
// ---------------------------------------------------------------------------

function createIdentitySchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS identities (
      id TEXT PRIMARY KEY,
      declared_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      paired_via TEXT
    );
    CREATE TABLE IF NOT EXISTS handle_mappings (
      handle TEXT PRIMARY KEY,
      identity_id TEXT NOT NULL REFERENCES identities(id)
    );
    CREATE TABLE IF NOT EXISTS server_meta (
      server_id TEXT PRIMARY KEY
    );
    CREATE TABLE IF NOT EXISTS agent_registrations (
      name          TEXT PRIMARY KEY,
      guid          TEXT NOT NULL,
      pubkey        TEXT NOT NULL,
      fingerprint   TEXT NOT NULL,
      registered_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_reg_guid ON agent_registrations(guid);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_reg_fingerprint ON agent_registrations(fingerprint);
  `);
}

export class LocalIdentityProvider implements IdentityProvider {
  private db: Database.Database;
  private idpId: string;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    createIdentitySchema(this.db);
    this.idpId = this.loadOrCreateServerId();
  }

  /** @internal — for tests only. Creates an in-memory provider. */
  static _createTest(): LocalIdentityProvider {
    const provider = Object.create(LocalIdentityProvider.prototype) as LocalIdentityProvider;
    provider.db = new Database(':memory:');
    createIdentitySchema(provider.db);
    provider.idpId = provider.loadOrCreateServerId();
    return provider;
  }

  /** IdP instance identifier for provenance (e.g. "a3k9f2"). */
  get idpIdentifier(): string {
    return this.idpId;
  }

  private loadOrCreateServerId(): string {
    const row = queryOne(this.db.prepare('SELECT server_id FROM server_meta LIMIT 1'), ServerIdRow);
    if (row) return row.server_id;
    const id = randomBytes(3).toString('hex');
    this.db.prepare('INSERT INTO server_meta (server_id) VALUES (?)').run(id);
    return id;
  }

  private generateIdentityId(): string {
    return `u:${randomBytes(5).toString('hex')}@${this.idpId}`;
  }

  private generateAgentGuid(): string {
    return randomBytes(5).toString('hex');
  }

  resolve(handle: string): ResolvedIdentity | null {
    // Operator transports (CLI, admin console) bypass the IdP entirely: the
    // self-identifying handle IS the identity — there is no `local` sentinel.
    // Both bind to localhost only, so machine access is the trust boundary;
    // `isOperatorTier` (`auth/address.ts`) recognizes the handle as the operator
    // tier → ACL full access. (`cli:alice` is to the operator what `u:guid` is
    // to a user.)
    if (isOperatorHandle(handle)) {
      const name = handle.slice(handle.indexOf(':') + 1); // "cli:alice" → "alice"
      // Brand minted here: the operator surface is its own identity id.
      return { id: asIdentityId(handle), declaredName: name, handle };
    }

    const row = queryOne(this.db.prepare(
      `SELECT i.id, i.declared_name
       FROM handle_mappings h
       JOIN identities i ON h.identity_id = i.id
       WHERE h.handle = ?`,
    ), IdentityRow, handle);

    if (!row) return null;
    // Brand minted here: row.id is an IdP-owned identity PK.
    return { id: asIdentityId(row.id), declaredName: row.declared_name, handle };
  }

  register(handle: string, declaredName: string, pairedVia?: string): ResolvedIdentity {
    declaredName = declaredName.slice(0, 255);
    const id = this.generateIdentityId();
    const now = new Date().toISOString();

    this.db.transaction(() => {
      this.db.prepare(
        'INSERT INTO identities (id, declared_name, created_at, paired_via) VALUES (?, ?, ?, ?)',
      ).run(id, declaredName, now, pairedVia ?? null);

      this.db.prepare(
        'INSERT INTO handle_mappings (handle, identity_id) VALUES (?, ?)',
      ).run(handle, id);
    })();

    return { id: asIdentityId(id), declaredName, handle };
  }

  updateDeclaredName(identityId: string, name: string): void {
    this.db.prepare(
      'UPDATE identities SET declared_name = ? WHERE id = ?',
    ).run(name.slice(0, 255), identityId);
  }

  getIdentity(identityId: string): IdentityRecord | null {
    // Operator handles (cli/admin) are self-identifying and virtual — never in
    // the DB. The handle IS the id; bypasses the IdP exactly like `resolve()`.
    if (isOperatorHandle(identityId)) {
      return {
        id: identityId,
        declaredName: identityId.slice(identityId.indexOf(':') + 1),
        createdAt: '',
        pairedVia: null,
        handles: [],
      };
    }

    const rows = queryAll(this.db.prepare(
      `SELECT i.id, i.declared_name, i.created_at, i.paired_via, h.handle
       FROM identities i
       LEFT JOIN handle_mappings h ON i.id = h.identity_id
       WHERE i.id = ?`,
    ), IdentityWithHandleRow, identityId);

    if (rows.length === 0) return null;

    const first = rows[0]!;
    return {
      id: first.id,
      declaredName: first.declared_name,
      createdAt: first.created_at,
      pairedVia: first.paired_via,
      handles: rows.flatMap((r) => r.handle ? [r.handle] : []),
    };
  }

  getHandlesForIdentity(identityId: string): string[] {
    // Operator handles bypass the IdP — the handle is its own wire, not a mapping.
    if (isOperatorHandle(identityId)) return [];
    return queryAll(this.db.prepare(
      'SELECT handle FROM handle_mappings WHERE identity_id = ?',
    ), HandleRow, identityId).map((r) => r.handle);
  }

  linkHandle(identityId: string, handle: string): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO handle_mappings (handle, identity_id) VALUES (?, ?)',
    ).run(handle, identityId);
  }

  /**
   * Verify or register an agent's pubkey. Identity is key-derived (fingerprint), not
   * name-derived — rename of alias is a detected, non-destructive event.
   * - Key seen, matching alias → return verified.
   * - Key seen, different alias → UPDATE alias, log rename, return verified (same GUID).
   * - Key unseen, alias free → first sign-on: mint GUID, INSERT, return verified.
   * - Key unseen, alias taken by a different key → return NOT verified (alias collision).
   * - Malformed PEM → return NOT verified.
   */
  verifyAgent(alias: string, keyPem: string): AgentVerifyResult {
    const fail = (): AgentVerifyResult => ({ verified: false, address: '', guid: '' });

    // Derive public key fingerprint from private key PEM (agent proves ownership)
    let fingerprint: string;
    let pubkeyB64: string;
    try {
      const privateKey = createPrivateKey({ key: keyPem, format: 'pem' });
      const der = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
      fingerprint = createHash('sha256').update(der).digest('hex').slice(0, 16);
      pubkeyB64 = der.toString('base64');
    } catch (err) {
      logger.warn({ alias, err }, 'Agent key verification failed — malformed PEM');
      return fail();
    }

    const byFingerprint = queryOne(this.db.prepare(
      'SELECT name, guid FROM agent_registrations WHERE fingerprint = ?',
    ), AgentNameGuidRow, fingerprint);

    if (byFingerprint) {
      if (byFingerprint.name !== alias) {
        // Rename: check target alias is not already taken by a *different* key
        const taken = queryOne(this.db.prepare(
          'SELECT guid FROM agent_registrations WHERE name = ? AND fingerprint != ?',
        ), GuidRow, alias, fingerprint);
        if (taken) {
          logger.warn({ fingerprint, newAlias: alias, conflictGuid: taken.guid }, 'Agent rename rejected — alias taken by another key');
          return fail();
        }
        this.db.prepare('UPDATE agent_registrations SET name = ? WHERE fingerprint = ?').run(alias, fingerprint);
        logger.info({ fingerprint, oldAlias: byFingerprint.name, newAlias: alias, guid: byFingerprint.guid }, 'Agent renamed');
      }
      return { verified: true, address: `a:${byFingerprint.guid}@${this.idpId}`, guid: byFingerprint.guid };
    }

    // First sign-on for this key. Reject if alias already held by a different key.
    const aliasTaken = queryOne(this.db.prepare(
      'SELECT guid FROM agent_registrations WHERE name = ?',
    ), GuidRow, alias);
    if (aliasTaken) {
      logger.warn({ alias, conflictGuid: aliasTaken.guid }, 'Agent registration rejected — alias taken by another key');
      return fail();
    }

    const guid = this.generateAgentGuid();
    this.db.prepare(
      'INSERT INTO agent_registrations (name, guid, pubkey, fingerprint, registered_at) VALUES (?, ?, ?, ?, ?)',
    ).run(alias, guid, pubkeyB64, fingerprint, new Date().toISOString());
    return { verified: true, address: `a:${guid}@${this.idpId}`, guid };
  }

  listIdentities(): IdentityRecord[] {
    const rows = queryAll(this.db.prepare(
      `SELECT i.id, i.declared_name, i.created_at, i.paired_via, h.handle
       FROM identities i
       LEFT JOIN handle_mappings h ON i.id = h.identity_id
       ORDER BY i.created_at DESC`,
    ), IdentityWithHandleRow);

    // Group rows by identity (preserving insertion order from ORDER BY)
    const byId = new Map<string, IdentityRecord>();
    for (const row of rows) {
      let record = byId.get(row.id);
      if (!record) {
        record = {
          id: row.id,
          declaredName: row.declared_name,
          createdAt: row.created_at,
          pairedVia: row.paired_via,
          handles: [],
        };
        byId.set(row.id, record);
      }
      if (row.handle) record.handles.push(row.handle);
    }
    return [...byId.values()];
  }

  listAgentRegistrations(): AgentRegistration[] {
    return queryAll(this.db.prepare(
      'SELECT name, guid, fingerprint, registered_at FROM agent_registrations ORDER BY registered_at DESC',
    ), AgentRegistrationRow).map((row) => ({
      name: row.name,
      guid: row.guid,
      fingerprint: row.fingerprint,
      registeredAt: row.registered_at,
    }));
  }

  close(): void {
    this.db.close();
  }
}
