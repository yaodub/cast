/**
 * 0.1 → 0.2 migration, step 3 — add `failed_at` to gateway packets.
 *
 * 0.2's outbound delivery worker retries failed sends in-process and expires
 * packets that stay undeliverable past their TTL by marking them failed —
 * a terminal state distinct from delivered. That verdict lives in a new
 * `failed_at` column on `gateway.db`'s `packets` table, and the pending-packet
 * partial index keys on both columns. `CREATE TABLE IF NOT EXISTS` cannot add
 * a column to a live table, so DBs created on 0.1.x need this sweep; without
 * it the 0.2 server's pending-packet queries fail loudly on the missing column.
 *
 * Usage (dry-run prints the plan; `--apply` writes):
 *   pnpm exec tsx scripts/migrations/0.1-to-0.2/3-packets-failed-at.ts [config-dir] [--apply]
 *
 * The change is additive (one nullable column + an index rebuild) — no rows
 * are modified, so there is no backup step. Undelivered packets older than the
 * 0.2 delivery TTL will be marked failed by the worker's first pass after the
 * server starts; the dry run reports how many rows that will affect.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// better-sqlite3 is a packages/cast dependency (pnpm, not hoisted to the repo root).
// Resolve the module from packages/cast and type it minimally — a one-shot migration
// run via tsx, no type-check.
const require = createRequire(new URL('../../../packages/cast/package.json', import.meta.url));
interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] }
interface SqliteDb { prepare(sql: string): Stmt; exec(sql: string): void; close(): void }
const Database = require('better-sqlite3') as { new (path: string, opts?: { readonly?: boolean }): SqliteDb };

/** Mirror env.ts: the server reads CAST_* from the repo-root .env — so does this script. */
function dotEnv(): Record<string, string> {
  try {
    const dotenv = require('dotenv') as { parse(src: string): Record<string, string> };
    return dotenv.parse(readFileSync(join(process.cwd(), '.env'), 'utf8'));
  } catch {
    return {};
  }
}

const positional = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
const configDir = positional ?? process.env.CAST_CONFIG_DIR ?? dotEnv().CAST_CONFIG_DIR;
const apply = process.argv.includes('--apply');

if (!configDir) {
  console.error('usage: 3-packets-failed-at.ts [config-dir] [--apply]   (or CAST_CONFIG_DIR in the environment or repo-root .env)');
  process.exit(1);
}

const dbPath = join(configDir, 'gateway.db');
if (!existsSync(dbPath)) {
  console.log(`No gateway.db at ${dbPath} — nothing to migrate (a fresh 0.2 install creates the column itself).`);
  process.exit(0);
}

console.log(`\n${apply ? 'APPLY' : 'DRY-RUN'} — ${dbPath}\n`);

const db = new Database(dbPath, { readonly: !apply });
try {
  const columns = db.prepare(`PRAGMA table_info(packets)`).all() as Array<{ name: string }>;
  const hasColumn = columns.some((c) => c.name === 'failed_at');

  const pendingRow = db.prepare(
    `SELECT COUNT(*) AS n FROM packets WHERE direction = 'outbound' AND delivered_at IS NULL`,
  ).get() as { n: number };
  console.log(`  Pending (undelivered) outbound packets: ${pendingRow.n}`);
  console.log(`  (Those older than the delivery TTL will be marked failed by the worker's first pass.)\n`);

  if (hasColumn) {
    console.log('  `failed_at` already present — nothing to do.');
  } else if (apply) {
    db.exec(`
      ALTER TABLE packets ADD COLUMN failed_at TEXT;
      DROP INDEX IF EXISTS idx_packets_undelivered;
      CREATE INDEX idx_packets_undelivered ON packets(delivered_at) WHERE delivered_at IS NULL AND failed_at IS NULL;
    `);
    console.log('  Added `failed_at` and rebuilt idx_packets_undelivered.');
  } else {
    console.log('  WOULD add `failed_at` and rebuild idx_packets_undelivered.');
  }
} finally {
  db.close();
}

console.log(`\n${apply ? 'APPLIED' : 'DRY-RUN COMPLETE'}.`);
