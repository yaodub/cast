/**
 * MessageLogStore — reusable message log bundle.
 *
 * Installs the `message_log` table + FTS5 search index on any SQLite handle,
 * and exposes operations to log inbound/outbound messages and search them.
 *
 * Bundle naming convention: every SQL object owned by this bundle is prefixed
 * with `message_log` — table, indexes, triggers, FTS shadow tables. Bundles
 * that compose multiple schemas in the same DB must pick non-overlapping
 * prefixes.
 *
 * Composed by:
 *   - `AgentDb` (per-agent message history)
 *   - `ConsoleDb` (per-agent + server-scope console session history)
 */
import type Database from 'better-sqlite3';
import { z } from 'zod';

import { queryAll, queryOne } from './db-query.js';
import { parseAttachmentMetas } from './utils.js';
import type { AttachmentMeta } from '../types.js';

// --- Schema ---

const RawMessageRowSchema = z.object({
  id: z.number(),
  direction: z.enum(['inbound', 'outbound']),
  participant: z.string(),
  text: z.string().nullable(),
  attachments: z.string().nullable(),
  channel: z.string(),
  conversation_key: z.string(),
  timestamp: z.string(),
});
type RawMessageRow = z.infer<typeof RawMessageRowSchema>;

export interface MessageLogEntry {
  id: number;
  direction: 'inbound' | 'outbound';
  participant: string;
  text: string | null;
  internal: string | null;
  attachments: AttachmentMeta[] | null;
  channel: string;
  conversation_key: string;
  timestamp: string;
}

// --- Schema install ---

/**
 * Idempotent install — safe to call on every DB-open. Creates the
 * `message_log` table, its index, the FTS5 virtual table, and the three
 * sync triggers as one logical unit. The FTS shadow tables follow the
 * `message_log_fts_*` prefix automatically (FTS5 derives them from the
 * virtual-table name).
 */
export function installMessageLogSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      participant TEXT NOT NULL,
      sender TEXT,
      text TEXT,
      internal TEXT,
      attachments TEXT,
      channel TEXT NOT NULL,
      conversation_key TEXT NOT NULL,
      timestamp TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS message_log_ts ON message_log(timestamp);
  `);

  const hasFts = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_log_fts'",
  ).get();

  if (!hasFts) {
    db.exec(`
      CREATE VIRTUAL TABLE message_log_fts USING fts5(text, content=message_log, content_rowid=id);

      CREATE TRIGGER message_log_ai AFTER INSERT ON message_log BEGIN
        INSERT INTO message_log_fts(rowid, text) VALUES (new.id, new.text);
      END;

      CREATE TRIGGER message_log_ad AFTER DELETE ON message_log BEGIN
        INSERT INTO message_log_fts(message_log_fts, rowid, text) VALUES('delete', old.id, old.text);
      END;

      CREATE TRIGGER message_log_au AFTER UPDATE ON message_log BEGIN
        INSERT INTO message_log_fts(message_log_fts, rowid, text) VALUES('delete', old.id, old.text);
        INSERT INTO message_log_fts(rowid, text) VALUES (new.id, new.text);
      END;
    `);
  }
}

// --- Operations ---

export class MessageLogStore {
  constructor(private db: Database.Database) {}

  logInbound(
    participant: string,
    sender: string | null,
    text: string,
    channel: string,
    conversationKey: string,
    attachments?: AttachmentMeta[],
  ): void {
    this.insert('inbound', participant, sender, text, channel, conversationKey, undefined, attachments);
  }

  logOutbound(
    participant: string,
    sender: string | null,
    text: string | null,
    channel: string,
    conversationKey: string,
    internal?: string | null,
    attachments?: AttachmentMeta[],
  ): void {
    this.insert('outbound', participant, sender, text, channel, conversationKey, internal, attachments);
  }

  search(
    query: string,
    opts?: { limit?: number; channel?: string; participant?: string; before?: string; after?: string },
  ): MessageLogEntry[] {
    const limit = opts?.limit ?? 20;
    const conditions: string[] = ['message_log_fts MATCH ?'];
    const params: (string | number)[] = [query];

    if (opts?.channel) {
      conditions.push('m.channel = ?');
      params.push(opts.channel);
    }
    if (opts?.participant) {
      conditions.push('m.participant = ?');
      params.push(opts.participant);
    }
    if (opts?.before) {
      conditions.push('m.timestamp < ?');
      params.push(opts.before);
    }
    if (opts?.after) {
      conditions.push('m.timestamp > ?');
      params.push(opts.after);
    }

    params.push(limit);

    const stmt = this.db.prepare(`
      SELECT m.id, m.direction, m.participant, m.text, m.attachments, m.channel, m.conversation_key, m.timestamp
      FROM message_log m
      JOIN message_log_fts ON message_log_fts.rowid = m.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY m.timestamp DESC
      LIMIT ?
    `);
    return queryAll(stmt, RawMessageRowSchema, ...params).map(parseMessageRow);
  }

  recent(opts: {
    limit: number;
    before?: string;
    after?: string;
    participant?: string;
    channel?: string;
  }): MessageLogEntry[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (opts.before) {
      conditions.push('timestamp < ?');
      params.push(opts.before);
    }
    if (opts.after) {
      conditions.push('timestamp > ?');
      params.push(opts.after);
    }
    if (opts.participant) {
      conditions.push('participant = ?');
      params.push(opts.participant);
    }
    if (opts.channel) {
      conditions.push('channel = ?');
      params.push(opts.channel);
    }

    params.push(opts.limit);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const stmt = this.db.prepare(`
      SELECT id, direction, participant, text, attachments, channel, conversation_key, timestamp
      FROM message_log
      ${where}
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return queryAll(stmt, RawMessageRowSchema, ...params).map(parseMessageRow);
  }

  /**
   * Return participants other than `exclude` who have sent inbound messages on
   * `channel` since `since` (ISO timestamp), ordered most-recent first. Caller
   * may pass `limit + 1` to detect overflow.
   */
  recentOtherInboundParticipants(opts: {
    channel: string;
    exclude: string;
    since: string;
    limit: number;
  }): { participant: string; last_active: string }[] {
    const rows = this.db.prepare(`
      SELECT participant, MAX(timestamp) AS last_active
      FROM message_log
      WHERE channel = ?
        AND direction = 'inbound'
        AND participant != ?
        AND timestamp >= ?
      GROUP BY participant
      ORDER BY last_active DESC
      LIMIT ?
    `).all(opts.channel, opts.exclude, opts.since, opts.limit) as { participant: string; last_active: string }[];
    return rows;
  }

  read(id: number): MessageLogEntry | null {
    const row = queryOne(
      this.db.prepare(`
        SELECT id, direction, participant, text, attachments, channel, conversation_key, timestamp
        FROM message_log WHERE id = ?
      `),
      RawMessageRowSchema,
      id,
    );
    return row ? parseMessageRow(row) : null;
  }

  private insert(
    direction: 'inbound' | 'outbound',
    participant: string,
    sender: string | null,
    text: string | null,
    channel: string,
    conversationKey: string,
    internal?: string | null,
    attachments?: AttachmentMeta[],
  ): void {
    this.db.prepare(`
      INSERT INTO message_log (direction, participant, sender, text, internal, attachments, channel, conversation_key, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      direction, participant, sender, text, internal ?? null,
      attachments?.length ? JSON.stringify(attachments) : null,
      channel, conversationKey, new Date().toISOString(),
    );
  }
}

// --- Internal ---

function parseMessageRow(row: RawMessageRow): MessageLogEntry {
  return {
    ...row,
    internal: null,
    attachments: row.attachments ? parseAttachmentMetas(row.attachments) : null,
  };
}
