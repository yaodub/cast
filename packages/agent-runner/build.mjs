#!/usr/bin/env node
/**
 * Build the Cast agent container image.
 *
 * Runtime-aware (Apple Container on macOS if present, else Docker) and
 * cross-platform — replaces build.sh so `pnpm build:image` and the
 * dev/start bootstrap work on macOS, Linux, and Windows. The container
 * runtime binaries (`container`/`docker`) are real executables, so plain
 * execFileSync resolves them without the .cmd shim hazard that affects
 * pnpm/tsx (see cross-spawn usage elsewhere).
 *
 * Usage: node packages/agent-runner/build.mjs [tag]   (tag defaults to "latest")
 */
import { execFileSync } from 'child_process';
import { accessSync, constants } from 'fs';
import { delimiter, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { computeImageHash, sentinelTag, SENTINEL_PREFIX } from './image-hash.mjs';

// Cross-platform PATH lookup — replaces `which` (absent on Windows).
// Duplicated by design: this script runs standalone with plain Node.
function binaryExists(name) {
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      try { accessSync(join(dir, name + ext), constants.X_OK); return true; }
      catch { /* not here — try next */ }
    }
  }
  return false;
}

// Mirror config.ts resolveRuntime(): Apple Container on macOS if present, else Docker.
const runtime =
  process.platform === 'darwin' && binaryExists('container') ? 'container'
  : binaryExists('docker') ? 'docker'
  : null;

if (!runtime) {
  console.error('No container runtime found. Install Apple Container (macOS 26+) or Docker.');
  process.exit(1);
}

const tag = process.argv[2] || 'latest';
const image = `cast-agent:${tag}`;
// Build context = this script's directory (packages/agent-runner, where the Dockerfile lives).
const contextDir = dirname(fileURLToPath(import.meta.url));

// Hash the build inputs BEFORE building so the receipt describes what this
// build consumed. An edit landing mid-build self-heals on the next start
// (recompute → mismatch → rebuild).
const hash = computeImageHash();

console.log(`Building Cast agent container image with ${runtime}...`);
console.log(`Image: ${image}`);

try {
  execFileSync(runtime, ['build', '-t', image, '.'], { cwd: contextDir, stdio: 'inherit' });
} catch {
  console.error('\nBuild failed.');
  // Apple Container's most common first-run failure: no guest kernel is
  // configured yet, so the build dies with "default kernel not configured for
  // architecture <arch>". It's a one-time setup and there's no read-only probe
  // to preflight it, so point the user at the fix when we're on that runtime.
  if (runtime === 'container') {
    console.error(
      'If the error above says "default kernel not configured", Apple Container\n' +
      'needs a one-time kernel setup. Run:\n' +
      '  container system kernel set --recommended\n' +
      'then run `pnpm start` again.',
    );
  }
  process.exit(1);
}

// Staple the staleness receipt: a second tag recording which inputs this
// image was built from. start.mjs/dev.ts check its existence to decide
// whether the image is current; :latest stays the only tag anything runs.
// Default tag only — a custom-tag build must not mark :latest current
// without having updated it. No try/catch: a tag failure right after a
// successful build is anomalous and worth surfacing (the next start just
// rebuilds, so failing loud costs nothing).
if (tag === 'latest') {
  const receipt = sentinelTag(hash);
  execFileSync(runtime, ['image', 'tag', image, receipt], { stdio: 'ignore' });
  cleanupStaleSentinels(runtime, receipt);
}

console.log(`\nBuild complete! Image: ${image}${tag === 'latest' ? ` (receipt: src-${hash})` : ''}`);

// Untag stale receipts so each source change doesn't pin a full old image
// (~600 MB) in the store. Removing a tag only deletes the image when it was
// the last reference (verified on Docker and Apple Container 0.11).
// Best-effort end to end: a listing/parse failure or an in-use old image
// just leaves an orphan tag for the next rebuild to collect. The prefix
// filter means :latest and :<version> are never touched.
function cleanupStaleSentinels(runtime, current) {
  let refs;
  try {
    if (runtime === 'container') {
      // Apple Container stores `image tag` targets registry-qualified
      // (docker.io/library/cast-agent:src-…) while build -t names stay short.
      // Normalize before filtering; rm and inspect resolve short names fine.
      const out = execFileSync('container', ['image', 'list', '--format', 'json'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      refs = JSON.parse(out)
        .map((e) => (typeof e.reference === 'string' ? e.reference.replace(/^docker\.io\/library\//, '') : ''))
        .filter((r) => r.startsWith(SENTINEL_PREFIX));
    } else {
      const out = execFileSync('docker', ['image', 'ls', 'cast-agent', '--format', '{{.Tag}}'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      refs = out.split('\n').filter(Boolean).map((t) => `cast-agent:${t}`).filter((r) => r.startsWith(SENTINEL_PREFIX));
    }
  } catch {
    return; // listing failed — orphan tags are cosmetic, never block a build
  }
  for (const ref of refs) {
    if (ref === current) continue;
    try { execFileSync(runtime, ['image', 'rm', ref], { stdio: 'ignore' }); }
    catch { /* old image in use by a running container — collected next rebuild */ }
  }
}
