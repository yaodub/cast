/**
 * AgentDb — per-agent database with participant registry, request tracking,
 * approvals, events, and the message log bundle.
 *
 * Self-contained SQLite database at state/agent.db. Message log lives in a
 * reusable `MessageLogStore` bundle (`../lib/message-log-store.ts`) that is
 * also used by per-agent and server-scope console databases. AgentDb owns
 * its handle; the bundle installs its own schema on that handle.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import { queryAll, queryOne } from '../lib/db-query.js';
import { logger } from '../logger.js';
import { installMessageLogSchema, MessageLogStore } from '../lib/message-log-store.js';
import { installTokenUsageSchema, TokenUsageStore } from '../lib/token-usage-store.js';

import { parseJsonSafe } from '../lib/utils.js';

// --- Zod schemas & derived types ---

const ParticipantRowSchema = z.object({
  address: z.string(),
  last_active: z.string(),
});
type ParticipantRow = z.infer<typeof ParticipantRowSchema>;

const OutboundRequestRowSchema = z.object({
  request_id: z.string(),
  target_agent: z.string(),
  target_channel: z.string(),
  channel: z.string(),
  participant: z.string(),
  status: z.string(),
  created_at: z.string(),
});
type OutboundRequestRow = z.infer<typeof OutboundRequestRowSchema>;

const OutboundPushRowSchema = z.object({
  request_id: z.string(),
  target_agent: z.string(),
  target_channel: z.string(),
  channel: z.string(),
  participant: z.string(),
  qualifier: z.string().nullable().optional(),
  status: z.string(),
  created_at: z.string(),
});
type OutboundPushRow = z.infer<typeof OutboundPushRowSchema>;

const InboundRequestRowSchema = z.object({
  request_id: z.string(),
  from_agent: z.string(),
  return_to_agent: z.string(),
  return_to_channel: z.string(),
  return_to_participant: z.string(),
  return_to_qualifier: z.string().nullable().optional(),
  channel: z.string(),
  participant: z.string(),
  upstream_set: z.string(),
  query_text: z.string(),
  status: z.string(),
  created_at: z.string(),
});
type InboundRequestRow = z.infer<typeof InboundRequestRowSchema>;

const ApprovalRowSchema = z.object({
  id: z.string(),
  tool: z.string(),
  args: z.string(),
  summary: z.string(),
  details: z.string().nullable(),
  participant: z.string(),
  channel: z.string().nullable(),
  conversation_key: z.string().nullable(),
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'interrupted']),
  created_at: z.string(),
  expires_at: z.string().nullable(),
  resolved_at: z.string().nullable(),
  reason: z.string().nullable(),
});
export type ApprovalRow = z.infer<typeof ApprovalRowSchema>;
export type ApprovalStatus = ApprovalRow['status'];

const EventLevelSchema = z.enum(['error', 'warn', 'info']);
export type EventLevel = z.infer<typeof EventLevelSchema>;

const RawEventRowSchema = z.object({
  id: z.number(),
  ts: z.string(),
  level: EventLevelSchema,
  component: z.string(),
  event_name: z.string(),
  message: z.string(),
  conversation_key: z.string().nullable(),
  context_json: z.string().nullable(),
});
type RawEventRow = z.infer<typeof RawEventRowSchema>;

export interface EventEntry {
  id: number;
  ts: string;
  level: EventLevel;
  component: string;
  event_name: string;
  message: string;
  conversation_key: string | null;
  context: Record<string, unknown> | null;
}

interface EventQueryOpts {
  level?: EventLevel;
  component?: string;
  since?: string;
  conversationKey?: string;
}

/**
 * Callback signature for subsystems that don't hold an AgentDb directly.
 * AgentManager binds this to its own `agentDb.logEvent` and threads it as an
 * optional opt into AgentService, AgentScheduler, and runContainerAgent.
 */
export type LogEventFn = (
  level: EventLevel,
  component: string,
  eventName: string,
  message: string,
  opts?: { conversationKey?: string; context?: Record<string, unknown> },
) => void;

interface InsertApprovalData {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  details?: string;
  participant: string;
  channel?: string;
  conversationKey?: string;
  expiresAt?: string;
}

interface RecordOutboundRequestData {
  requestId: string;
  targetAgent: string;
  targetChannel: string;
  channel: string;
  participant: string;
  status?: string;
}

interface RecordOutboundPushData {
  requestId: string;
  targetAgent: string;
  targetChannel: string;
  /** Sender-side origin channel — the cell the push was emitted from. */
  channel: string;
  /** Sender-side origin participant — the cell the push was emitted from. */
  participant: string;
  /** Sender-side origin qualifier — the sharded sub-conversation, when present. */
  qualifier?: string;
}

interface RecordInboundRequestData {
  requestId: string;
  fromAgent: string;
  returnToAgent: string;
  returnToChannel: string;
  returnToParticipant: string;
  returnToQualifier?: string;
  channel: string;
  participant: string;
  upstreamSet: string;
  queryText: string;
}

// --- AgentDb ---

export class AgentDb {
  private db: Database.Database;
  readonly messages: MessageLogStore;
  readonly tokens: TokenUsageStore;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.createSchema();
    installMessageLogSchema(this.db);
    installTokenUsageSchema(this.db);
    this.messages = new MessageLogStore(this.db);
    this.tokens = new TokenUsageStore(this.db);
  }

  // =========================================================================
  // Participant registry
  // =========================================================================

  upsertParticipant(address: string): void {
    this.db.prepare(`
      INSERT INTO participants (address, last_active) VALUES (?, ?)
      ON CONFLICT(address) DO UPDATE SET last_active = excluded.last_active
    `).run(address, new Date().toISOString());
  }

  participantExists(address: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM participants WHERE address = ?').get(address);
  }

  getAllParticipants(): ParticipantRow[] {
    return queryAll(
      this.db.prepare('SELECT address, last_active FROM participants ORDER BY last_active DESC'),
      ParticipantRowSchema,
    );
  }

  // =========================================================================
  // Request tracking
  // =========================================================================

  recordOutboundRequest(data: RecordOutboundRequestData): void {
    this.db.prepare(`
      INSERT INTO outbound_requests (request_id, target_agent, target_channel, channel, participant, status)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(data.requestId, data.targetAgent, data.targetChannel, data.channel, data.participant, data.status ?? 'open');
  }

  recordInboundRequest(data: RecordInboundRequestData): void {
    this.db.prepare(`
      INSERT INTO inbound_requests (request_id, from_agent, return_to_agent, return_to_channel, return_to_participant, return_to_qualifier, channel, participant, upstream_set, query_text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.requestId, data.fromAgent, data.returnToAgent, data.returnToChannel,
      data.returnToParticipant, data.returnToQualifier ?? null,
      data.channel, data.participant, data.upstreamSet, data.queryText,
    );
  }

  getOutboundRequest(requestId: string): OutboundRequestRow | undefined {
    return queryOne(
      this.db.prepare('SELECT * FROM outbound_requests WHERE request_id = ?'),
      OutboundRequestRowSchema,
      requestId,
    );
  }

  getInboundRequest(requestId: string): InboundRequestRow | undefined {
    return queryOne(
      this.db.prepare('SELECT * FROM inbound_requests WHERE request_id = ?'),
      InboundRequestRowSchema,
      requestId,
    );
  }

  updateRequestStatus(table: 'inbound' | 'outbound', requestId: string, status: string): void {
    const tableName = table === 'inbound' ? 'inbound_requests' : 'outbound_requests';
    const changes = this.db.prepare(
      `UPDATE ${tableName} SET status = ? WHERE request_id = ? AND status = 'open'`,
    ).run(status, requestId).changes;
    if (changes === 0) {
      logger.warn({ table, requestId, status }, 'Request status update skipped (not open or not found)');
    }
  }

  // =========================================================================
  // Outbound push tracking
  //
  // Push and query share the rejection-correlation mechanism (`<cast:rejection
  // request="<id>">`), but they're cousins not siblings: queries have a
  // `'fulfilled'` terminal and receiver-side `inbound_requests` bookkeeping;
  // pushes only have `'open' | 'rejected'` and no inbound counterpart, so
  // they live in their own table. Sender-side rejection routing tries
  // `outbound_requests` first and falls back to `outbound_pushes` — the
  // requestId space is opaque (`generateId('req')`) so the disambiguation
  // is structural, not collision-prone.
  // =========================================================================

  recordOutboundPush(data: RecordOutboundPushData): void {
    this.db.prepare(`
      INSERT INTO outbound_pushes (request_id, target_agent, target_channel, channel, participant, qualifier)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      data.requestId, data.targetAgent, data.targetChannel,
      data.channel, data.participant, data.qualifier ?? null,
    );
  }

  getOutboundPush(requestId: string): OutboundPushRow | undefined {
    return queryOne(
      this.db.prepare('SELECT * FROM outbound_pushes WHERE request_id = ?'),
      OutboundPushRowSchema,
      requestId,
    );
  }

  updateOutboundPushStatus(requestId: string, status: string): void {
    const changes = this.db.prepare(
      `UPDATE outbound_pushes SET status = ? WHERE request_id = ? AND status = 'open'`,
    ).run(status, requestId).changes;
    if (changes === 0) {
      logger.warn({ requestId, status }, 'Outbound push status update skipped (not open or not found)');
    }
  }

  /** Drop outbound push rows older than `cutoffIso`. Lifecycle terminal is
   *  TTL-based — pushes have no `'fulfilled'` state, so rows accumulate by
   *  age and are swept periodically. */
  purgeExpiredOutboundPushes(cutoffIso: string): number {
    return this.db.prepare(
      `DELETE FROM outbound_pushes WHERE created_at < ?`,
    ).run(cutoffIso).changes;
  }

  /** List requests for a (channel, participant) context. Returns both inbound and outbound. */
  listRequests(channel: string, participant: string): { inbound: InboundRequestRow[]; outbound: OutboundRequestRow[] } {
    const inbound = queryAll(
      this.db.prepare('SELECT * FROM inbound_requests WHERE channel = ? AND participant = ? ORDER BY created_at DESC'),
      InboundRequestRowSchema,
      channel, participant,
    );
    const outbound = queryAll(
      this.db.prepare('SELECT * FROM outbound_requests WHERE channel = ? AND participant = ? ORDER BY created_at DESC'),
      OutboundRequestRowSchema,
      channel, participant,
    );
    return { inbound, outbound };
  }

  /** Get open inbound requests for a (channel, participant) context. Used for DAG upstream set derivation. */
  getOpenInboundRequests(channel: string, participant: string): InboundRequestRow[] {
    return queryAll(
      this.db.prepare("SELECT * FROM inbound_requests WHERE channel = ? AND participant = ? AND status = 'open'"),
      InboundRequestRowSchema,
      channel, participant,
    );
  }

  /**
   * Mark every still-open inbound and outbound request as 'interrupted'.
   * Called from the shutdown path so cross-agent in-flight queries leave a
   * terminal trail in the DB instead of lingering as 'open' forever.
   */
  markOpenRequestsInterrupted(): { inbound: number; outbound: number } {
    const inbound = this.db.prepare(
      "UPDATE inbound_requests SET status = 'interrupted' WHERE status = 'open'",
    ).run().changes;
    const outbound = this.db.prepare(
      "UPDATE outbound_requests SET status = 'interrupted' WHERE status = 'open'",
    ).run().changes;
    return { inbound, outbound };
  }

  /** Close all open requests for a (channel, participant). Returns closed inbound requests (for rejection routing). */
  closeAllRequests(channel: string, participant: string): { closedInbound: InboundRequestRow[]; closedOutboundCount: number } {
    const openInbound = queryAll(
      this.db.prepare("SELECT * FROM inbound_requests WHERE channel = ? AND participant = ? AND status = 'open'"),
      InboundRequestRowSchema,
      channel, participant,
    );

    const inboundResult = this.db.prepare(
      "UPDATE inbound_requests SET status = 'closed' WHERE channel = ? AND participant = ? AND status = 'open'",
    ).run(channel, participant);

    const outboundResult = this.db.prepare(
      "UPDATE outbound_requests SET status = 'closed' WHERE channel = ? AND participant = ? AND status = 'open'",
    ).run(channel, participant);

    return { closedInbound: openInbound, closedOutboundCount: outboundResult.changes };
  }

  // =========================================================================
  // Approval tracking
  // =========================================================================

  insertApproval(data: InsertApprovalData): void {
    this.db.prepare(
      `INSERT INTO approvals (id, tool, args, summary, details, participant, channel, conversation_key, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      data.id, data.tool, JSON.stringify(data.args), data.summary,
      data.details ?? null, data.participant, data.channel ?? null,
      data.conversationKey ?? null, new Date().toISOString(), data.expiresAt ?? null,
    );
  }

  getApproval(id: string): ApprovalRow | undefined {
    return queryOne(
      this.db.prepare('SELECT * FROM approvals WHERE id = ?'),
      ApprovalRowSchema,
      id,
    );
  }

  updateApprovalStatus(id: string, status: ApprovalStatus, reason?: string): void {
    this.db.prepare(
      'UPDATE approvals SET status = ?, resolved_at = ?, reason = ? WHERE id = ?',
    ).run(status, new Date().toISOString(), reason ?? null, id);
  }

  /**
   * Mark every still-pending approval as 'interrupted'. Called from the
   * shutdown path so an operator returning post-restart sees the orphaned
   * approvals as terminal rather than perpetually-pending. Existing branches
   * use `status !== 'pending'` to gate re-resolution, so 'interrupted' rows
   * are treated correctly (skip-and-warn) by `approval-handler.ts`.
   */
  markPendingApprovalsInterrupted(): number {
    return this.db.prepare(
      "UPDATE approvals SET status = 'interrupted', resolved_at = ?, reason = ? WHERE status = 'pending'",
    ).run(new Date().toISOString(), 'server shutdown').changes;
  }

  listPendingApprovals(participant?: string): ApprovalRow[] {
    if (participant) {
      return queryAll(
        this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' AND participant = ? ORDER BY created_at DESC"),
        ApprovalRowSchema,
        participant,
      );
    }
    return queryAll(
      this.db.prepare("SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC"),
      ApprovalRowSchema,
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
      const parsed = parseJsonSafe(row.args, z.record(z.string(), z.unknown()));
      if (!parsed) continue;
      if (input.argsMatch(parsed)) return true;
    }
    return false;
  }

  // =========================================================================
  // Event log
  // =========================================================================

  logEvent(
    level: EventLevel,
    component: string,
    eventName: string,
    message: string,
    opts?: { conversationKey?: string; context?: Record<string, unknown> },
  ): void {
    this.db.prepare(`
      INSERT INTO events (ts, level, component, event_name, message, conversation_key, context_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      level,
      component,
      eventName,
      message,
      opts?.conversationKey ?? null,
      opts?.context ? JSON.stringify(opts.context) : null,
    );
  }

  readEvents(opts?: EventQueryOpts & { limit?: number }): EventEntry[] {
    const limit = opts?.limit ?? 50;
    const { where, params } = buildEventsWhere(opts);
    params.push(limit);

    const stmt = this.db.prepare(`
      SELECT id, ts, level, component, event_name, message, conversation_key, context_json
      FROM events
      ${where}
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `);
    return queryAll(stmt, RawEventRowSchema, ...params).map(parseEventRow);
  }

  countEvents(opts?: EventQueryOpts): number {
    const { where, params } = buildEventsWhere(opts);
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM events ${where}`).get(...params);
    return z.object({ count: z.number() }).parse(row).count;
  }

  /** Wipe the event log. Returns the number of rows deleted. */
  clearEvents(): number {
    const result = this.db.prepare(`DELETE FROM events`).run();
    return result.changes;
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  close(): void {
    this.db.close();
  }

  private ensureColumn(table: string, column: string, columnDef: string): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${columnDef}`);
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS participants (
        address TEXT PRIMARY KEY,
        last_active TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbound_requests (
        request_id       TEXT PRIMARY KEY,
        target_agent     TEXT NOT NULL,
        target_channel   TEXT NOT NULL,
        channel          TEXT NOT NULL,
        participant      TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'open',
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS outbound_pushes (
        request_id       TEXT PRIMARY KEY,
        target_agent     TEXT NOT NULL,
        target_channel   TEXT NOT NULL,
        channel          TEXT NOT NULL,
        participant      TEXT NOT NULL,
        qualifier        TEXT,
        status           TEXT NOT NULL DEFAULT 'open',
        created_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS inbound_requests (
        request_id            TEXT PRIMARY KEY,
        from_agent            TEXT NOT NULL,
        return_to_agent       TEXT NOT NULL,
        return_to_channel     TEXT NOT NULL,
        return_to_participant TEXT NOT NULL,
        return_to_qualifier   TEXT,
        channel               TEXT NOT NULL,
        participant           TEXT NOT NULL,
        upstream_set          TEXT NOT NULL,
        query_text            TEXT NOT NULL,
        status                TEXT NOT NULL DEFAULT 'open',
        created_at            TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id               TEXT PRIMARY KEY,
        tool             TEXT NOT NULL,
        args             TEXT NOT NULL,
        summary          TEXT NOT NULL,
        details          TEXT,
        participant      TEXT NOT NULL,
        channel          TEXT,
        conversation_key TEXT,
        status           TEXT NOT NULL DEFAULT 'pending',
        created_at       TEXT NOT NULL,
        expires_at       TEXT,
        resolved_at      TEXT,
        reason           TEXT
      );

      CREATE TABLE IF NOT EXISTS events (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        ts               TEXT NOT NULL,
        level            TEXT NOT NULL,
        component        TEXT NOT NULL,
        event_name       TEXT NOT NULL,
        message          TEXT NOT NULL,
        conversation_key TEXT,
        context_json     TEXT
      );
      CREATE INDEX IF NOT EXISTS events_ts_idx ON events(ts DESC);
    `);

    // Idempotent schema additions for DBs created before a column existed.
    // SQLite has no native "ADD COLUMN IF NOT EXISTS" — gate on PRAGMA table_info.
    this.ensureColumn('inbound_requests', 'return_to_qualifier', 'TEXT');
  }
}

// --- Internal helpers ---

function parseEventRow(row: RawEventRow): EventEntry {
  return {
    id: row.id,
    ts: row.ts,
    level: row.level,
    component: row.component,
    event_name: row.event_name,
    message: row.message,
    conversation_key: row.conversation_key,
    context: row.context_json ? z.record(z.string(), z.unknown()).parse(JSON.parse(row.context_json)) : null,
  };
}

function buildEventsWhere(opts?: EventQueryOpts): { where: string; params: (string | number)[] } {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (opts?.level) {
    conditions.push('level = ?');
    params.push(opts.level);
  }
  if (opts?.component) {
    conditions.push('component = ?');
    params.push(opts.component);
  }
  if (opts?.since) {
    conditions.push('ts > ?');
    params.push(opts.since);
  }
  if (opts?.conversationKey) {
    conditions.push('conversation_key = ?');
    params.push(opts.conversationKey);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}
