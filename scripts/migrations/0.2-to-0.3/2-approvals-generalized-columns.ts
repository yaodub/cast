/**
 * 0.2 → 0.3 migration, step 2 — generalize the approvals table.
 *
 * The access-model work reshaped the per-agent `approvals` table:
 *   - added type/controller/tier/principal/destination/provenance/payload
 *     (the approval-model substrate), and
 *   - relaxed `tool`/`args` to nullable, so a tool-less `acl-edge` approval
 *     (a reactive ACL grant) is representable.
 *
 * Relaxing NOT NULL is not an ALTER in SQLite, so this sweep rebuilds the table
 * to the 0.3 shape (CREATE new → copy → DROP → RENAME), preserving every row.
 * Fresh agent.db files get the 0.3 shape directly from `approvals-store.ts`'s
 * CREATE TABLE; this is only for *existing* databases. The runtime carries no
 * parse-time defaults, so an un-migrated DB would fail to read approvals — run
 * this before deploying 0.3.
 *
 * Run with the server STOPPED (the script opens each agent.db read-write).
 *
 * Usage (dry-run lists the changes; `--apply` performs them, backing up first):
 *   pnpm exec tsx scripts/migrations/0.2-to-0.3/2-approvals-generalized-columns.ts <CAST_AGENTS_DIR> [--apply]
 *   (or CAST_AGENTS_DIR in the environment / repo-root .env)
 *
 * Backup: in `--apply` mode each modified agent.db is copied to
 * `agent.db.pre-approvals-columns` first. Idempotent — a DB already at the 0.3
 * shape is skipped; a DB with no `approvals` table is left untouched (the
 * runtime creates it fresh with all columns on next open).
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
  console.error('usage: 2-approvals-generalized-columns.ts [agents-dir] [--apply]   (or CAST_AGENTS_DIR in the environment or repo-root .env)');
  process.exit(1);
}

// The 0.3 target table — mirrors the CREATE TABLE in approvals-store.ts exactly
// (tool/args nullable, the seven generalized columns present).
const TARGET_DDL = `
  CREATE TABLE approvals_new (
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
`;

// Column names in the target, in order. The rebuild copies the intersection of
// these with the columns the existing table actually has, so it works whether
// the source is a raw 0.2 table (13 columns) or a partially-migrated one — any
// columns the target adds take their DEFAULT / NULL.
const TARGET_COLUMNS = [
  'id', 'tool', 'args', 'summary', 'details', 'participant', 'channel', 'conversation_key',
  'status', 'created_at', 'expires_at', 'resolved_at', 'reason', 'type', 'controller', 'tier',
  'principal', 'destination', 'provenance', 'payload',
];

const agents = readdirSync(root).filter((name) => {
  if (/backup|pre-migrate|pre-allowed|pre-approvals/.test(name)) return false;
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
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='approvals'",
    ).get();
    if (!hasTable) {
      console.log(`  ${name}: SKIP — no approvals table (runtime creates it fresh)`);
      continue;
    }

    const info = db.prepare('PRAGMA table_info(approvals)').all() as { name: string; notnull: number }[];
    const present = new Set(info.map((c) => c.name));
    const toolNotNull = info.find((c) => c.name === 'tool')?.notnull === 1;
    const argsNotNull = info.find((c) => c.name === 'args')?.notnull === 1;
    const missing = TARGET_COLUMNS.filter((c) => !present.has(c));
    const atTarget = missing.length === 0 && !toolNotNull && !argsNotNull;
    if (atTarget) continue;

    changedDbs++;
    const why = [
      missing.length ? `+${missing.join(', ')}` : null,
      toolNotNull || argsNotNull ? 'relax tool/args NOT NULL' : null,
    ].filter(Boolean).join('; ');
    console.log(`  ${name}: rebuild (${why})`);

    if (apply) {
      copyFileSync(dbPath, `${dbPath}.pre-approvals-columns`);
      const copyCols = TARGET_COLUMNS.filter((c) => present.has(c)).join(', ');
      db.exec(`
        BEGIN;
        ${TARGET_DDL}
        INSERT INTO approvals_new (${copyCols}) SELECT ${copyCols} FROM approvals;
        DROP TABLE approvals;
        ALTER TABLE approvals_new RENAME TO approvals;
        COMMIT;
      `);
    }
  } finally {
    db.close();
  }
}

console.log(`\n${apply ? 'APPLIED' : 'WOULD CHANGE'}: ${changedDbs} agent.db file(s).`);
if (!apply && changedDbs > 0) console.log('Re-run with --apply to write.');
