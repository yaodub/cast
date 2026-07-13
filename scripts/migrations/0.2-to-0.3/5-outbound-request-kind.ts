/**
 * 0.2 → 0.3 migration, step 5 — record the request kind on outbound requests.
 *
 * The reply rail moved from a standing-edge re-check to a capability model:
 * the open `outbound_requests` row is the round-trip authorization
 * the query was emitted under, and the answer redeems it. The row now records
 * `kind` ('query' | 'request') so the reply handler can honor the r-bit promise
 * (a fire-and-forget `request` redeems only a bounce, never an answer) without
 * re-deriving intent from the live ACL bit.
 *
 * Adding the column is a plain additive ALTER (NOT NULL DEFAULT 'query'), so no
 * table rebuild is needed. Existing in-flight rows default to 'query' — the only
 * kind whose answer rail matters, and the safe choice (an in-flight request that
 * was actually fire-and-forget gets no answer anyway). Fresh agent.db files get
 * the column directly from `agent-db.ts`'s CREATE TABLE; this is only for
 * *existing* databases. The runtime carries no parse-time default, so an
 * un-migrated DB fails to read outbound requests — run this before deploying 0.3.
 *
 * Run with the server STOPPED (the script opens each agent.db read-write).
 *
 * Usage (dry-run lists the changes; `--apply` performs them, backing up first):
 *   pnpm exec tsx scripts/migrations/0.2-to-0.3/5-outbound-request-kind.ts <CAST_AGENTS_DIR> [--apply]
 *   (or CAST_AGENTS_DIR in the environment / repo-root .env)
 *
 * Backup: in `--apply` mode each modified agent.db is copied to
 * `agent.db.pre-outbound-kind` first. Idempotent — a DB already carrying the
 * column is skipped; a DB with no `outbound_requests` table is left untouched
 * (the runtime creates it fresh with the column on next open).
 */
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// better-sqlite3 is a packages/cast dependency (pnpm, not hoisted to the repo root).
const require = createRequire(new URL('../../../packages/cast/package.json', import.meta.url));
interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] }
interface SqliteDb { prepare(sql: string): Stmt; exec(sql: string): void; close(): void }
const Database = require('better-sqlite3') as { new (path: string): SqliteDb };

function dotEnv(): Record<string, string> {
  try {
    const dotenv = require('dotenv') as { parse(src: string): Record<string, string> };
    return dotenv.parse(readFileSync(join(process.cwd(), '.env'), 'utf8'));
  } catch {
    return {};
  }
}

const positional = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
const root = positional ?? process.env.CAST_AGENTS_DIR ?? dotEnv().CAST_AGENTS_DIR;
const apply = process.argv.includes('--apply');

if (!root) {
  console.error('usage: 5-outbound-request-kind.ts [agents-dir] [--apply]   (or CAST_AGENTS_DIR in the environment or repo-root .env)');
  process.exit(1);
}

const agents = readdirSync(root).filter((name) => {
  if (/backup|pre-migrate|pre-allowed|pre-approvals|pre-outbound/.test(name)) return false;
  try {
    return statSync(join(root, name)).isDirectory();
  } catch {
    return false;
  }
});

let changedDbs = 0;

console.log(`\n${apply ? 'APPLY' : 'DRY-RUN'} — ${root}\n`);

for (const name of agents) {
  const dbPath = join(root, name, 'state', 'agent.db');
  if (!existsSync(dbPath)) continue;

  const db = new Database(dbPath);
  try {
    const hasTable = !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='outbound_requests'",
    ).get();
    if (!hasTable) {
      console.log(`  ${name}: SKIP — no outbound_requests table (runtime creates it fresh)`);
      continue;
    }

    const info = db.prepare('PRAGMA table_info(outbound_requests)').all() as { name: string }[];
    if (info.some((c) => c.name === 'kind')) continue;

    changedDbs++;
    console.log(`  ${name}: +kind`);

    if (apply) {
      copyFileSync(dbPath, `${dbPath}.pre-outbound-kind`);
      db.exec("ALTER TABLE outbound_requests ADD COLUMN kind TEXT NOT NULL DEFAULT 'query'");
    }
  } finally {
    db.close();
  }
}

console.log(`\n${apply ? 'APPLIED' : 'WOULD CHANGE'}: ${changedDbs} agent.db file(s).`);
if (!apply && changedDbs > 0) console.log('Re-run with --apply to write.');
