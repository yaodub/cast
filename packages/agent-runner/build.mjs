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

console.log(`\nBuild complete! Image: ${image}`);
