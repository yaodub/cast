/**
 * HostActivityLog — structured event log for the host orchestrator process.
 *
 * Mirrors the per-agent `events` table (`agent-db.ts`) at host scope: bus
 * dispatches, gateway routing, transport ingest, container lifecycle, IdP
 * writes — anything happening *outside* an agent container that the operator
 * should be able to see.
 *
 * Two sinks per call: structured SQLite row + pino line at the same level.
 * The SQLite row is the curated, queryable, admin-UI-visible marker; pino is
 * the firehose. Writers don't have to remember to do both — `logEvent` does
 * both.
 *
 * Storage: `<CAST_CONFIG_DIR>/host.db` (sibling of `gateway.db`, separate file —
 * different metaphor: gateway.db stores packets, host.db stores operational
 * events).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import { CONFIG_DIR } from '../config.js';
import { queryAll } from '../lib/db-query.js';
import { logger } from '../logger.js';

// --- Schemas & derived types ---

const HostEventLevelSchema = z.enum(['error', 'warn', 'info']);
export type HostEventLevel = z.infer<typeof HostEventLevelSchema>;

const RawHostEventRowSchema = z.object({
  id: z.number(),
  ts: z.string(),
  level: HostEventLevelSchema,
  component: z.string(),
  event_name: z.string(),
  message: z.string(),
  from_addr: z.string().nullable(),
  to_addr: z.string().nullable(),
  context_json: z.string().nullable(),
});
type RawHostEventRow = z.infer<typeof RawHostEventRowSchema>;

export interface HostEventEntry {
  id: number;
  ts: string;
  level: HostEventLevel;
  component: string;
  event_name: string;
  message: string;
  from_addr: string | null;
  to_addr: string | null;
  context: Record<string, unknown> | null;
}

interface HostEventQueryOpts {
  level?: HostEventLevel;
  component?: string;
  since?: string;
}

/**
 * Callback signature for subsystems that don't hold a HostActivityLog handle
 * directly. The host wiring (`index.ts`) binds this to its singleton's
 * `logEvent` and threads it as an optional opt into bus, gateway, transports,
 * and container-runner — same shape as the agent-side `LogEventFn`.
 */
export type LogHostEventFn = (
  level: HostEventLevel,
  component: string,
  eventName: string,
  message: string,
  opts?: { fromAddr?: string; toAddr?: string; context?: Record<string, unknown> },
) => void;

// --- HostActivityLog ---

export class HostActivityLog {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.createSchema();
  }

  /**
   * Write a structured event row AND emit a pino line at the same level.
   * Single call, two sinks — same convenience trick as `AgentDb.logEvent`.
   */
  logEvent(
    level: HostEventLevel,
    component: string,
    eventName: string,
    message: string,
    opts?: { fromAddr?: string; toAddr?: string; context?: Record<string, unknown> },
  ): void {
    this.db.prepare(`
      INSERT INTO events (ts, level, component, event_name, message, from_addr, to_addr, context_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      new Date().toISOString(),
      level,
      component,
      eventName,
      message,
      opts?.fromAddr ?? null,
      opts?.toAddr ?? null,
      opts?.context ? JSON.stringify(opts.context) : null,
    );

    // Mirror to pino so existing log pipelines keep flowing.
    const logFields: Record<string, unknown> = { component, event: eventName };
    if (opts?.fromAddr) logFields.from = opts.fromAddr;
    if (opts?.toAddr) logFields.to = opts.toAddr;
    if (opts?.context) logFields.ctx = opts.context;
    logger[level](logFields, message);
  }

  readEvents(opts?: HostEventQueryOpts & { limit?: number }): HostEventEntry[] {
    const limit = opts?.limit ?? 100;
    const { where, params } = buildHostEventsWhere(opts);
    params.push(limit);

    const stmt = this.db.prepare(`
      SELECT id, ts, level, component, event_name, message, from_addr, to_addr, context_json
      FROM events
      ${where}
      ORDER BY ts DESC, id DESC
      LIMIT ?
    `);
    return queryAll(stmt, RawHostEventRowSchema, ...params).map(parseHostEventRow);
  }

  countEvents(opts?: HostEventQueryOpts): number {
    const { where, params } = buildHostEventsWhere(opts);
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM events ${where}`).get(...params);
    return z.object({ count: z.number() }).parse(row).count;
  }

  /** Wipe the event log. Returns the number of rows deleted. */
  clearEvents(): number {
    const result = this.db.prepare('DELETE FROM events').run();
    return result.changes;
  }

  close(): void {
    this.db.close();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          TEXT NOT NULL,
        level       TEXT NOT NULL,
        component   TEXT NOT NULL,
        event_name  TEXT NOT NULL,
        message     TEXT NOT NULL,
        from_addr   TEXT,
        to_addr     TEXT,
        context_json TEXT
      );
      CREATE INDEX IF NOT EXISTS host_events_ts_idx ON events(ts DESC);
      CREATE INDEX IF NOT EXISTS host_events_level_idx ON events(level);
      CREATE INDEX IF NOT EXISTS host_events_component_idx ON events(component);
    `);
  }
}

// --- Factory + helpers ---

/**
 * Open the host activity log at `CONFIG_DIR/host.db`. Mirrors `initGatewayDb`
 * in shape — separate file, separate metaphor (gateway = packets,
 * host = operational events).
 */
export function initHostActivityLog(): HostActivityLog {
  const dbPath = path.join(CONFIG_DIR, 'host.db');
  return new HostActivityLog(dbPath);
}

function parseHostEventRow(row: RawHostEventRow): HostEventEntry {
  return {
    id: row.id,
    ts: row.ts,
    level: row.level,
    component: row.component,
    event_name: row.event_name,
    message: row.message,
    from_addr: row.from_addr,
    to_addr: row.to_addr,
    context: row.context_json ? z.record(z.string(), z.unknown()).parse(JSON.parse(row.context_json)) : null,
  };
}

function buildHostEventsWhere(opts?: HostEventQueryOpts): { where: string; params: (string | number)[] } {
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

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}
