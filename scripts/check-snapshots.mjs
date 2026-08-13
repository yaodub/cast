#!/usr/bin/env node
// Release gate for the baked cast-services snapshots.
//
// packages/cast/snapshots/{models,version}.json are the offline floor of the
// fallback ladder in packages/cast/src/lib/cast-services.ts: live fetch →
// in-process cache → snapshot. An install that can't reach api.getcast.dev
// sees whatever these files say, forever. Shipping a stale one means shipping
// a stale model picker and an update banner that never fires.
//
// That is not hypothetical — v0.3.0 through v0.3.3 shipped a models snapshot
// two model generations behind and a version snapshot pinned at 0.1.0, because
// steps 6 and 7 of the release checklist (.private/docs/VERSIONING.md) are
// hand-run and nothing checked them.
//
// Three checks:
//   1. version.json#latest == packages/cast/package.json#version   (offline)
//   2. version.json == live /api/updates                            (network)
//   3. models.json  == live /api/models                             (network)
//
// Check 1 is the load-bearing one: it needs no network and catches the exact
// failure above. The network checks catch a catalog edit that landed in S3
// after the last `pnpm sync:snapshots`.
//
// Drift exits 1. An unreachable api.getcast.dev warns and skips checks 2-3
// rather than failing — you cannot diff against a source you can't read, and
// hard-failing a bundle on flaky wifi is worse than the drift it prevents.
// Check 1 still runs and still fails in that case.
//
// Usage: node scripts/check-snapshots.mjs [--quiet]
// Skip entirely: CAST_SKIP_SNAPSHOT_CHECK=1
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOTS = join(ROOT, 'packages', 'cast', 'snapshots');
const BASE = 'https://api.getcast.dev';
const TIMEOUT_MS = 10_000;

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

async function fetchLive(path) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}${path}?current=snapshot`, { signal: ac.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Key-order-insensitive structural compare. sync:snapshots writes the raw
// response body, so key order tracks whatever the Lambda's JSON.stringify
// emitted that day — not a difference worth failing a release over.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export async function checkSnapshots({ quiet = false } = {}) {
  if (process.env.CAST_SKIP_SNAPSHOT_CHECK === '1') {
    console.warn('⚠ snapshot check skipped (CAST_SKIP_SNAPSHOT_CHECK=1)');
    return { ok: true, skipped: true };
  }

  const log = (m) => { if (!quiet) console.log(m); };
  const errors = [];

  const version = readJson(join(SNAPSHOTS, 'version.json'));
  const models = readJson(join(SNAPSHOTS, 'models.json'));
  const pkgVersion = readJson(join(ROOT, 'packages', 'cast', 'package.json')).version;

  // 1 — offline: the snapshot must agree with what this tree ships as.
  if (version.latest !== pkgVersion) {
    errors.push(
      `snapshots/version.json#latest is "${version.latest}" but this tree is ${pkgVersion}.\n` +
      `    An offline install would report "${version.latest} available" while running ${pkgVersion}.\n` +
      `    Fix: publish ${pkgVersion} first (cast-services/updates/bump-version.sh ${pkgVersion}),\n` +
      `         then run \`pnpm sync:snapshots\`.`,
    );
  } else {
    log(`  ✓ version.json#latest matches package.json (${pkgVersion})`);
  }

  // 2, 3 — network: the snapshots must mirror what the endpoints serve today.
  const [liveVersion, liveModels] = await Promise.all([
    fetchLive('/api/updates'),
    fetchLive('/api/models'),
  ]);

  if (liveVersion === null || liveModels === null) {
    console.warn('⚠ api.getcast.dev unreachable — skipped live snapshot diff (offline check still ran)');
  } else {
    if (stable(liveVersion) !== stable(version)) {
      errors.push(
        `snapshots/version.json does not match live /api/updates.\n` +
        `    live: ${JSON.stringify(liveVersion)}\n` +
        `    snap: ${JSON.stringify(version)}\n` +
        `    Fix: \`pnpm sync:snapshots\``,
      );
    } else {
      log('  ✓ version.json matches live /api/updates');
    }

    if (stable(liveModels) !== stable(models)) {
      const liveIds = liveModels.data.map((m) => m.id);
      const snapIds = models.data.map((m) => m.id);
      const missing = liveIds.filter((id) => !snapIds.includes(id));
      const extra = snapIds.filter((id) => !liveIds.includes(id));
      errors.push(
        `snapshots/models.json does not match live /api/models.\n` +
        (missing.length ? `    missing from snapshot: ${missing.join(', ')}\n` : '') +
        (extra.length ? `    stale in snapshot: ${extra.join(', ')}\n` : '') +
        (!missing.length && !extra.length ? `    same model ids, differing metadata or oneMSupported\n` : '') +
        `    Fix: \`pnpm sync:snapshots\``,
      );
    } else {
      log(`  ✓ models.json matches live /api/models (${models.data.length} models)`);
    }
  }

  if (errors.length) {
    console.error('\n✗ snapshot drift — refusing to build:\n');
    for (const e of errors) console.error(`  • ${e}\n`);
    console.error('  Override for a deliberate offline build: CAST_SKIP_SNAPSHOT_CHECK=1\n');
    return { ok: false, errors };
  }
  return { ok: true, errors: [] };
}

// CLI entry — `node scripts/check-snapshots.mjs`
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const quiet = process.argv.includes('--quiet');
  if (!quiet) console.log('Checking cast-services snapshots...');
  const { ok } = await checkSnapshots({ quiet });
  process.exit(ok ? 0 : 1);
}
