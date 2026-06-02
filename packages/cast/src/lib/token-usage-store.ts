/**
 * TokenUsageStore — reusable token-usage telemetry bundle.
 *
 * Installs `token_usage` on any SQLite handle and exposes operations to record
 * SDK usage frames + read aggregates. Rows are daily UPSERTs keyed by
 * `(date, conversation_id, channel, phase, model)` — one row per active
 * (conversation × channel × phase × model) per day. Token counters and
 * `cost_usd` accumulate in place via `INSERT … ON CONFLICT DO UPDATE`.
 *
 * `cost_usd` is the SDK's `total_cost_usd` at Anthropic API list prices.
 * It is informational only — operators on Pro/Max subscriptions, Bedrock,
 * Vertex, or negotiated rates will see numbers that don't match their bill.
 * The UI labels the column accordingly.
 *
 * Bundle naming convention: every SQL object owned is prefixed with
 * `token_usage`.
 *
 * Composed by `AgentDb`.
 */
import type Database from 'better-sqlite3';
import { z } from 'zod';

import { queryAll } from './db-query.js';

// --- Types ---

export type TokenPhase = 'main' | 'bootstrap' | 'cleanup';

export interface TokenUsageDelta {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export interface TokenUsageRecordInput {
  conversationId: string;
  channel: string;
  phase: TokenPhase;
  model: string;
  usage: TokenUsageDelta;
  costUsd: number;
  ts: Date;
}

export interface TokenUsageRow {
  date: string;
  conversation_id: string;
  channel: string;
  phase: TokenPhase;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  result_count: number;
  last_ts: string;
}

export interface TokenUsageDayRow {
  date: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  result_count: number;
}

export interface TokenUsageTotals {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cost_usd: number;
  result_count: number;
}

export interface TokenUsageSummary {
  totals: TokenUsageTotals;
  firstDate: string | null;
  lastDate: string | null;
}

// --- Schema ---

const TokenUsageRowSchema = z.object({
  date: z.string(),
  conversation_id: z.string(),
  channel: z.string(),
  phase: z.enum(['main', 'bootstrap', 'cleanup']),
  model: z.string(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  result_count: z.number().int().nonnegative(),
  last_ts: z.string(),
});

const TokenUsageDayRowSchema = z.object({
  date: z.string(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_creation_input_tokens: z.number().int().nonnegative(),
  cache_read_input_tokens: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  result_count: z.number().int().nonnegative(),
});

const TokenUsageTotalsRowSchema = z.object({
  input_tokens: z.number().int().nonnegative().nullable(),
  output_tokens: z.number().int().nonnegative().nullable(),
  cache_creation_input_tokens: z.number().int().nonnegative().nullable(),
  cache_read_input_tokens: z.number().int().nonnegative().nullable(),
  cost_usd: z.number().nonnegative().nullable(),
  result_count: z.number().int().nonnegative().nullable(),
  first_date: z.string().nullable(),
  last_date: z.string().nullable(),
});

// --- Schema install ---

/**
 * Idempotent install — safe to call on every DB-open.
 */
export function installTokenUsageSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      date TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      phase TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      result_count INTEGER NOT NULL DEFAULT 0,
      last_ts TEXT NOT NULL,
      PRIMARY KEY (date, conversation_id, channel, phase, model)
    );
    CREATE INDEX IF NOT EXISTS token_usage_date ON token_usage(date);
    CREATE INDEX IF NOT EXISTS token_usage_conv ON token_usage(conversation_id);
  `);
}

// --- Operations ---

export class TokenUsageStore {
  constructor(private db: Database.Database) {}

  record(input: TokenUsageRecordInput): void {
    const date = isoDate(input.ts);
    const ts = input.ts.toISOString();
    this.db.prepare(`
      INSERT INTO token_usage (
        date, conversation_id, channel, phase, model,
        input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens,
        cost_usd, result_count, last_ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT (date, conversation_id, channel, phase, model) DO UPDATE SET
        input_tokens                 = input_tokens + excluded.input_tokens,
        output_tokens                = output_tokens + excluded.output_tokens,
        cache_creation_input_tokens  = cache_creation_input_tokens + excluded.cache_creation_input_tokens,
        cache_read_input_tokens      = cache_read_input_tokens + excluded.cache_read_input_tokens,
        cost_usd                     = cost_usd + excluded.cost_usd,
        result_count                 = result_count + 1,
        last_ts                      = excluded.last_ts
    `).run(
      date, input.conversationId, input.channel, input.phase, input.model,
      input.usage.input, input.usage.output,
      input.usage.cacheCreation, input.usage.cacheRead,
      input.costUsd, ts,
    );
  }

  summary(opts: { sinceDays?: number } = {}): TokenUsageSummary {
    const since = opts.sinceDays ? isoDate(daysAgo(opts.sinceDays)) : null;
    const where = since ? 'WHERE date >= ?' : '';
    const params = since ? [since] : [];

    const stmt = this.db.prepare(`
      SELECT
        SUM(input_tokens)                AS input_tokens,
        SUM(output_tokens)               AS output_tokens,
        SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
        SUM(cache_read_input_tokens)     AS cache_read_input_tokens,
        SUM(cost_usd)                    AS cost_usd,
        SUM(result_count)                AS result_count,
        MIN(date)                        AS first_date,
        MAX(date)                        AS last_date
      FROM token_usage
      ${where}
    `);
    const row = TokenUsageTotalsRowSchema.parse(stmt.get(...params));
    return {
      totals: {
        input_tokens: row.input_tokens ?? 0,
        output_tokens: row.output_tokens ?? 0,
        cache_creation_input_tokens: row.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: row.cache_read_input_tokens ?? 0,
        cost_usd: row.cost_usd ?? 0,
        result_count: row.result_count ?? 0,
      },
      firstDate: row.first_date,
      lastDate: row.last_date,
    };
  }

  byDay(opts: { sinceDays?: number } = {}): TokenUsageDayRow[] {
    const since = opts.sinceDays ? isoDate(daysAgo(opts.sinceDays)) : null;
    const where = since ? 'WHERE date >= ?' : '';
    const params = since ? [since] : [];

    const stmt = this.db.prepare(`
      SELECT
        date,
        SUM(input_tokens)                AS input_tokens,
        SUM(output_tokens)               AS output_tokens,
        SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
        SUM(cache_read_input_tokens)     AS cache_read_input_tokens,
        SUM(cost_usd)                    AS cost_usd,
        SUM(result_count)                AS result_count
      FROM token_usage
      ${where}
      GROUP BY date
      ORDER BY date DESC
    `);
    return queryAll(stmt, TokenUsageDayRowSchema, ...params);
  }

  byConversation(opts: { sinceDays?: number; limit?: number } = {}): TokenUsageRow[] {
    const since = opts.sinceDays ? isoDate(daysAgo(opts.sinceDays)) : null;
    const limit = opts.limit ?? 100;
    const where = since ? 'WHERE date >= ?' : '';
    const params: (string | number)[] = since ? [since, limit] : [limit];

    const stmt = this.db.prepare(`
      SELECT
        MAX(date)                        AS date,
        conversation_id,
        channel,
        phase,
        model,
        SUM(input_tokens)                AS input_tokens,
        SUM(output_tokens)               AS output_tokens,
        SUM(cache_creation_input_tokens) AS cache_creation_input_tokens,
        SUM(cache_read_input_tokens)     AS cache_read_input_tokens,
        SUM(cost_usd)                    AS cost_usd,
        SUM(result_count)                AS result_count,
        MAX(last_ts)                     AS last_ts
      FROM token_usage
      ${where}
      GROUP BY conversation_id, channel, phase, model
      ORDER BY last_ts DESC
      LIMIT ?
    `);
    return queryAll(stmt, TokenUsageRowSchema, ...params);
  }
}

// --- Internal ---

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
