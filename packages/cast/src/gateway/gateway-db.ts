/**
 * Gateway database — stores packets (the messaging primitive).
 *
 * Separate from state.db (internal plumbing) so the packet log is a clean,
 * queryable record of all messages that crossed the gateway boundary.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import { CONFIG_DIR } from '../config.js';
import { queryAll } from '../lib/db-query.js';
import type { Packet } from './packets.js';

// SIDE EFFECT: Module-level mutable singleton, set by initGatewayDb() or _initTestGatewayDb().
// Required because better-sqlite3 Database instances are stateful and must be shared across
// all query functions. A pure approach (passing db to every function) would thread an extra
// parameter through every call site with no benefit.
let db: Database.Database;

function createSchema(database: Database.Database): void {
  // Schema: payload column is SSOT for packet content; routing columns
  // (from_addr, to_addr, channel, conversation_key) are derived indexes.
  // Never DROP here — packets are durable records of gateway traffic and
  // must survive server restarts (reload replay depends on it).
  // DBs created before 0.2 lack `failed_at` — covered by
  // `scripts/migrations/0.1-to-0.2/3-packets-failed-at.ts`, not by an inline
  // migration here.
  database.exec(`
    CREATE TABLE IF NOT EXISTS packets (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      from_addr TEXT NOT NULL,
      to_addr TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      direction TEXT DEFAULT 'inbound',
      delivered_at TEXT,
      failed_at TEXT,
      conversation_key TEXT,
      channel TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_packets_timestamp ON packets(timestamp);
    CREATE INDEX IF NOT EXISTS idx_packets_addrs ON packets(to_addr, from_addr);
    CREATE INDEX IF NOT EXISTS idx_packets_undelivered ON packets(delivered_at) WHERE delivered_at IS NULL AND failed_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_packets_conversation ON packets(to_addr, conversation_key);
  `);
}

export function initGatewayDb(): void {
  const dbPath = path.join(CONFIG_DIR, 'gateway.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  createSchema(db);
}

export function closeGatewayDb(): void {
  if (db) db.close();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestGatewayDb(): void {
  db = new Database(':memory:');
  createSchema(db);
}

const StoredPacketSchema = z.object({
  id: z.string(),
  type: z.string(),
  from_addr: z.string(),
  to_addr: z.string(),
  timestamp: z.string(),
  delivered_at: z.string().nullable(),
  failed_at: z.string().nullable(),
  direction: z.string(),
  conversation_key: z.string().nullable(),
  channel: z.string().nullable(),
  payload: z.string(),
});

export type StoredPacket = z.infer<typeof StoredPacketSchema>;

export function storePacket(
  id: string,
  pkt: Packet,
  direction: 'inbound' | 'outbound' = 'inbound',
  conversationKey?: string,
  channel?: string,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO packets (id, type, from_addr, to_addr, timestamp, direction, conversation_key, channel, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id, pkt.type, pkt.from, pkt.to, pkt.timestamp,
    direction, conversationKey ?? null, channel ?? null,
    JSON.stringify(pkt),
  );
}

/** Mark a packet as delivered (sets delivered_at to current time). */
export function markDelivered(pktId: string): void {
  db.prepare('UPDATE packets SET delivered_at = ? WHERE id = ?').run(new Date().toISOString(), pktId);
}

/**
 * Mark a packet delivered only if it was addressed to the given recipient.
 * Returns true if the row was updated — used to guard client-initiated acks
 * against cross-identity forgery.
 */
export function markDeliveredIfAddressedTo(pktId: string, toAddr: string): boolean {
  const res = db.prepare('UPDATE packets SET delivered_at = ? WHERE id = ? AND to_addr = ? AND direction = ?')
    .run(new Date().toISOString(), pktId, toAddr, 'outbound');
  return res.changes > 0;
}

/**
 * Mark a packet failed (terminal — TTL-expired or poison payload; it will
 * never be delivered). No-op if the packet was already delivered, so a late
 * ack racing an expiry sweep can't be overwritten into a failure.
 */
export function markFailed(pktId: string): void {
  db.prepare('UPDATE packets SET failed_at = ? WHERE id = ? AND delivered_at IS NULL')
    .run(new Date().toISOString(), pktId);
}

/** Get all pending (undelivered, not failed) packets for a given direction. */
export function getUndeliveredPackets(direction: 'inbound' | 'outbound'): StoredPacket[] {
  const stmt = db.prepare(
    `SELECT id, type, from_addr, to_addr, timestamp, delivered_at, failed_at, direction, conversation_key, channel, payload
     FROM packets
     WHERE delivered_at IS NULL AND failed_at IS NULL AND direction = ?
     ORDER BY timestamp ASC`,
  );
  return queryAll(stmt, StoredPacketSchema, direction);
}

/** Get pending outbound packets for a specific recipient, ordered oldest-first. */
export function getPendingOutboundForRecipient(toAddr: string): StoredPacket[] {
  const stmt = db.prepare(
    `SELECT id, type, from_addr, to_addr, timestamp, delivered_at, failed_at, direction, conversation_key, channel, payload
     FROM packets
     WHERE to_addr = ? AND direction = 'outbound' AND delivered_at IS NULL AND failed_at IS NULL
     ORDER BY timestamp ASC`,
  );
  return queryAll(stmt, StoredPacketSchema, toAddr);
}

/**
 * Get bidirectional packet history between an agent and a participant.
 * Returns packets where (from=agent AND to=participant) OR (from=participant AND to=agent).
 * If `channel` is provided, filters in SQL so LIMIT applies per-channel
 * (important once a single agent/participant pair has traffic across
 * multiple channels — otherwise older in-channel packets get silently
 * dropped when the limit is hit by other-channel traffic).
 */
export function getPacketHistory(
  agentAddr: string,
  participant: string,
  opts?: { limit?: number; channel?: string },
): StoredPacket[] {
  const limit = opts?.limit ?? 50;

  if (opts?.channel !== undefined) {
    const stmt = db.prepare(
      `SELECT id, type, from_addr, to_addr, timestamp, delivered_at, failed_at, direction, conversation_key, channel, payload
       FROM packets
       WHERE ((from_addr = ? AND to_addr = ?) OR (from_addr = ? AND to_addr = ?))
         AND channel = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
    );
    return queryAll(stmt, StoredPacketSchema, agentAddr, participant, participant, agentAddr, opts.channel, limit);
  }

  const stmt = db.prepare(
    `SELECT id, type, from_addr, to_addr, timestamp, delivered_at, failed_at, direction, conversation_key, channel, payload
     FROM packets
     WHERE (from_addr = ? AND to_addr = ?) OR (from_addr = ? AND to_addr = ?)
     ORDER BY timestamp DESC
     LIMIT ?`,
  );
  return queryAll(stmt, StoredPacketSchema, agentAddr, participant, participant, agentAddr, limit);
}
