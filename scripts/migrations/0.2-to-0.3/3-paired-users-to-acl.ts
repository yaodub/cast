/**
 * 0.2 → 0.3 migration, step 3 — fold `state/paired-users.json` into `config/acl.json`.
 *
 * The access-model work collapses to a SINGLE ACL store: `acl.json`
 * holds all live grants — operator-authored and runtime owner-approved alike.
 * Pairing is removed, so the separate per-agent paired-users grant store
 * (`state/paired-users.json`, identity → channel → bits) no longer exists and the
 * runtime no longer reads it. This sweep folds each agent's paired-user grants
 * into its `acl.json` `allowed` map so previously-paired users keep their access,
 * then retires `paired-users.json`.
 *
 * Precedence: `acl.json`'s `allowed` wins per identity (operator config is
 * authoritative), matching the retired `{ ...paired, ...allowed }` merge.
 *
 * Usage (dry-run prints the diff; `--apply` writes, backing up first):
 *   pnpm exec tsx scripts/migrations/0.2-to-0.3/3-paired-users-to-acl.ts <CAST_AGENTS_DIR> [--apply]
 *   (or CAST_AGENTS_DIR in the environment / repo-root .env)
 *
 * Backup (--apply): the rewritten `acl.json` is copied to `acl.json.pre-paired-fold`
 * first; `paired-users.json` is renamed to `paired-users.json.pre-acl-fold` (so it
 * is both backed up and removed from the live path in one step).
 */
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(new URL('../../../packages/cast/package.json', import.meta.url));

/** Write tmp + rename so a concurrent reader never sees a partial file. */
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
  console.error('usage: 3-paired-users-to-acl.ts [agents-dir] [--apply]   (or CAST_AGENTS_DIR in the environment or repo-root .env)');
  process.exit(1);
}

type ChannelBits = Record<string, string>;
type PeerMap = Record<string, ChannelBits>;

const agents = readdirSync(root).filter((name) => {
  if (/backup|pre-migrate|pre-allowed|pre-approvals|pre-paired|pre-acl/.test(name)) return false;
  try {
    return statSync(join(root, name)).isDirectory();
  } catch {
    return false;
  }
});

let changedFiles = 0;

console.log(`\n${apply ? 'APPLY' : 'DRY-RUN'} — ${root}\n`);

for (const name of agents) {
  const pairedPath = join(root, name, 'state', 'paired-users.json');
  if (!existsSync(pairedPath)) continue;

  let paired: PeerMap;
  try {
    paired = JSON.parse(readFileSync(pairedPath, 'utf-8')) as PeerMap;
  } catch (err) {
    console.log(`  ${name}: SKIP — paired-users.json is not valid JSON (${(err as Error).message})`);
    continue;
  }
  const pairedKeys = Object.keys(paired);
  if (pairedKeys.length === 0) {
    // Empty store — nothing to fold; just retire the file.
    console.log(`  ${name}: paired-users.json is empty — retiring it`);
    changedFiles++;
    if (apply) renameSync(pairedPath, `${pairedPath}.pre-acl-fold`);
    continue;
  }

  const aclPath = join(root, name, 'config', 'acl.json');
  let acl: Record<string, unknown> = { owner: 'operator', allowed: {} };
  if (existsSync(aclPath)) {
    try {
      acl = JSON.parse(readFileSync(aclPath, 'utf-8')) as Record<string, unknown>;
    } catch (err) {
      console.log(`  ${name}: SKIP — acl.json is not valid JSON (${(err as Error).message})`);
      continue;
    }
  }

  const allowed = (acl.allowed ?? {}) as PeerMap;
  // acl.json's `allowed` wins per identity (operator config is authoritative).
  const merged: PeerMap = { ...paired, ...allowed };
  const next = { ...acl, allowed: merged };

  changedFiles++;
  console.log(`  ${name}: folding ${pairedKeys.length} paired user(s) → acl.json allowed${Object.keys(allowed).length ? ` (over ${Object.keys(allowed).length} existing allowed key(s))` : ''}`);

  if (apply) {
    if (existsSync(aclPath)) copyFileSync(aclPath, `${aclPath}.pre-paired-fold`);
    mkdirSync(join(root, name, 'config'), { recursive: true });
    writeAtomic(aclPath, JSON.stringify(next, null, 2) + '\n');
    renameSync(pairedPath, `${pairedPath}.pre-acl-fold`);
  }
}

console.log(`\n${apply ? 'APPLIED' : 'WOULD CHANGE'}: ${changedFiles} agent(s).`);
if (!apply && changedFiles > 0) console.log('Re-run with --apply to write.');
