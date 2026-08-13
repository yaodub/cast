#!/usr/bin/env node
// Set every workspace package.json (plus the root) to one version.
// Cast versions in lockstep — all packages move together — so there is no
// per-package coordination to do, just a single field rewrite across the tree.
// Dependency-free on purpose: changesets/lerna earn their keep once outside
// contributors file per-PR entries, which is not true yet, so a 20-line
// rewrite is the right-sized tool.
//
// The one exception is INDEPENDENT below. A package published to npm on its
// own cadence must not be dragged to the server's release version, or the
// next publish jumps a version line that has consumers on it.
//
// The version the site displays (hero block, footer) derives from
// apps/site/package.json via apps/site/src/version.ts, so this script covers
// it — no separate site edit at release time.
//
// Usage: pnpm version:set 0.2.0   (or: node scripts/bump-version.mjs 0.2.0)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(target ?? '')) {
  console.error(`usage: node scripts/bump-version.mjs <semver>  (got: ${target ?? '<none>'})`);
  process.exit(1);
}

// Packages published to npm on their own cadence. Their version is not the
// Cast release version and a release bump must leave them alone.
const INDEPENDENT = new Set(['packages/extension-schema']);

// pnpm-workspace.yaml declares packages/* and apps/*; the root is its own package.
const dirs = ['.'];
for (const parent of ['packages', 'apps']) {
  const base = join(root, parent);
  if (!existsSync(base)) continue;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== 'node_modules') dirs.push(join(parent, entry.name));
  }
}

let changed = 0;
for (const dir of dirs) {
  if (INDEPENDENT.has(dir)) {
    console.log(`  ${dir}/package.json -> skipped (independent version line)`);
    continue;
  }
  const file = join(root, dir, 'package.json');
  if (!existsSync(file)) continue;
  const src = readFileSync(file, 'utf8');
  // First "version" key only — the package's own. Dependency ranges are left alone.
  const next = src.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${target}$2`);
  if (next === src) continue;
  writeFileSync(file, next);
  changed++;
  console.log(`  ${dir}/package.json -> ${target}`);
}
console.log(`bumped ${changed} package.json file(s) to ${target}`);
