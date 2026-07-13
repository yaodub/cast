/**
 * 0.2 → 0.3 migration, step 4 — drop the removed `h` permission bit.
 *
 * The access-model work removed the old `host` (`h`) bit: a cross-agent push is
 * now just the carried user's `io` on the target, so the separate host grant is
 * redundant. `h` is rejected by the 0.3 `AclSchema` (allowlist `ioaqrp`), so an
 * un-migrated acl.json carrying it fails to load — this sweep removes it.
 *
 * `p` is NOT folded. It was reinstated in 0.3 as the reactive push-containment
 * edge (written only by `grantAclEdge`, valid on both user and agent peers), and
 * folding it to `o` would be wrong twice over: it loses the push semantics, and
 * `o` is FORBIDDEN on agent (`a:`) peers (agents are restricted to `qrap`), which
 * would poison the whole ACL at load ("Agent peer carries forbidden bits"). The
 * same reasoning is why we DROP `h` rather than fold it to `i`: `h`/push grants
 * only ever appear on agent peers (users do not push), and `i` is likewise
 * agent-forbidden. Dropping yields valid output for every peer type without
 * needing to resolve aliases to tell agents from users.
 *
 * Mapping: remove `h` from every bits string (dedupe preserved order); drop a
 * channel grant that becomes empty, and a peer that loses all channels. Applied
 * to BOTH `allowed` and `rejected`. Idempotent: a file with no `h` is unchanged.
 *
 * In a typical fleet this is a no-op — `p`/`h` were only ever granted by the
 * code-declared console tables (`auth/console-grants.ts`), never on disk. It
 * runs as a safety net for any agent that did hand-author a host grant.
 *
 * Usage (dry-run prints the diff; `--apply` writes, backing up first):
 *   pnpm exec tsx scripts/migrations/0.2-to-0.3/4-ph-to-io.ts <CAST_AGENTS_DIR> [--apply]
 *   (or CAST_AGENTS_DIR in the environment / repo-root .env)
 *
 * Backup (--apply): the rewritten `acl.json` is copied to `acl.json.pre-ph-fold`.
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

/** Remove the removed `h` bit; keep everything else (dedupe, order-preserving). */
function foldBits(bits: string): string {
  let out = '';
  for (const ch of bits) {
    if (ch === 'h') continue; // removed in 0.3
    if (!out.includes(ch)) out += ch;
  }
  return out;
}

type PeerMap = Record<string, Record<string, string>>;

/** Rewrite every bits string in a peer map. Drops channels that become empty
 *  and peers that lose all channels. Returns the new map + whether it changed. */
function foldPeerMap(map: PeerMap): { next: PeerMap; changed: boolean } {
  const next: PeerMap = {};
  let changed = false;
  for (const [peer, channels] of Object.entries(map)) {
    const nextChannels: Record<string, string> = {};
    for (const [channel, bits] of Object.entries(channels)) {
      const folded = foldBits(bits);
      if (folded !== bits) changed = true;
      if (folded !== '') nextChannels[channel] = folded; // drop empty grant
    }
    if (Object.keys(nextChannels).length > 0) {
      next[peer] = nextChannels;
    } else if (Object.keys(channels).length > 0) {
      changed = true; // peer had grants, now empty → dropped
    }
  }
  return { next, changed };
}

const positional = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined;
const root = positional ?? process.env.CAST_AGENTS_DIR ?? dotEnv().CAST_AGENTS_DIR;
const apply = process.argv.includes('--apply');

if (!root) {
  console.error('usage: 4-ph-to-io.ts [agents-dir] [--apply]   (or CAST_AGENTS_DIR in the environment or repo-root .env)');
  process.exit(1);
}

const agents = readdirSync(root).filter((name) => {
  if (/backup|pre-migrate|pre-allowed|pre-approvals|pre-paired|pre-acl|pre-ph/.test(name)) return false;
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

  const allowed = foldPeerMap((acl.allowed ?? {}) as PeerMap);
  const rejected = foldPeerMap((acl.rejected ?? {}) as PeerMap);
  if (!allowed.changed && !rejected.changed) continue;

  const next = { ...acl, allowed: allowed.next, rejected: rejected.next };
  changedFiles++;
  console.log(`  ${name}: removing the removed \`h\` bit in acl.json (${allowed.changed ? 'allowed' : ''}${allowed.changed && rejected.changed ? ' + ' : ''}${rejected.changed ? 'rejected' : ''})`);

  if (apply) {
    copyFileSync(aclPath, `${aclPath}.pre-ph-fold`);
    writeAtomic(aclPath, JSON.stringify(next, null, 2) + '\n');
  }
}

console.log(`\n${apply ? 'APPLIED' : 'WOULD CHANGE'}: ${changedFiles} agent(s).`);
if (!apply && changedFiles > 0) console.log('Re-run with --apply to write.');
