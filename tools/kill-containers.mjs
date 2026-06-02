#!/usr/bin/env node
/**
 * Kill all running Cast containers. Runtime-aware (Apple Container or Docker)
 * and cross-platform — replaces kill-containers.sh.
 *
 * Usage: node tools/kill-containers.mjs   (wired as `pnpm kill`)
 */
import { execFileSync } from 'child_process';
import { accessSync, constants } from 'fs';
import { delimiter, join } from 'path';

const PREFIX = 'cast-';

// Cross-platform PATH lookup — replaces `which` (absent on Windows).
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

const runtime =
  process.platform === 'darwin' && binaryExists('container') ? 'container'
  : binaryExists('docker') ? 'docker'
  : null;

if (!runtime) {
  console.log('No container runtime found.');
  process.exit(0);
}

// List running cast-* container names. The JSON shapes differ per runtime
// (mirrors index.ts cleanupOrphanedContainers): Apple Container emits a JSON
// array with names at configuration.id; Docker emits newline-delimited names.
function listNames() {
  try {
    if (runtime === 'container') {
      const out = execFileSync('container', ['ls', '--format', 'json'], {
        encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
      });
      return JSON.parse(out || '[]')
        .map((c) => c?.configuration?.id)
        .filter((id) => typeof id === 'string' && id.startsWith(PREFIX));
    }
    const out = execFileSync('docker', ['ps', '--filter', `name=${PREFIX}`, '--format', '{{.Names}}'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    });
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return []; // daemon down or nothing running — treat as empty
  }
}

const names = listNames();
if (names.length === 0) {
  console.log('No cast containers');
  process.exit(0);
}

for (const name of names) {
  try {
    execFileSync(runtime, ['stop', name], { stdio: 'ignore', timeout: 15_000 });
    console.log(`stopped ${name}`);
  } catch {
    try {
      execFileSync(runtime, ['rm', '-f', name], { stdio: 'ignore', timeout: 15_000 });
      console.log(`killed ${name}`);
    } catch {
      console.log(`failed ${name}`);
    }
  }
}
