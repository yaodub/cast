/**
 * Content hash over the agent image's build inputs.
 *
 * The hash answers "what image would a build produce from the tree right
 * now?" — build.mjs staples it to the built image as a receipt tag
 * (cast-agent:src-<hash>), and start.mjs / dev.ts check that tag's existence
 * to decide whether the image is stale. Image digests themselves are
 * nondeterministic (timestamps, apt/npm resolution), so inputs are the only
 * thing hashable without building.
 *
 * Shared by build.mjs (staple side) and scripts/start.mjs / scripts/dev.ts
 * (check side) — both sides must agree byte-for-byte, so the manifest and
 * hashing live here and nowhere else. Plain .mjs, zero deps: runs on a clean
 * clone with just Node, before anything is installed or built.
 */
import { createHash } from 'crypto';
import { readdirSync, readFileSync, statSync } from 'fs';
import { dirname, join, relative, sep } from 'path';
import { fileURLToPath } from 'url';

// All paths anchor here, never the CWD — a CWD-relative manifest would hash
// differently per invocation directory and cause permanent rebuild loops.
const PKG_DIR = dirname(fileURLToPath(import.meta.url));

export const SENTINEL_PREFIX = 'cast-agent:src-';

export function sentinelTag(hash) {
  return SENTINEL_PREFIX + hash;
}

/**
 * Everything the image build consumes, relative to this directory. Mirrors
 * the Dockerfile's COPY lines plus the build machinery itself. Keep in sync
 * when the Dockerfile gains a COPY — the Dockerfile is itself hashed, so a
 * new COPY line still triggers one correct rebuild, but the new file's
 * subsequent edits go undetected until it's listed here.
 */
export const INPUT_MANIFEST = [
  'Dockerfile',
  'entrypoint.sh',     // COPY entrypoint.sh
  'update-egress.sh',  // COPY update-egress.sh
  'src',               // COPY src ./src (directory, walked recursively)
  'package.json',      // COPY package*.json — if a package-lock.json is ever committed here, add it
  'tsconfig.json',     // COPY tsconfig.json
  'build.mjs',         // the builder itself — flag/invocation changes invalidate
];

/**
 * sha256 over sorted (relpath + '\0' + bytes) pairs of all manifest files,
 * truncated to 12 hex chars. Deterministic: byte-wise sort (not locale-aware),
 * '/' separators regardless of platform. Throws if a manifest entry is
 * missing — a loud failure beats a stable hash over a broken tree.
 */
export function computeImageHash() {
  const files = [];
  for (const entry of INPUT_MANIFEST) {
    const abs = join(PKG_DIR, entry);
    if (statSync(abs).isFile()) {
      files.push({ rel: entry, abs });
      continue;
    }
    for (const e of readdirSync(abs, { recursive: true, withFileTypes: true })) {
      // Skip dotfiles (.DS_Store): Finder drops them into src/ and they'd
      // force spurious rebuilds. Deliberate divergence from "hash exactly
      // what COPY copies" — they ship into the image but never affect it.
      // Symlinks are implicitly excluded too (isFile() is false for them).
      if (!e.isFile() || e.name.startsWith('.')) continue;
      // parentPath ?? path: Dirent field was renamed across Node 20 → 22.
      const fileAbs = join(e.parentPath ?? e.path, e.name);
      files.push({ rel: relative(PKG_DIR, fileAbs).split(sep).join('/'), abs: fileAbs });
    }
  }
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const hash = createHash('sha256');
  for (const f of files) {
    hash.update(f.rel, 'utf8');
    hash.update('\0');
    hash.update(readFileSync(f.abs));
  }
  return hash.digest('hex').slice(0, 12);
}
