/**
 * ApprovalsStore — reusable approval-tracking bundle.
 *
 * Installs the `approvals` table on any SQLite handle and exposes the
 * approve/reject lifecycle operations over it. Extracted from AgentDb
 * so the same schema + ops can later compose into a
 * server-scope store for owned / cross-agent approvals.
 *
 * Bundle naming convention: every SQL object owned by this bundle is prefixed
 * with `approvals` — today just the table; future indexes/triggers follow the
 * `approvals_*` prefix.
 *
 * Composed by:
 *   - `AgentDb` (per-agent approvals at state/agent.db)
 */
import type Database from 'better-sqlite3';
import { z } from 'zod';

import { queryAll, queryOne } from './db-query.js';
import { parseJsonSafe } from './utils.js';

// --- Schema ---

const ApprovalRowSchema = z.object({
  id: z.string(),
  // Nullable: a `tool-call` approval carries the tool + its serialized args; an
  // `acl-edge` approval (reactive ACL grant) has no tool, so both are NULL.
  // The `type` column discriminates which shape a row is.
  tool: z.string().nullable(),
  args: z.string().nullable(),
  summary: z.string(),
  details: z.string().nullable(),
  participant: z.string(),
  channel: z.string().nullable(),
  conversation_key: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'interrupted', 'dismissed']),
  created_at: z.string(),
  expires_at: z.string().nullable(),
  resolved_at: z.string().nullable(),
  reason: z.string().nullable(),
  // Generalized approval shape. `type`/`controller`/`tier` are active
  // (owner-directed approvals); `payload` carries the acl-edge held-request
  // reference. No parse defaults — every DB has these columns: fresh ones
  // from the CREATE TABLE below, existing ones via the one-time upgrade script
  // (scripts/migrations/0.2-to-0.3). `type`/`tier` carry SQL DEFAULTs; the rest
  // are nullable.
  type: z.string(),
  controller: z.string().nullable(),
  tier: z.string(),
  principal: z.string().nullable(),
  destination: z.string().nullable(),
  provenance: z.string().nullable(),
  payload: z.string().nullable(),
});
export type ApprovalRow = z.infer<typeof ApprovalRowSchema>;
export type ApprovalStatus = ApprovalRow['status'];

export interface InsertApprovalData {
  id: string;
  /** Present for `tool-call` approvals; omitted for `acl-edge` (no tool). */
  tool?: string;
  args?: Record<string, unknown>;
  summary: string;
  details?: string;
  participant: string;
  /** Discriminates the approval shape. Defaults to `tool-call`. */
  type?: string;
  /** Who may decide this approval — the answerer-auth key. Defaults (at the
   *  caller) to the conversing participant; owner-approves sets it to the owner. */
  controller?: string;
  channel?: string;
  conversationKey?: string;
  expiresAt?: string;
  /** Type-specific carry. For `acl-edge`: the held inbound-request reference and
   *  the edge being granted, so the resolution can resume + persist. */
  payload?: string;
}

// --- Schema install ---

/**
 * Idempotent install — safe to call on every DB-open. Creates the `approvals`
 * table with the full generalized column set. `tool`/`args` are nullable so an
 * `acl-edge` row (no tool) is representable; existing 0.2 databases reach this
 * shape via the one-time upgrade script (scripts/migrations/0.2-to-0.3).
 */
export function installApprovalsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS approvals (
      id               TEXT PRIMARY KEY,
      tool             TEXT,
      args             TEXT,
      summary          TEXT NOT NULL,
      details          TEXT,
      participant      TEXT NOT NULL,
      channel          TEXT,
      conversation_key TEXT,
      status           TEXT NOT NULL DEFAULT 'pending',
      created_at       TEXT NOT NULL,
      expires_at       TEXT,
      resolved_at      TEXT,
      reason           TEXT,
      type             TEXT NOT NULL DEFAULT 'tool-call',
      controller       TEXT,
      tier             TEXT NOT NULL DEFAULT 'once',
      principal        TEXT,
      destination      TEXT,
      provenance       TEXT,
      payload          TEXT
    );
  `);
}

/**
 * What "still decidable" means, in one place.
 *
 * Correctness must not depend on a sweep having run. `expireStale` keeps the
 * *stored* status honest for display and audit, but any query that interprets
 * pending-ness carries the deadline itself, so a caller cannot reintroduce the
 * bug by forgetting to sweep first. A null `expires_at` means no deadline.
 */
const DECIDABLE = "status = 'pending' AND (expires_at IS NULL OR expires_at > ?)";

/**
 * Its complement: dead, by any route — interrupted at a restart, marked
 * expired, or past its deadline without the boot sweep having relabelled it yet
 * (a lapsed row still stores 'pending' between boot and now while every surface
 * already treats it as dead). Dismiss has to accept exactly what the surface
 * showed as dead, or the button does nothing.
 */
const LAPSED = "(status IN ('expired', 'interrupted') OR (status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?))";

/**
 * The row-level mirror of `DECIDABLE`, for callers holding a row rather than
 * issuing a query. Kept beside it so the two cannot drift: a surface that
 * renders "expired" and a query that refuses to resolve one must agree.
 */
export function isExpired(row: Pick<ApprovalRow, 'status' | 'expires_at'>, now = new Date()): boolean {
  if (row.status === 'expired') return true;
  return row.expires_at !== null && new Date(row.expires_at) < now;
}

// --- Operations ---

export class ApprovalsStore {
  constructor(private db: Database.Database) {}

  insertApproval(data: InsertApprovalData): void {
    this.db.prepare(
      `INSERT INTO approvals (id, tool, args, summary, details, participant, type, controller, channel, conversation_key, created_at, expires_at, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      data.id, data.tool ?? null, data.args ? JSON.stringify(data.args) : null, data.summary,
      data.details ?? null, data.participant, data.type ?? 'tool-call', data.controller ?? null,
      data.channel ?? null, data.conversationKey ?? null, new Date().toISOString(),
      data.expiresAt ?? null, data.payload ?? null,
    );
  }

  getApproval(id: string): ApprovalRow | undefined {
    return queryOne(
      this.db.prepare('SELECT * FROM approvals WHERE id = ?'),
      ApprovalRowSchema,
      id,
    );
  }

  updateApprovalStatus(id: string, status: ApprovalStatus, reason?: string, tier?: string): void {
    if (tier !== undefined) {
      this.db.prepare(
        'UPDATE approvals SET status = ?, resolved_at = ?, reason = ?, tier = ? WHERE id = ?',
      ).run(status, new Date().toISOString(), reason ?? null, tier, id);
      return;
    }
    this.db.prepare(
      'UPDATE approvals SET status = ?, resolved_at = ?, reason = ? WHERE id = ?',
    ).run(status, new Date().toISOString(), reason ?? null, id);
  }

  /**
   * Cross-conversation standing verdict for (participant, tool) from a prior
   * owner-directed allow-always / reject-always resolution — the persisted form
   * of "always". Only owner-directed approvals ever set tier='always' (gated in
   * handleResponse on controller != participant), so this never reflects a
   * participant self-exemption. Fail-closed: a reject-always wins.
   */
  standingGrant(participant: string, tool: string): 'allow' | 'reject' | null {
    const has = (status: string) => !!this.db.prepare(
      `SELECT 1 FROM approvals WHERE participant = ? AND tool = ? AND tier = 'always' AND status = ? LIMIT 1`,
    ).get(participant, tool, status);
    if (has('rejected')) return 'reject';
    if (has('approved')) return 'allow';
    return null;
  }

  /**
   * Mark every still-pending approval as 'interrupted'. Called from the
   * shutdown path so an operator returning post-restart sees the orphaned
   * approvals as terminal rather than perpetually-pending. Existing branches
   * use `status !== 'pending'` to gate re-resolution, so 'interrupted' rows
   * are treated correctly (skip-and-warn) by `approval-handler.ts`.
   */
  markPendingApprovalsInterrupted(): number {
    // Only tool-call rows: their outcome routes into a conversation that dies
    // with the process, so 'interrupted' is the truthful terminal state. The
    // policy shapes (acl-edge, user-push) carry their held request in `payload`
    // and resolve statelessly, so they ride their window across restarts.
    // Allowlist rather than exclusion: wrongly interrupting a survivable type
    // destroys a live decision, wrongly sparing a context-bound one merely
    // lapses into a visible 'expired' row later.
    return this.db.prepare(
      "UPDATE approvals SET status = 'interrupted', resolved_at = ?, reason = ? WHERE status = 'pending' AND type = 'tool-call'",
    ).run(new Date().toISOString(), 'server shutdown').changes;
  }

  /**
   * The id of a pending `acl-edge` approval already deciding this edge
   * `(participant, channel)`, or null. The reactive gate dedups on this:
   * the owner decides the *edge* (bit `a`), so a second inbound on the same edge
   * never raises a second approval — one grant covers all its traffic, and on
   * resolve only the first held request is released (queuing later ones would
   * release messages the owner never saw, a consent-laundering bug). Bit is `a`
   * for every inbound request/query today, so it isn't matched explicitly.
   */
  pendingAclEdge(participant: string, channel: string, bits?: string[]): string | null {
    // `bits` narrows by edge direction: inbound access edges carry 'a'/'io' in
    // the payload, outbound containment edges carry 'q'/'r'. Without
    // it a mutual X↔Y attempt on one channel would cross-dedup (both rows share
    // participant + channel). Filtered in JS — the candidate set per (participant,
    // channel) is tiny; the edge bit lives in `payload`, not a column.
    // Deadline-aware: an expired row must not dedup a fresh ask. Suppressing on
    // one would strand the requester behind a decision nobody can make any more.
    const rows = this.db.prepare(
      `SELECT id, payload FROM approvals WHERE type = 'acl-edge' AND ${DECIDABLE} AND participant = ? AND channel = ? ORDER BY created_at DESC`,
    ).all(new Date().toISOString(), participant, channel) as { id: string; payload: string | null }[];
    for (const row of rows) {
      if (!bits) return row.id;
      let edgeBit: string | undefined;
      try { edgeBit = row.payload ? (JSON.parse(row.payload) as { bit?: string }).bit : undefined; } catch { /* unparseable → skip */ }
      if (edgeBit && bits.includes(edgeBit)) return row.id;
    }
    return null;
  }

  /**
   * The pending `user-push` approval id already deciding edge `(channel, pusher →
   * pushee)`, or null — the user↔user reactive gate's dedup key. The
   * pushee (`controller`) decides the edge, not each push, so a second push on the
   * same edge while one is in flight never raises a second approval. Keyed on all
   * three columns (`participant` = pusher, `controller` = pushee) so distinct
   * pushees from one pusher, or distinct pushers to one pushee, stay separate.
   */
  pendingUserPush(channel: string, pusher: string, pushee: string): string | null {
    const row = this.db.prepare(
      `SELECT id FROM approvals WHERE type = 'user-push' AND ${DECIDABLE} AND channel = ? AND participant = ? AND controller = ? ORDER BY created_at DESC`,
    ).get(new Date().toISOString(), channel, pusher, pushee) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /**
   * Transition every pending row past its `expires_at` to 'expired'.
   *
   * Expiry used to be discovered only when a human clicked an already-dead row
   * (`approval-handler`'s soft check), so a stale approval sat 'pending'
   * indefinitely and rendered as actionable. Sweeping makes the stored status
   * honest before anyone looks. Marking is deliberately not the same as hiding:
   * an expired row stays on the operator surface until dismissed, because a
   * decision that silently vanished is the failure mode this replaces.
   *
   * Runs once at startup, the only point guaranteed to execute — a shutdown
   * sweep is bypassed by SIGKILL, OOM and power loss. Reads do not depend on it:
   * `DECIDABLE` carries the deadline, so a lapsed row is already excluded from
   * every decision path before the sweep relabels it.
   */
  expireStale(now = new Date()): number {
    return this.db.prepare(
      `UPDATE approvals SET status = 'expired', resolved_at = ?
       WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < ?`,
    ).run(now.toISOString(), now.toISOString()).changes;
  }

  /**
   * Operator inbox rows: still-pending, plus dead-but-not-yet-dismissed
   * (expired or interrupted).
   *
   * Dead rows are returned so the surface shows them *as* dead rather than
   * dropping them — a decision that silently vanished is the failure mode this
   * surface exists to prevent, whichever way it died. `status` rides along so
   * the caller renders each state; no dead row may offer an approve action.
   */
  listOperatorApprovals(): ApprovalRow[] {
    return queryAll(
      this.db.prepare(
        "SELECT * FROM approvals WHERE status IN ('pending', 'expired', 'interrupted') ORDER BY created_at DESC",
      ),
      ApprovalRowSchema,
    );
  }

  /** Clear a dead row from the operator surface. Terminal, and only legal from
   *  a non-decidable state — a decidable row must be decided, not dismissed. */

  dismissApproval(id: string): boolean {
    const now = new Date().toISOString();
    return this.db.prepare(
      `UPDATE approvals SET status = 'dismissed', resolved_at = ? WHERE id = ? AND ${LAPSED}`,
    ).run(now, id, now).changes > 0;
  }

  /** Approvals a decision can still resolve. Excludes rows past their deadline
   *  whether or not `expireStale` has caught them yet. */
  listPendingApprovals(participant?: string): ApprovalRow[] {
    const now = new Date().toISOString();
    if (participant) {
      return queryAll(
        this.db.prepare(`SELECT * FROM approvals WHERE ${DECIDABLE} AND participant = ? ORDER BY created_at DESC`),
        ApprovalRowSchema,
        now,
        participant,
      );
    }
    return queryAll(
      this.db.prepare(`SELECT * FROM approvals WHERE ${DECIDABLE} ORDER BY created_at DESC`),
      ApprovalRowSchema,
      now,
    );
  }

  /**
   * Returns true if any approved row in the given conversation, for any of `tools`,
   * has args matching `argsMatch`. Approval validity is bounded by the conversation
   * itself — rows from past conversations are invisible to this query because they
   * carry a different conversation_key. Used by approval filters to inherit trust
   * across related tools within the same conversation.
   */
  hasApprovalInConversation(input: {
    conversationKey: string;
    tools: string[];
    argsMatch: (args: Record<string, unknown>) => boolean;
  }): boolean {
    if (input.tools.length === 0) return false;
    const placeholders = input.tools.map(() => '?').join(',');
    const rows = queryAll(
      this.db.prepare(
        `SELECT * FROM approvals WHERE status = 'approved' AND conversation_key = ? AND tool IN (${placeholders}) ORDER BY created_at DESC`,
      ),
      ApprovalRowSchema,
      input.conversationKey, ...input.tools,
    );
    for (const row of rows) {
      if (row.args === null) continue;
      const parsed = parseJsonSafe(row.args, z.record(z.string(), z.unknown()));
      if (!parsed) continue;
      if (input.argsMatch(parsed)) return true;
    }
    return false;
  }
}
