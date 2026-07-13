/**
 * 0.2 → 0.3 migration, step 1 — acl.json `peers` → `allowed`.
 *
 * The access-model work renamed the ACL grant map `peers` → `allowed`
 * (for the `allowed` / `rejected` polarity pair). The runtime no longer accepts
 * the legacy `peers` key — the tolerant `allowed ?? peers` loader was removed and
 * `AclSchema` is `.strict()`, so an un-migrated acl.json now fails to parse. This
 * sweep rewrites each on-disk acl.json's top-level `peers` key to `allowed`. If a
 * file somehow carries both, `allowed` wins per peer key (matching the old
 * coalescing) and `peers` is dropped.
 *
 * Usage (dry-run prints the diff; `--apply` writes, backing up first):
 *   pnpm exec tsx scripts/migrations/0.2-to-0.3/1-acl-peers-to-allowed.ts <CAST_AGENTS_DIR> [--apply]
 *   (or CAST_AGENTS_DIR in the environment / repo-root .env)
 *
 * Backup: in `--apply` mode each rewritten `acl.json` is copied to
 * `acl.json.pre-allowed-rename` first — the only file this sweep modifies.
 */
import { createRequire } from 'node:module';
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
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
  console.error('usage: 1-acl-peers-to-allowed.ts [agents-dir] [--apply]   (or CAST_AGENTS_DIR in the environment or repo-root .env)');
  process.exit(1);
}

type ChannelBits = Record<string, string>;
type PeerMap = Record<string, ChannelBits>;

const agents = readdirSync(root).filter((name) => {
  if (/backup|pre-migrate|pre-allowed|pre-approvals/.test(name)) return false;
  try {
    return statSync(join(root, name)).isDirectory();
  } catch {
    return false;
  }
});

let changedFiles = 0;

console.log(`\n${apply ? 'APPLY' : 'DRY-RUN'} — ${root}\n`);

for (const name of agents) {
  const aclPath = join(root, name, 'config', 'acl.json');
  if (!existsSync(aclPath)) continue;

  let acl: Record<string, unknown>;
  try {
    acl = JSON.parse(readFileSync(aclPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    console.log(`  ${name}: SKIP — acl.json is not valid JSON (${(err as Error).message})`);
    continue;
  }
  if (!('peers' in acl)) continue;

  const peers = (acl.peers ?? {}) as PeerMap;
  const allowed = (acl.allowed ?? {}) as PeerMap;
  // `allowed` wins per peer key, matching the retired coalescing loader.
  const merged: PeerMap = { ...peers, ...allowed };

  // Rebuild with `allowed` in place of `peers`, key order preserved otherwise.
  const next: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(acl)) {
    if (k === 'peers') {
      if (!('allowed' in next)) next.allowed = merged;
      continue;
    }
    if (k === 'allowed') {
      next.allowed = merged;
      continue;
    }
    next[k] = v;
  }
  if (!('allowed' in next)) next.allowed = merged;

  changedFiles++;
  console.log(`  ${name}: peers (${Object.keys(peers).length} key(s)) → allowed${Object.keys(allowed).length ? ` (merged with ${Object.keys(allowed).length} existing allowed key(s))` : ''}`);

  if (apply) {
    copyFileSync(aclPath, `${aclPath}.pre-allowed-rename`);
    writeAtomic(aclPath, JSON.stringify(next, null, 2) + '\n');
  }
}

console.log(`\n${apply ? 'APPLIED' : 'WOULD CHANGE'}: ${changedFiles} acl.json file(s).`);
if (!apply && changedFiles > 0) console.log('Re-run with --apply to write.');
