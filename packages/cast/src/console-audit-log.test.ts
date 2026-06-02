/**
 * Smoke test for `appendChangelog` — proves the audit log helper writes
 * JSONL rows to `state/admin-changelog.jsonl`. Used by every Design and
 * Configure mutating tool to record a single-line history of what
 * happened on this agent's blueprint and config.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { TMP_ROOT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require('fs') as typeof import('fs');
  const osH = require('os') as typeof import('os');
  const pathH = require('path') as typeof import('path');
  return { TMP_ROOT: fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'cast-audit-test-')) };
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    agentPath: (folder: string, ...segments: string[]) =>
      path.join(TMP_ROOT, folder, ...segments),
  };
});

import { appendChangelog } from './console/shared/audit-log.js';

describe('appendChangelog', () => {
  it('writes an entry to state/admin-changelog.jsonl', () => {
    const folder = 'audit-test-a';
    appendChangelog(folder, { actor: 'local', action: 'set_lifecycle', from: 'draft', to: 'ready' });

    const logPath = path.join(TMP_ROOT, folder, 'state', 'admin-changelog.jsonl');
    expect(fs.existsSync(logPath)).toBe(true);

    const content = fs.readFileSync(logPath, 'utf-8');
    const lines = content.trimEnd().split('\n');
    expect(lines).toHaveLength(1);

    const row = JSON.parse(lines[0]);
    expect(row.actor).toBe('local');
    expect(row.action).toBe('set_lifecycle');
    expect(row.from).toBe('draft');
    expect(row.to).toBe('ready');
    expect(typeof row.ts).toBe('string');
    expect(() => new Date(row.ts)).not.toThrow();
  });

  it('appends (not overwrites) across calls', () => {
    const folder = 'audit-test-b';
    appendChangelog(folder, { actor: 'local', action: 'pair_user', identity: 'u:abc@srv' });
    appendChangelog(folder, { actor: 'local', action: 'revoke_user', identity: 'u:abc@srv' });

    const logPath = path.join(TMP_ROOT, folder, 'state', 'admin-changelog.jsonl');
    const lines = fs.readFileSync(logPath, 'utf-8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).action).toBe('pair_user');
    expect(JSON.parse(lines[1]).action).toBe('revoke_user');
  });

  it('creates the state/ directory if it does not exist', () => {
    const folder = 'audit-test-c';
    const stateDir = path.join(TMP_ROOT, folder, 'state');
    expect(fs.existsSync(stateDir)).toBe(false);

    appendChangelog(folder, { actor: 'local', action: 'pair_user' });
    expect(fs.existsSync(stateDir)).toBe(true);
  });
});
