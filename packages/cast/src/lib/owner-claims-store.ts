/**
 * OwnerClaimsStore — owner-designation verification bundle.
 *
 * Installs the `owner_claims` table on any SQLite handle and exposes the
 * mint/redeem lifecycle for owner-claim codes. An operator mints a one-time,
 * time-scoped bearer code; the intended human owner redeems it out-of-band via
 * `/claim <code>`. Redemption IS the verification: it proves the redeemer holds
 * the code the operator handed them, and binds the redeemer's transport-
 * authenticated identity as the agent's owner.
 *
 * Recognition (a name in the roster) is not verification — a stranger can
 * declare any name. The code closes that gap for OWNERSHIP only; access stays
 * recognition-based and is contained by origin-keying (a fake Alice gets her
 * own sandboxed cell, the owner gatekeeps over others).
 *
 * Bundle naming convention: every SQL object owned by this bundle is prefixed
 * with `owner_claims` — today just the table.
 *
 * Composed by:
 *   - `AgentDb` (per-agent claims at state/agent.db)
 */
import { randomBytes } from 'crypto';

import type Database from 'better-sqlite3';
import { z } from 'zod';

import { queryOne } from './db-query.js';

// --- Schema ---

const OwnerClaimRowSchema = z.object({
  code: z.string(),
  // pending  — minted, awaiting redemption (the only redeemable state)
  // redeemed — consumed once; a replay finds this and fails (single-use)
  // superseded — invalidated by a newer mint (one-active-per-agent)
  status: z.enum(['pending', 'redeemed', 'superseded']),
  created_at: z.string(),
  expires_at: z.string(),
  redeemed_at: z.string().nullable(),
  redeemed_by: z.string().nullable(),
});
export type OwnerClaimRow = z.infer<typeof OwnerClaimRowSchema>;

// --- Schema install ---

/** Idempotent install — safe on every DB-open. A new table; existing 0.2/0.3
 *  databases get it from this `CREATE TABLE IF NOT EXISTS` on next open, so no
 *  migration-script entry is needed. */
export function installOwnerClaimsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_claims (
      code        TEXT PRIMARY KEY,
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      redeemed_at TEXT,
      redeemed_by TEXT
    );
  `);
}

// --- Code generation ---

/**
 * A fresh owner-claim code: 40 bits of entropy, lowercase hex. High enough that
 * a guess inside the code's TTL window is infeasible, so the time-scope +
 * one-active + single-use policy carries the anti-spam guarantee without a
 * per-attempt rate limiter. Generated host-side, never derived from identity.
 */
export function generateOwnerClaimCode(): string {
  return randomBytes(5).toString('hex');
}

// --- Operations ---

export class OwnerClaimsStore {
  constructor(private db: Database.Database) {}

  /**
   * Mint a new claim code. One-active-per-agent: every prior pending claim is
   * superseded in the same transaction, so at most one code is ever redeemable
   * at a time (re-minting invalidates an un-redeemed predecessor). `expiresAt`
   * time-scopes the code so a leaked or forgotten one can't be redeemed forever.
   */
  mint(code: string, expiresAt: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("UPDATE owner_claims SET status = 'superseded' WHERE status = 'pending'").run();
      this.db.prepare(
        "INSERT INTO owner_claims (code, status, created_at, expires_at) VALUES (?, 'pending', ?, ?)",
      ).run(code, new Date().toISOString(), expiresAt);
    });
    tx();
  }

  /**
   * Redeem a code, binding `redeemedBy` as the audit subject. A single atomic
   * UPDATE gated on `status = 'pending'` AND not-expired — so a replay (already
   * redeemed), an expired code, a superseded code, or an unknown code all return
   * false indistinguishably. Non-leaky: the redeemer learns only success or
   * failure, never which. ISO-8601 UTC timestamps compare correctly as strings.
   * Returns true exactly once per minted code.
   */
  redeem(code: string, redeemedBy: string): boolean {
    const now = new Date().toISOString();
    const changes = this.db.prepare(
      "UPDATE owner_claims SET status = 'redeemed', redeemed_at = ?, redeemed_by = ? WHERE code = ? AND status = 'pending' AND expires_at > ?",
    ).run(now, redeemedBy, code, now).changes;
    return changes === 1;
  }

  /**
   * The current active (pending, unexpired) claim, or null. Lets the operator
   * panel show whether a code is outstanding and re-surface it rather than
   * minting a fresh one on every reload.
   */
  activeClaim(): OwnerClaimRow | null {
    const now = new Date().toISOString();
    return queryOne(
      this.db.prepare("SELECT * FROM owner_claims WHERE status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 1"),
      OwnerClaimRowSchema,
      now,
    ) ?? null;
  }
}
