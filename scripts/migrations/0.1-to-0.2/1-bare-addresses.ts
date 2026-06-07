/**
 * 0.1 → 0.2 migration, step 1 — bare participant addresses.
 *
 * Re-grains every persisted address to its bare participant form, and conversation
 * keys to match. Two relabels, both 1:1 (no merge):
 *   - User:     drop the handle SUFFIX   `u:guid@iss/tg:123`   → `u:guid@iss`
 *   - Operator: drop the `local/` PREFIX  `local/cli:alice`     → `cli:alice`
 * Agent `a:` addresses and any already-bare address pass through unchanged.
 *
 * The operator surfaces (`cli:…`, `admin:…`, `console:…`) become first-class bare
 * participants — distinct cells, no merge — which is why this stays a relabel
 * (the `local` identity demotes to a trust tier in 0.2).
 *
 * Properties:
 *   - DRY-RUN BY DEFAULT. Pass --apply to mutate. Pass --backup to snapshot first.
 *   - Idempotent. Re-running on a bare address is a no-op.
 *   - Collision-free by construction (user side is a confirmed 1:1 bijection; operator
 *     side maps each distinct `local/X` to a distinct `X`). A target that unexpectedly
 *     already exists is reported and SKIPPED, never clobbered.
 *
 * The bare/split/path-encode helpers are reimplemented here (not imported) so the
 * script stays a standalone tsx run with no build dependency. They MUST stay
 * byte-identical to:
 *   - identity/handle split  ≡ extractIdentity           packages/cast/src/auth/address.ts
 *   - key separator          ≡ serializeConversationKey  packages/cast/src/conversations/resolve-key.ts
 *   - encodePath             ≡ conversationKeyToPath     packages/cast/src/lib/utils.ts
 *
 * Run:  pnpm exec tsx scripts/migrations/0.1-to-0.2/1-bare-addresses.ts [--apply] [--backup] [--agents-dir <p>] [--config-dir <p>]
 */

import { createRequire } from 'node:module';
import { readdirSync, readFileSync, writeFileSync, existsSync, renameSync, cpSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

// better-sqlite3 is a packages/cast dependency (pnpm, not hoisted to the repo root).
// Resolve the module from packages/cast and type it minimally — a one-shot migration
// run via tsx, no type-check.
const require = createRequire(new URL('../../../packages/cast/package.json', import.meta.url));
interface Stmt { get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown }
interface SqliteDb { prepare(sql: string): Stmt; transaction<T extends (...a: unknown[]) => unknown>(fn: T): T; close(): void }
const Database = require('better-sqlite3') as { new (path: string): SqliteDb };

// ── pure helpers (mirror the authoritative sources above) ──────────────────────

/**
 * Bare participant form.
 *   `u:guid@iss/tg:123` → `u:guid@iss`   (user: drop handle suffix)
 *   `local/cli:alice`   → `cli:alice`    (operator: drop `local/` prefix)
 *   `a:guid@iss`, `cli:alice`, …         (no '/' → already bare, unchanged)
 * Both transforms are structural and 1:1; nothing merges.
 */
function bareParticipant(addr: string): string {
  const i = addr.indexOf('/');
  if (i === -1) return addr;
  if (addr.startsWith('local/')) return addr.slice(i + 1); // operator surface
  if (addr.startsWith('u:')) return addr.slice(0, i);      // user identity
  return addr;                                              // unknown compound — leave it
}

/** Re-grain the participant segment (index 1) of a `|`-joined key; channel + qualifier untouched. */
function stripKey(key: string): string {
  const parts = key.split('|');
  if (parts.length < 2) return key;
  parts[1] = bareParticipant(parts[1]!);
  return parts.join('|');
}

const PATH_RESERVED_RE = /[%/:@~|]/g;
/** ≡ conversationKeyToPath (lib/utils.ts). */
function encodePath(key: string): string {
  return key.replace(PATH_RESERVED_RE, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}
/** Inverse of encodePath. The encoder only emits %25 %2F %3A %40 %7E %7C, so decodeURIComponent is exact. */
function decodePath(name: string): string {
  return decodeURIComponent(name);
}

// ── dry-run chokepoint — every mutation is described here; only --apply executes ─

interface Ctx { apply: boolean; counts: Record<string, number> }

function note(ctx: Ctx, kind: string, detail: string) {
  ctx.counts[kind] = (ctx.counts[kind] ?? 0) + 1;
  console.log(`  ${ctx.apply ? 'APPLY' : 'PLAN '}  ${kind.padEnd(22)} ${detail}`);
}

// ── per-store relabel ──────────────────────────────────────────────────────────

const ConversationLine = z.object({
  conversationKey: z.string(),
  participant: z.string(),
}).loose(); // preserve unknown fields verbatim

function relabelConversationsJsonl(ctx: Ctx, file: string) {
  if (!existsSync(file)) return;
  const lines = readFileSync(file, 'utf8').split('\n');
  let changed = false;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    const rec = ConversationLine.parse(JSON.parse(line));
    const nk = stripKey(rec.conversationKey);
    const np = bareParticipant(rec.participant);
    if (nk === rec.conversationKey && np === rec.participant) return line;
    changed = true;
    note(ctx, 'conversations.jsonl', `${rec.conversationKey} → ${nk}`);
    return JSON.stringify({ ...rec, conversationKey: nk, participant: np });
  });
  if (changed && ctx.apply) writeFileSync(file, out.join('\n'));
}

/** Tables in agent.db and their address (bare-participant) / key (key-strip) columns. */
const AGENT_DB_TABLES: Array<{ name: string; addrCols: string[]; keyCols: string[] }> = [
  { name: 'participants',      addrCols: ['address'],                          keyCols: [] },
  { name: 'outbound_requests', addrCols: ['participant'],                      keyCols: [] },
  { name: 'outbound_pushes',   addrCols: ['participant'],                      keyCols: [] }, // may be absent on old DBs
  { name: 'inbound_requests',  addrCols: ['participant', 'return_to_participant'], keyCols: [] },
  { name: 'approvals',         addrCols: ['participant'],                      keyCols: ['conversation_key'] },
  { name: 'events',            addrCols: [],                                   keyCols: ['conversation_key'] },
  // NOTE: `token_usage` also carries a `channel|participant` key (`conversation_id`) but rides a
  // dedicated walker (`relabelTokenUsage`), not this generic path — its key is part of a composite PK
  // over additive counters, so a collision must MERGE (sum), not naively UPDATE (which would throw).
];

function tableExists(db: SqliteDb, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name);
}

/** The message-log table was renamed `messages` → `message_log`; older DBs still have the old name. */
function messageLogTable(db: SqliteDb): string | null {
  if (tableExists(db, 'message_log')) return 'message_log';
  if (tableExists(db, 'messages')) return 'messages';
  return null;
}

function relabelAgentDb(ctx: Ctx, file: string) {
  if (!existsSync(file)) return;
  const db = new Database(file);
  try {
    const specs = [...AGENT_DB_TABLES];
    const mlt = messageLogTable(db);
    if (mlt) specs.push({ name: mlt, addrCols: ['participant', 'sender'], keyCols: ['conversation_key'] });

    // One pass enumerates every candidate and notes it; under --apply it also writes.
    // relabelSqlTable gates the UPDATE on ctx.apply, so dry-run is a read-only walk.
    const pass = () => {
      for (const { name, addrCols, keyCols } of specs) {
        if (!tableExists(db, name)) continue;
        relabelSqlTable(ctx, db, file, name, addrCols, keyCols);
      }
      relabelTokenUsage(ctx, db, file);
    };
    if (ctx.apply) db.transaction(pass)(); else pass();
  } finally {
    db.close();
  }
}

/**
 * SIDE EFFECT (under --apply): UPDATEs rows in `table` whose address/key columns carry a '/'.
 * Reads every candidate row (column LIKE '%/%'), recomputes via the pure helpers, writes back by rowid.
 * `participants.address` is a PRIMARY KEY: a bare value colliding with an existing row would be an
 * unexpected collision (the relabel is 1:1) — it is reported and skipped, never clobbered.
 */
function relabelSqlTable(
  ctx: Ctx, db: SqliteDb, file: string, table: string, addrCols: string[], keyCols: string[],
) {
  const cols = [...addrCols, ...keyCols];
  const filter = cols.map((c) => `${c} LIKE '%/%'`).join(' OR ');
  const rows = db.prepare(`SELECT rowid AS _rid, ${cols.join(', ')} FROM ${table} WHERE ${filter}`).all() as Array<Record<string, unknown>>;
  const isPk = table === 'participants';
  const existsAddr = isPk ? db.prepare(`SELECT 1 FROM participants WHERE address = ?`) : null;

  for (const row of rows) {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const c of addrCols) {
      const v = row[c];
      if (typeof v !== 'string') continue;
      const nv = bareParticipant(v);
      if (nv === v) continue;
      if (isPk && existsAddr && existsAddr.get(nv)) {
        note(ctx, 'collision-skip', `${table}.${c} ${v} → ${nv} already exists (unexpected — relabel is 1:1)`);
        continue;
      }
      sets.push(`${c} = ?`); vals.push(nv);
    }
    for (const c of keyCols) {
      const v = row[c];
      if (typeof v !== 'string') continue;
      const nv = stripKey(v);
      if (nv !== v) { sets.push(`${c} = ?`); vals.push(nv); }
    }
    if (!sets.length) continue;
    note(ctx, `${table} (${file.split('/').slice(-3, -2)[0]})`, sets.join(', '));
    if (ctx.apply) {
      db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE rowid = ?`).run(...vals, row._rid);
    }
  }
}

/**
 * SIDE EFFECT (under --apply): re-grains `token_usage.conversation_id` (a
 * `channel|participant` key). Unlike the other key columns, `conversation_id`
 * is part of the composite PK `(date, conversation_id, channel, phase, model)`
 * over ADDITIVE counter rows — so a stripped key that collides with an existing
 * bare row must MERGE (sum each counter, keep the latest `last_ts`) and drop the
 * compound row, mirroring the store's own `ON CONFLICT … DO UPDATE SET x = x +
 * excluded.x` (token-usage-store.ts). A naive UPDATE (the generic path) would
 * throw a UNIQUE violation on that collision. No collision → a plain rewrite.
 * Two compound rows that strip to the same key (e.g. a user's tg + web rows)
 * converge: the first rewrites, the second finds it and merges (under --apply,
 * the live transaction makes the intermediate row visible to `findTarget`).
 */
const TOKEN_SUM_COLS = [
  'input_tokens', 'output_tokens', 'cache_creation_input_tokens',
  'cache_read_input_tokens', 'cost_usd', 'result_count',
];
function relabelTokenUsage(ctx: Ctx, db: SqliteDb, file: string) {
  if (!tableExists(db, 'token_usage')) return;
  const agent = file.split('/').slice(-3, -2)[0];
  const rows = db.prepare(
    `SELECT rowid AS _rid, date, conversation_id, channel, phase, model, ${TOKEN_SUM_COLS.join(', ')}, last_ts ` +
    `FROM token_usage WHERE conversation_id LIKE '%/%'`,
  ).all() as Array<Record<string, unknown>>;
  const findTarget = db.prepare(
    `SELECT rowid AS _rid FROM token_usage WHERE date=? AND conversation_id=? AND channel=? AND phase=? AND model=?`,
  );
  for (const r of rows) {
    const oldKey = r.conversation_id as string;
    const nk = stripKey(oldKey);
    if (nk === oldKey) continue;
    const hit = findTarget.get(r.date, nk, r.channel, r.phase, r.model) as { _rid: number } | undefined;
    if (hit) {
      note(ctx, `token_usage (${agent})`, `merge ${oldKey} → ${nk} (sum counters, drop compound row)`);
      if (ctx.apply) {
        db.prepare(
          `UPDATE token_usage SET ${TOKEN_SUM_COLS.map((c) => `${c} = ${c} + ?`).join(', ')}, ` +
          `last_ts = MAX(last_ts, ?) WHERE rowid = ?`,
        ).run(...TOKEN_SUM_COLS.map((c) => r[c]), r.last_ts, hit._rid);
        db.prepare(`DELETE FROM token_usage WHERE rowid = ?`).run(r._rid);
      }
    } else {
      note(ctx, `token_usage (${agent})`, `conversation_id = ${nk}`);
      if (ctx.apply) db.prepare(`UPDATE token_usage SET conversation_id = ? WHERE rowid = ?`).run(nk, r._rid);
    }
  }
}

const TasksSnapshot = z.object({
  tasks: z.array(z.object({ target_participant: z.string().optional() }).loose()).optional(),
  runLogs: z.array(z.object({ target_participant: z.string().optional() }).loose()).optional(),
}).loose();

function relabelTasksJson(ctx: Ctx, file: string) {
  if (!existsSync(file)) return;
  const snap = TasksSnapshot.parse(JSON.parse(readFileSync(file, 'utf8')));
  let changed = false;
  const fix = <T extends { target_participant?: string }>(arr: T[] | undefined) =>
    (arr ?? []).map((t) => {
      if (!t.target_participant) return t;
      const nv = bareParticipant(t.target_participant);
      if (nv === t.target_participant) return t;
      changed = true;
      note(ctx, 'tasks.json', `${t.target_participant} → ${nv}`);
      return { ...t, target_participant: nv };
    });
  const next = { ...snap, tasks: fix(snap.tasks), runLogs: fix(snap.runLogs) };
  if (changed && ctx.apply) writeFileSync(file, JSON.stringify(next, null, 2));
}

/**
 * Residual sweep: pre-0.2 rosters carry a stale `handles[]` per identity — a
 * per-agent copy of the IdP map. The roster code is already transport-blind
 * (`{name, type?}`); this strips the dead value-noise so no wire survives on
 * disk. Keys are already bare; values lose `handles` only.
 */
function scrubRosterHandles(ctx: Ctx, file: string) {
  if (!existsSync(file)) return;
  const roster = z.record(z.string(), z.object({}).loose()).parse(JSON.parse(readFileSync(file, 'utf8')));
  let changed = false;
  const next: Record<string, Record<string, unknown>> = {};
  for (const [id, entry] of Object.entries(roster)) {
    if ('handles' in entry) {
      const { handles: _dropped, ...rest } = entry;
      next[id] = rest;
      changed = true;
      note(ctx, 'identity-roster.json', `${id}: dropped handles[]`);
    } else {
      next[id] = entry;
    }
  }
  if (changed && ctx.apply) writeFileSync(file, JSON.stringify(next, null, 2));
}

/**
 * SIDE EFFECT (under --apply): retires the `local` *identity* from
 * `config/acl.json`. `owner: "local"` (the pre-0.2 operator-owns default)
 * becomes the inert label `"operator"`; the redundant `peers["local"]` operator
 * self-grant is dropped (the tier already grants `ALL_BITS`, so it never did
 * anything). Any non-`local` owner (e.g. a configured `u:` co-owner) and all
 * other peer keys pass through untouched. Audit changelogs keep their historical
 * `local` actor — those are write-once records, not live keys.
 */
const AclSnapshot = z.object({
  owner: z.string().optional(),
  peers: z.record(z.string(), z.unknown()).optional(),
}).loose();
function relabelAclJson(ctx: Ctx, file: string) {
  if (!existsSync(file)) return;
  const agent = file.split('/').slice(-3, -2)[0];
  const acl = AclSnapshot.parse(JSON.parse(readFileSync(file, 'utf8')));
  const next: Record<string, unknown> = { ...acl };
  let changed = false;
  if (acl.owner === 'local') {
    next.owner = 'operator';
    changed = true;
    note(ctx, `acl.json (${agent})`, 'owner: local → operator');
  }
  if (acl.peers && Object.prototype.hasOwnProperty.call(acl.peers, 'local')) {
    const peers = { ...acl.peers };
    delete peers.local;
    next.peers = peers;
    changed = true;
    note(ctx, `acl.json (${agent})`, 'drop peers["local"] (redundant operator self-grant)');
  }
  if (changed && ctx.apply) writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
}

const PacketPayload = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  target: z.string().optional(),
}).loose();

function relabelGatewayDb(ctx: Ctx, file: string) {
  if (!existsSync(file)) return;
  const db = new Database(file);
  try {
    const run = () => {
      const rows = db.prepare(
        `SELECT id, from_addr, to_addr, conversation_key, payload FROM packets
         WHERE from_addr LIKE '%/%' OR to_addr LIKE '%/%' OR conversation_key LIKE '%/%' OR payload LIKE '%/%'`,
      ).all() as Array<{ id: number; from_addr: string; to_addr: string; conversation_key: string | null; payload: string }>;
      for (const r of rows) {
        const from = bareParticipant(r.from_addr);
        const to = bareParticipant(r.to_addr);
        const ck = r.conversation_key ? stripKey(r.conversation_key) : r.conversation_key;
        let payload = r.payload;
        try {
          const p = PacketPayload.parse(JSON.parse(r.payload));
          const np = { ...p };
          for (const k of ['from', 'to', 'target'] as const) {
            const v = p[k];
            if (typeof v === 'string') np[k] = bareParticipant(v);
          }
          payload = JSON.stringify(np);
        } catch { /* non-JSON payload — leave as-is */ }
        if (from === r.from_addr && to === r.to_addr && ck === r.conversation_key && payload === r.payload) continue;
        note(ctx, 'gateway.db packets', `#${r.id} ${r.conversation_key ?? ''} → ${ck ?? ''}`);
        if (ctx.apply) {
          db.prepare(`UPDATE packets SET from_addr=?, to_addr=?, conversation_key=?, payload=? WHERE id=?`)
            .run(from, to, ck, payload, r.id);
        }
      }
    };
    if (ctx.apply) db.transaction(run)(); else run();
  } finally {
    db.close();
  }
}

/**
 * Rename session/staging dirs whose name encodes a key with a compound participant.
 * dir name = encodePath(key); compute encodePath(stripKey(decode(name))). The relabel is 1:1,
 * so a pre-existing target is unexpected — reported and SKIPPED, never clobbered.
 */
function renameSessionDirs(ctx: Ctx, root: string) {
  for (const sub of ['sessions', 'staging']) {
    const dir = join(root, sub);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!statSync(join(dir, name)).isDirectory()) continue;
      const key = decodePath(name);
      const nk = stripKey(key);
      if (nk === key) continue;
      const newName = encodePath(nk);
      if (existsSync(join(dir, newName))) {
        note(ctx, 'collision-skip', `${sub}/${name} → ${newName} target exists (unexpected)`);
        continue;
      }
      note(ctx, `${sub}/ rename`, `${name} → ${newName}`);
      if (ctx.apply) renameSync(join(dir, name), join(dir, newName));
    }
  }
}

// ── driver ───────────────────────────────────────────────────────────────────

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
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

function main() {
  const apply = process.argv.includes('--apply');
  const wantBackup = process.argv.includes('--backup');
  const fileEnv = dotEnv();
  const agentsDir = arg('--agents-dir', process.env.CAST_AGENTS_DIR ?? fileEnv.CAST_AGENTS_DIR);
  const configDir = arg('--config-dir', process.env.CAST_CONFIG_DIR ?? fileEnv.CAST_CONFIG_DIR);
  if (!agentsDir || !configDir) {
    console.error('Need --agents-dir and --config-dir (or CAST_AGENTS_DIR / CAST_CONFIG_DIR in the environment or repo-root .env).');
    process.exit(1);
  }

  const ctx: Ctx = { apply, counts: {} };
  console.log(`\n0.1 → 0.2 bare-address migration — ${apply ? 'APPLY (mutating)' : 'DRY RUN (no writes)'}`);
  console.log(`  agents: ${agentsDir}\n  config: ${configDir}\n`);

  if (apply && wantBackup) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = join(configDir, `..`, `cast-migration-backup-${stamp}`);
    console.log(`  backup → ${dest}`);
    cpSync(agentsDir, join(dest, 'agents'), { recursive: true });
    cpSync(configDir, join(dest, 'config'), { recursive: true });
  } else if (apply) {
    console.log('  WARNING: --apply without --backup. Snapshot manually if this data matters.\n');
  }

  for (const folder of readdirSync(agentsDir)) {
    const root = join(agentsDir, folder);
    if (!statSync(root).isDirectory()) continue;
    const state = join(root, 'state');
    console.log(`agent: ${folder}`);
    relabelConversationsJsonl(ctx, join(state, 'conversations.jsonl'));
    relabelAgentDb(ctx, join(state, 'agent.db'));
    relabelTasksJson(ctx, join(state, 'tasks.json'));
    scrubRosterHandles(ctx, join(state, 'identity-roster.json'));
    relabelAclJson(ctx, join(root, 'config', 'acl.json'));
    renameSessionDirs(ctx, root);
  }

  console.log('\ngateway:');
  relabelGatewayDb(ctx, join(configDir, 'gateway.db'));

  console.log(`\n${apply ? 'Applied' : 'Planned'} changes:`);
  for (const [k, n] of Object.entries(ctx.counts).sort()) console.log(`  ${String(n).padStart(5)}  ${k}`);
  if (!Object.keys(ctx.counts).length) console.log('  (nothing to do — already bare)');
  console.log(apply ? '\nDone.' : '\nDry run only. Re-run with --apply --backup to execute.\n');
}

main();
