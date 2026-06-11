/**
 * Tests for `createPathResolver` — host-side path resolution and mount-surface
 * enforcement for the file-watch primitive.
 *
 * Each test creates a real agent folder layout under `os.tmpdir()` and exercises
 * the resolver against actual filesystem operations (lstat, realpath, symlinks).
 * The `vi.mock('../config.js')` block redirects `agentPath` to the tmpdir so
 * `mountTable` produces tmp host paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { TMP_ROOT, OUTSIDE_ROOT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require('fs') as typeof import('fs');
  const osH = require('os') as typeof import('os');
  const pathH = require('path') as typeof import('path');
  return {
    TMP_ROOT: fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'cast-resolver-test-')),
    // Operator resources live OUTSIDE the agents tree — the privacy boundary
    // (`resourcePathEscapesAgentsTree`) drops any resource path inside AGENTS_DIR.
    OUTSIDE_ROOT: fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'cast-resolver-ext-')),
  };
});

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js');
  return {
    ...actual,
    AGENTS_DIR: TMP_ROOT,
    agentPath: (folder: string, ...segments: string[]) =>
      path.join(TMP_ROOT, folder, ...segments),
    sessionClaudePath: (folder: string, _k: string) =>
      path.join(TMP_ROOT, folder, 'sessions', 'testhash', '.claude'),
    sessionCastSocketPath: (folder: string, _k: string) =>
      path.join(TMP_ROOT, folder, 'mcp', 'socket', 'testhash.sock'),
    mcpDir: (folder: string) => path.join(TMP_ROOT, folder, 'mcp', 'socket'),
  };
});

import { createPathResolver } from './agent-paths.js';
import { mountTable } from '../container/container-mounts.js';
import type { Host } from '../types.js';

const HOST: Host = { name: 'test-agent', folder: 'test-agent' };
const CONV_KEY = 'test|conv|key';

/**
 * Build the agent folder layout that `mountTable` references. Mirrors
 * `ensureAgentMountDirs` from container-mounts.ts so the resolver finds
 * existing directories. Tests then add files inside as needed.
 *
 * Note: container-side `/staging` maps to the per-conversation host dir
 * — the conversationKey segment is what `conversationKeyToPath` produces.
 */
function setupAgentLayout(): { stagingHostDir: string } {
  const folder = HOST.folder;
  fs.mkdirSync(path.join(TMP_ROOT, folder, 'blueprint', 'identity'), { recursive: true });
  fs.mkdirSync(path.join(TMP_ROOT, folder, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(TMP_ROOT, folder, 'home'), { recursive: true });
  fs.mkdirSync(path.join(TMP_ROOT, folder, 'blueprint', 'assets'), { recursive: true });
  fs.mkdirSync(path.join(TMP_ROOT, folder, 'shared', 'ext'), { recursive: true });
  fs.mkdirSync(path.join(TMP_ROOT, folder, 'sessions', 'testhash', '.claude'), { recursive: true });
  fs.mkdirSync(path.join(TMP_ROOT, folder, 'state', 'attachments'), { recursive: true });

  // Staging dir — the resolver uses whatever path mountTable produces.
  const mt = mountTable(HOST, CONV_KEY);
  const stagingMount = mt.find((m) => m.containerPath === '/staging');
  if (!stagingMount) throw new Error('staging mount missing — check mountTable');
  fs.mkdirSync(path.join(stagingMount.hostPath, 'in'), { recursive: true });
  fs.mkdirSync(path.join(stagingMount.hostPath, 'out'), { recursive: true });
  return { stagingHostDir: stagingMount.hostPath };
}

beforeEach(() => {
  for (const root of [TMP_ROOT, OUTSIDE_ROOT]) {
    for (const entry of fs.readdirSync(root)) {
      fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    }
  }
});

describe('mountTable — system mount tagging', () => {
  it('tags /home/node/.claude as system', () => {
    const mt = mountTable(HOST, CONV_KEY);
    const claude = mt.find((m) => m.containerPath === '/home/node/.claude');
    expect(claude).toBeDefined();
    expect(claude!.isSystem).toBe(true);
  });

  it('does not tag agent-watchable mounts as system', () => {
    const mt = mountTable(HOST, CONV_KEY);
    for (const cp of ['/memory', '/home/agent', '/identity', '/assets', '/shared', '/attachments', '/staging']) {
      const m = mt.find((mm) => mm.containerPath === cp);
      expect(m, `${cp} mount missing`).toBeDefined();
      expect(m!.isSystem, `${cp} should not be system`).toBeFalsy();
    }
  });
});

describe('createPathResolver — happy paths', () => {
  beforeEach(() => {
    setupAgentLayout();
  });

  it('resolves /memory/foo.jsonl as RW', () => {
    const target = path.join(TMP_ROOT, HOST.folder, 'memory', 'foo.jsonl');
    fs.writeFileSync(target, '');
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveReadable('/memory/foo.jsonl');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe('rw');
      expect(result.hostPath).toBe(fs.realpathSync(target));
    }
  });

  it('resolves /identity/skill.md as RO', () => {
    const target = path.join(TMP_ROOT, HOST.folder, 'blueprint', 'identity', 'skill.md');
    fs.writeFileSync(target, '');
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveReadable('/identity/skill.md');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mode).toBe('ro');
  });

  it('resolves /home/agent/draft.md as RW', () => {
    const target = path.join(TMP_ROOT, HOST.folder, 'home', 'draft.md');
    fs.writeFileSync(target, '');
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveReadable('/home/agent/draft.md');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mode).toBe('rw');
  });

  it('resolves /assets/manual.txt as RO', () => {
    const target = path.join(TMP_ROOT, HOST.folder, 'blueprint', 'assets', 'manual.txt');
    fs.writeFileSync(target, '');
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveReadable('/assets/manual.txt');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mode).toBe('ro');
  });

  it('resolves /shared/a/b.json as RO', () => {
    const dir = path.join(TMP_ROOT, HOST.folder, 'shared', 'ext', 'a');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'b.json'), '');
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveReadable('/shared/a/b.json');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mode).toBe('ro');
  });

  it('resolves /staging/in/queue.json as RW', () => {
    const { stagingHostDir } = setupAgentLayout();
    fs.writeFileSync(path.join(stagingHostDir, 'in', 'queue.json'), '');
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveReadable('/staging/in/queue.json');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mode).toBe('rw');
  });

  it('resolves /attachments/abc123 as RO', () => {
    const target = path.join(TMP_ROOT, HOST.folder, 'state', 'attachments', 'abc123');
    fs.writeFileSync(target, '');
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveReadable('/attachments/abc123');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mode).toBe('ro');
  });

  it('resolves /home/agent (the mount root itself) when it exists', () => {
    const r = createPathResolver(HOST, CONV_KEY);
    // The mount root is a directory; resolver should treat it as a valid target.
    const result = r.resolveReadable('/home/agent');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mode).toBe('rw');
  });
});

describe('createPathResolver — operator resources', () => {
  beforeEach(() => {
    setupAgentLayout();
  });

  it('resolves /resources/photos as RW when access:rw', () => {
    const externalDir = path.join(OUTSIDE_ROOT, 'external-photos');
    fs.mkdirSync(externalDir, { recursive: true });
    fs.writeFileSync(path.join(externalDir, 'img.jpg'), '');
    const r = createPathResolver(HOST, CONV_KEY, { photos: { path: externalDir, access: 'rw' } });
    const result = r.resolveReadable('/resources/photos/img.jpg');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mode).toBe('rw');
  });

  it('resolves /resources/photos as RO by default', () => {
    const externalDir = path.join(OUTSIDE_ROOT, 'external-photos-ro');
    fs.mkdirSync(externalDir, { recursive: true });
    fs.writeFileSync(path.join(externalDir, 'img.jpg'), '');
    const r = createPathResolver(HOST, CONV_KEY, { photos: { path: externalDir, access: 'ro' } });
    const result = r.resolveReadable('/resources/photos/img.jpg');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mode).toBe('ro');
  });

  it('resolves /resources/<name> when host path is itself a symlink', () => {
    // The operator points photos: at a symlink. realpath(mount.hostPath) resolves
    // the symlink; the file inside resolves to the same physical target. Both
    // sides realpath'd → no false traversal rejection.
    const realDir = path.join(OUTSIDE_ROOT, 'real-photos');
    fs.mkdirSync(realDir, { recursive: true });
    fs.writeFileSync(path.join(realDir, 'img.jpg'), '');
    const symlinkedDir = path.join(OUTSIDE_ROOT, 'symlinked-photos');
    fs.symlinkSync(realDir, symlinkedDir);
    const r = createPathResolver(HOST, CONV_KEY, { photos: { path: symlinkedDir, access: 'rw' } });
    const result = r.resolveReadable('/resources/photos/img.jpg');
    expect(result.ok).toBe(true);
  });
});

describe('createPathResolver — failure modes', () => {
  beforeEach(() => {
    setupAgentLayout();
  });

  it('returns wrong-mode when resolveWritable hits an RO mount', () => {
    const target = path.join(TMP_ROOT, HOST.folder, 'blueprint', 'identity', 'skill.md');
    fs.writeFileSync(target, '');
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveWritable('/identity/skill.md');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('wrong-mode');
      if (result.kind === 'wrong-mode') {
        expect(result.required).toBe('rw');
        expect(result.actual).toBe('ro');
      }
    }
  });

  it('allows resolveWritable on an RW mount (both branches)', () => {
    const target = path.join(TMP_ROOT, HOST.folder, 'memory', 'foo.jsonl');
    fs.writeFileSync(target, '');
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveWritable('/memory/foo.jsonl');
    expect(result.ok).toBe(true);
  });

  it('returns enoent when the target does not exist', () => {
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveReadable('/memory/missing.jsonl');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('enoent');
  });

  it('returns enoent for resolveWritable too', () => {
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveWritable('/memory/missing.jsonl');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('enoent');
  });

  it('returns symlink when target is a symlink', () => {
    const realFile = path.join(TMP_ROOT, HOST.folder, 'memory', 'real.jsonl');
    fs.writeFileSync(realFile, '');
    const linkPath = path.join(TMP_ROOT, HOST.folder, 'memory', 'link.jsonl');
    fs.symlinkSync(realFile, linkPath);
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveReadable('/memory/link.jsonl');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('symlink');
  });

  it('returns traversal when symlink chain escapes the mount root', () => {
    // Place a file outside the mount root, then symlink the mount's parent dir
    // through a chain that the realpath would resolve to outside the mount.
    // Easiest: make a directory symlink that points outside the mount, and
    // request a file under it. lstat on the file (target of the symlinked
    // intermediate) — actually we need to traverse through the symlinked dir.
    //
    // Setup: /memory/escape -> /tmp-root/outside (via symlink dir)
    //        /memory/escape/secret.txt exists (resolves to /tmp-root/outside/secret.txt)
    //        lstat on /memory/escape/secret.txt — not a symlink itself.
    //        realpath resolves to /tmp-root/outside/secret.txt — outside /memory.
    const outsideDir = path.join(TMP_ROOT, 'outside');
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'leaked');
    const escapePath = path.join(TMP_ROOT, HOST.folder, 'memory', 'escape');
    fs.symlinkSync(outsideDir, escapePath);
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveReadable('/memory/escape/secret.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('traversal');
  });

  it('returns no-mount for /home/node/.claude (system mount filtered out)', () => {
    fs.writeFileSync(path.join(TMP_ROOT, HOST.folder, 'sessions', 'testhash', '.claude', 'settings.json'), '');
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveReadable('/home/node/.claude/settings.json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('no-mount');
  });

  it('returns no-mount for /mcp/cast.sock (system mount filtered out)', () => {
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveReadable('/mcp/cast.sock');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('no-mount');
  });

  it('returns no-mount for an unknown container path', () => {
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveReadable('/random/foo');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('no-mount');
  });

  it('returns invalid-path for relative paths', () => {
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveReadable('memory/foo');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('invalid-path');
  });

  it('returns invalid-path when path contains .. segments', () => {
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveReadable('/memory/../etc/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('invalid-path');
  });

  it('returns invalid-path for empty string', () => {
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveReadable('');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('invalid-path');
  });

  it('returns invalid-path for root /', () => {
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveReadable('/');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe('invalid-path');
  });

  it('normalizes interior . and double-slashes (allow)', () => {
    const target = path.join(TMP_ROOT, HOST.folder, 'memory', 'foo.jsonl');
    fs.writeFileSync(target, '');
    const r = createPathResolver(HOST, CONV_KEY);
    const result = r.resolveReadable('/memory/./foo.jsonl');
    expect(result.ok).toBe(true);
  });
});

describe('createPathResolver — longest-prefix match', () => {
  it('prefers /home/agent over a hypothetical /home prefix', () => {
    setupAgentLayout();
    const target = path.join(TMP_ROOT, HOST.folder, 'home', 'draft.md');
    fs.writeFileSync(target, '');
    const r = createPathResolver(HOST, CONV_KEY);
    // /home is not its own mount; /home/agent should match.
    const result = r.resolveReadable('/home/agent/draft.md');
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Must resolve to the /home/agent host path, not the parent /home.
      expect(result.hostPath).toBe(fs.realpathSync(target));
    }
  });
});
