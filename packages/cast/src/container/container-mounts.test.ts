/**
 * Tests for the agent-folder privacy boundary on operator-configured resource
 * mounts (Layer 8). A resource host path must live entirely OUTSIDE the agents
 * tree so one agent can never bind another agent's private state/home/memory
 * (or the whole tree) into its own container.
 *
 * Mirrors `agent-paths.test.ts`: `AGENTS_DIR` is redirected to a tmpdir so the
 * predicate and `mountTable` reason about real on-disk paths (realpath, symlinks).
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
    TMP_ROOT: fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'cast-mounts-agents-')),
    OUTSIDE_ROOT: fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'cast-mounts-outside-')),
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

import { mountTable, resourcePathEscapesAgentsTree } from './container-mounts.js';
import type { Host } from '../types.js';
import type { ResourceEntry } from '@getcast/agent-schema/v1';

const HOST: Host = { name: 'agent-a', folder: 'agent-a' };
const CONV_KEY = 'test|conv|key';

beforeEach(() => {
  for (const root of [TMP_ROOT, OUTSIDE_ROOT]) {
    for (const entry of fs.readdirSync(root)) {
      fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    }
  }
});

describe('resourcePathEscapesAgentsTree', () => {
  it('rejects another agent folder', () => {
    const other = path.join(TMP_ROOT, 'agent-b');
    fs.mkdirSync(other, { recursive: true });
    expect(resourcePathEscapesAgentsTree(other)).toMatch(/inside the agents tree/);
  });

  it('rejects a subdir of another agent folder (state/home/memory)', () => {
    const otherState = path.join(TMP_ROOT, 'agent-b', 'state');
    fs.mkdirSync(otherState, { recursive: true });
    expect(resourcePathEscapesAgentsTree(otherState)).toMatch(/inside the agents tree/);
  });

  it("rejects the agent's own folder", () => {
    const own = path.join(TMP_ROOT, 'agent-a', 'home');
    fs.mkdirSync(own, { recursive: true });
    expect(resourcePathEscapesAgentsTree(own)).toMatch(/inside the agents tree/);
  });

  it('rejects the agents root itself', () => {
    expect(resourcePathEscapesAgentsTree(TMP_ROOT)).toMatch(/inside the agents tree/);
  });

  it('rejects an ancestor of the agents root', () => {
    const ancestor = path.dirname(TMP_ROOT);
    expect(resourcePathEscapesAgentsTree(ancestor)).toMatch(/contains the agents tree/);
  });

  it('rejects a symlink (under an allowed dir) that points back into the tree', () => {
    const otherState = path.join(TMP_ROOT, 'agent-b', 'state');
    fs.mkdirSync(otherState, { recursive: true });
    const link = path.join(OUTSIDE_ROOT, 'sneaky');
    fs.symlinkSync(otherState, link);
    expect(resourcePathEscapesAgentsTree(link)).toMatch(/inside the agents tree/);
  });

  it('allows a path entirely outside the agents tree', () => {
    const ok = path.join(OUTSIDE_ROOT, 'shared-data');
    fs.mkdirSync(ok, { recursive: true });
    expect(resourcePathEscapesAgentsTree(ok)).toBeNull();
  });

  it('does not confuse a sibling whose name prefixes the agents root', () => {
    // e.g. AGENTS_DIR=/tmp/agents and a resource at /tmp/agents-data
    const sibling = `${TMP_ROOT}-data`;
    fs.mkdirSync(sibling, { recursive: true });
    expect(resourcePathEscapesAgentsTree(sibling)).toBeNull();
    fs.rmSync(sibling, { recursive: true, force: true });
  });
});

describe('mountTable — Layer 8 resource privacy enforcement', () => {
  it('drops a resource that points into another agent folder, keeps a valid one', () => {
    const otherFolder = path.join(TMP_ROOT, 'agent-b', 'home');
    fs.mkdirSync(otherFolder, { recursive: true });
    const goodPath = path.join(OUTSIDE_ROOT, 'data');
    fs.mkdirSync(goodPath, { recursive: true });

    const resources: Record<string, ResourceEntry> = {
      stolen: { path: otherFolder, access: 'rw' },
      legit: { path: goodPath, access: 'ro' },
    };
    const mounts = mountTable(HOST, CONV_KEY, resources);
    const containerPaths = mounts.map((m) => m.containerPath);
    expect(containerPaths).not.toContain('/resources/stolen');
    expect(containerPaths).toContain('/resources/legit');
  });
});
