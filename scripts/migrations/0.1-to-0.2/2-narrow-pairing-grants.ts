/**
 * 0.1 → 0.2 migration, step 2 — narrow wildcard pairing grants.
 *
 * 0.2 ignores the `*` channel wildcard for membership: co-participant visibility
 * and cross-conversation push read concrete per-channel placement only, so a
 * wholesale `{ "*": "io" }` pairing grant authorizes conversation but places the
 * user in no channel. This sweep replaces each wildcard grant with concrete
 * per-channel placement. Each user is granted `io` on exactly the channels they
 * have actually been active on (from `state/agent.db` `message_log`), always
 * including `default` as a floor. Membership narrows to real usage without
 * cutting off any active user — a user who messaged an agent on its `email`
 * channel keeps `email` because that activity shows up in `message_log`.
 *
 * Usage (dry-run prints the diff; `--apply` writes, backing up first):
 *   pnpm exec tsx scripts/migrations/0.1-to-0.2/2-narrow-pairing-grants.ts <CAST_AGENTS_DIR> [--apply]
 *
 * Backup: in `--apply` mode each rewritten `paired-users.json` is copied to
 * `paired-users.json.pre-narrow-grants` first — the only file this sweep
 * modifies, so that copy is the exact restore point.
 */
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// better-sqlite3 is a packages/cast dependency (pnpm, not hoisted to the repo root).
// Resolve the module from packages/cast and type it minimally — a one-shot migration
// run via tsx, no type-check.
const require = createRequire(new URL('../../../packages/cast/package.json', import.meta.url));
interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] }
interface SqliteDb { prepare(sql: string): Stmt; close(): void }
const Database = require('better-sqlite3') as { new (path: string, opts?: { readonly?: boolean }): SqliteDb };

/** Write tmp + rename so a concurrent reader (a live server) never sees a
 *  partial file — mirrors the codebase's `writeAtomic` discipline. */
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

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
const root = positional ?? process.env.CAST_AGENTS_DIR ?? dotEnv().CAST_AGENTS_DIR;
const apply = process.argv.includes('--apply');

if (!root) {
  console.error('usage: 2-narrow-pairing-grants.ts [agents-dir] [--apply]   (or CAST_AGENTS_DIR in the environment or repo-root .env)');
  process.exit(1);
}

type ChannelBits = Record<string, string>;
type PairedUsers = Record<string, ChannelBits>;

/** The message-log table was renamed `messages` → `message_log`; older DBs still have the old name. */
function messageLogTable(db: SqliteDb): string | null {
  const has = (name: string) =>
    !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  if (has('message_log')) return 'message_log';
  if (has('messages')) return 'messages';
  return null;
}

/** Distinct channels a user identity has message_log activity on. Excludes
 *  infra (`__*`) channels — those are code-declared, never user grants. */
function observedChannels(agentDir: string, identity: string): string[] {
  const dbPath = join(agentDir, 'state', 'agent.db');
  if (!existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    const table = messageLogTable(db);
    if (!table) return [];
    const rows = db.prepare(
      `SELECT DISTINCT channel FROM ${table} WHERE participant = ? OR participant LIKE ?`,
    ).all(identity, `${identity}/%`) as Array<{ channel: string }>;
    return rows.map((r) => r.channel).filter(Boolean).filter((c) => !c.startsWith('__'));
  } finally {
    db.close();
  }
}

const agents = readdirSync(root).filter((name) => {
  if (/backup|pre-migrate|pre-narrow/.test(name)) return false;
  try {
    return statSync(join(root, name)).isDirectory();
  } catch {
    return false;
  }
});

let changedFiles = 0;
const multiChannel: string[] = [];

console.log(`\n${apply ? 'APPLY' : 'DRY-RUN'} — ${root}\n`);

for (const name of agents) {
  const agentDir = join(root, name);
  const puPath = join(agentDir, 'state', 'paired-users.json');
  if (!existsSync(puPath)) continue;

  const before = JSON.parse(readFileSync(puPath, 'utf-8')) as PairedUsers;
  const after: PairedUsers = {};
  let changed = false;

  for (const [identity, channels] of Object.entries(before)) {
    if (!('*' in channels)) {
      after[identity] = channels;
      continue;
    }
    const bits = channels['*'];
    const granted = Array.from(new Set(['default', ...observedChannels(agentDir, identity)]));

    const rewritten: ChannelBits = {};
    for (const [ch, b] of Object.entries(channels)) if (ch !== '*') rewritten[ch] = b;
    for (const ch of granted) if (!(ch in rewritten)) rewritten[ch] = bits;

    after[identity] = rewritten;
    changed = true;

    const extra = granted.filter((c) => c !== 'default');
    if (extra.length) multiChannel.push(`${name} / ${identity}  →  ${granted.join(', ')}`);
    const rendered = Object.entries(rewritten).map(([c, b]) => `"${c}":"${b}"`).join(', ');
    console.log(`  ${name} / ${identity}: {"*":"${bits}"}  →  {${rendered}}${extra.length ? `   [+${extra.join(', ')}]` : ''}`);
  }

  if (changed) {
    changedFiles++;
    if (apply) {
      copyFileSync(puPath, `${puPath}.pre-narrow-grants`);
      writeAtomic(puPath, JSON.stringify(after, null, 2) + '\n');
    }
  }
}

console.log(`\n${apply ? 'APPLIED' : 'WOULD CHANGE'}: ${changedFiles} paired-users.json file(s).`);
if (multiChannel.length) {
  console.log(`\nMulti-channel users (granted >1 channel from observed activity — review for pruning):`);
  for (const u of multiChannel) console.log(`  - ${u}`);
} else {
  console.log('\nNo multi-channel users — every paired user was active only on `default`.');
}
