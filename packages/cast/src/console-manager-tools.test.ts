/**
 * manager__list / manager__read / manager__resurvey, resolveAgentToFolder,
 * view-dir maintenance primitives.
 *
 * The MCP tool registration layer (`server.tool`) isn't exercised directly;
 * instead we test the helpers they delegate to plus the exported
 * initializeViewDir / maintainViewDir / resolveAgentToFolder / isManagerConsole
 * surfaces. Integration of the tools via real MCP client is covered elsewhere.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { TMP_ROOT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require('fs') as typeof import('fs');
  const osH = require('os') as typeof import('os');
  const pathH = require('path') as typeof import('path');
  return { TMP_ROOT: fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'cast-mgr-tools-test-')) };
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    AGENTS_DIR: TMP_ROOT,
    agentPath: (folder: string, ...segments: string[]) => path.join(TMP_ROOT, folder, ...segments),
    listSubdirectories: (dir: string) =>
      fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
  };
});

import { isManagerConsole, viewDirForConsole } from './console/shared/manager-consoles.js';
import { resolveAgentToFolder } from './console/shared/manager-tools.js';
import {
  initializeViewDir,
  maintainViewDir,
  readIdentity,
} from './console/shared/view-dir-maintenance.js';

function writeFile(rel: string, content: string | Buffer): string {
  const abs = path.join(TMP_ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function writeManifest(folder: string, data: Record<string, unknown>): void {
  writeFile(`${folder}/manifest.json`, JSON.stringify(data));
}

function cleanRoot(): void {
  for (const entry of fs.readdirSync(TMP_ROOT)) {
    fs.rmSync(path.join(TMP_ROOT, entry), { recursive: true, force: true });
  }
}

describe('isManagerConsole', () => {
  it.each([
    ['design-manager', true],
    ['config-manager', true],
    ['security-manager', true],
    ['design', false],
    ['configure', false],
  ] as const)('(%s) → %s', (name, want) => {
    expect(isManagerConsole(name)).toBe(want);
  });
});

describe('resolveAgentToFolder', () => {
  beforeEach(cleanRoot);

  it('returns folder on exact folder match', () => {
    writeFile('alice-assistant/manifest.json', JSON.stringify({ name: 'alice-assistant' }));
    const r = resolveAgentToFolder('alice-assistant');
    expect(r.folder).toBe('alice-assistant');
    expect(r.error).toBeUndefined();
  });

  it('resolves alias (manifest.name) to folder', () => {
    writeFile('agent-a1b2c3/manifest.json', JSON.stringify({ name: 'alice-assistant' }));
    const r = resolveAgentToFolder('alice-assistant');
    expect(r.folder).toBe('agent-a1b2c3');
  });

  it('resolves a:<pubkey>@<issuer> address by pubkey', () => {
    writeManifest('my-agent', { name: 'my-agent', pubkey: 'c9d699eddf0096ec' });
    const r = resolveAgentToFolder('a:c9d699eddf0096ec@srv');
    expect(r.folder).toBe('my-agent');
  });

  it('resolves a:<pubkey> without @issuer', () => {
    writeManifest('my-agent', { name: 'my-agent', pubkey: 'c9d699eddf0096ec' });
    const r = resolveAgentToFolder('a:c9d699eddf0096ec');
    expect(r.folder).toBe('my-agent');
  });

  it('errors on no match', () => {
    writeManifest('my-agent', { name: 'my-agent', pubkey: 'xyz' });
    const r = resolveAgentToFolder('nonexistent');
    expect(r.folder).toBeUndefined();
    expect(r.error).toContain('No agent matches');
  });

  it('errors on ambiguous alias collision', () => {
    writeManifest('folder-a', { name: 'assistant', pubkey: 'aa' });
    writeManifest('folder-b', { name: 'assistant', pubkey: 'bb' });
    const r = resolveAgentToFolder('assistant');
    expect(r.folder).toBeUndefined();
    expect(r.error).toContain('Ambiguous');
    expect(r.error).toContain('folder-a');
    expect(r.error).toContain('folder-b');
  });

  it('prefers folder match over alias collision', () => {
    // Folder `assistant` exists AND another agent aliases itself `assistant`.
    // Folder match wins (unambiguous by filesystem).
    writeManifest('assistant', { name: 'different-name' });
    writeManifest('other-folder', { name: 'assistant' });
    const r = resolveAgentToFolder('assistant');
    expect(r.folder).toBe('assistant');
  });

  it('skips dotfolders', () => {
    // .design-manager should NOT be considered an agent — no manifest.
    writeManifest('real-agent', { name: 'real-agent' });
    fs.mkdirSync(path.join(TMP_ROOT, '.design-manager', 'view'), { recursive: true });
    const r = resolveAgentToFolder('real-agent');
    expect(r.folder).toBe('real-agent');
  });

  it('skips folders without a manifest when searching by alias', () => {
    fs.mkdirSync(path.join(TMP_ROOT, 'orphan-folder'), { recursive: true });
    writeManifest('real-agent', { name: 'my-alias' });
    const r = resolveAgentToFolder('my-alias');
    expect(r.folder).toBe('real-agent');
  });
});

describe('readIdentity', () => {
  beforeEach(cleanRoot);

  it('returns alias + address from manifest', () => {
    writeManifest('my-agent', { name: 'pretty-name', pubkey: 'c9d6' });
    const id = readIdentity('my-agent', 'srv');
    expect(id.alias).toBe('pretty-name');
    expect(id.address).toBe('a:c9d6@srv');
  });

  it('returns partial identity when pubkey missing', () => {
    writeManifest('my-agent', { name: 'pretty-name' });
    const id = readIdentity('my-agent', 'srv');
    expect(id.alias).toBe('pretty-name');
    expect(id.address).toBeUndefined();
  });

  it('returns empty object when manifest unreadable', () => {
    fs.mkdirSync(path.join(TMP_ROOT, 'no-manifest'), { recursive: true });
    const id = readIdentity('no-manifest', 'srv');
    expect(id).toEqual({});
  });

  it('omits issuer when not supplied', () => {
    writeManifest('my-agent', { name: 'n', pubkey: 'abcd' });
    const id = readIdentity('my-agent');
    expect(id.address).toBe('a:abcd');
  });
});

describe('initializeViewDir', () => {
  beforeEach(cleanRoot);

  it('writes summary files for DM (blueprint only)', () => {
    writeManifest('agent-a', { name: 'agent-a', pubkey: 'aaa' });
    writeFile('agent-a/blueprint/prompt.md', 'You are A.');
    writeFile('agent-a/config/agent.json', '{"model":"sonnet"}');

    const { written, total } = initializeViewDir('design-manager');
    expect(total).toBe(1); // blueprint only for DM
    expect(written).toBe(1);

    const viewDir = viewDirForConsole('design-manager');
    const files = fs.readdirSync(viewDir);
    expect(files).toContain('agent-a.blueprint.md');
    expect(files).not.toContain('agent-a.config.md'); // DM doesn't read config

    const content = fs.readFileSync(path.join(viewDir, 'agent-a.blueprint.md'), 'utf-8');
    expect(content).toContain('# blueprint — agent-a');
    expect(content).toContain('alias: agent-a');
    expect(content).toContain('address: a:aaa');
    expect(content).toContain('You are A.');
  });

  it('writes blueprint + config for CM', () => {
    writeManifest('agent-b', { name: 'agent-b' });
    writeFile('agent-b/blueprint/prompt.md', 'B');
    writeFile('agent-b/config/agent.json', '{}');

    const { written, total } = initializeViewDir('config-manager');
    expect(total).toBe(2);
    expect(written).toBe(2);

    const viewDir = viewDirForConsole('config-manager');
    expect(fs.readdirSync(viewDir).sort()).toEqual(['agent-b.blueprint.md', 'agent-b.config.md']);
  });

  it('skips dotfolders', () => {
    writeManifest('real', { name: 'real' });
    writeFile('real/blueprint/prompt.md', 'R');
    fs.mkdirSync(path.join(TMP_ROOT, '.design-manager'), { recursive: true });

    const { total } = initializeViewDir('design-manager');
    expect(total).toBe(1); // just `real`, not `.design-manager`
  });

  it('is idempotent — second run writes zero new files', () => {
    writeManifest('a', { name: 'a' });
    writeFile('a/blueprint/prompt.md', 'content');

    const first = initializeViewDir('design-manager');
    expect(first.written).toBe(1);

    const second = initializeViewDir('design-manager');
    expect(second.written).toBe(0); // content hash unchanged
    expect(second.total).toBe(1);
  });

  it('scales to 25 agents × 2 surfaces for CM (50 summaries, all above the old ceiling)', () => {
    // 4B.6 verification — the scale claim is that CM can now hold a roster
    // past the old 22-mount VirtIO-FS ceiling. We don't exercise the real
    // container here, but confirm the summary-generation pipeline handles
    // 25 agents without error, writes the expected filename set, and picks
    // up identity metadata from each manifest.
    for (let i = 0; i < 25; i++) {
      const folder = `agent-${String(i).padStart(2, '0')}`;
      writeManifest(folder, { name: `alias-${i}`, pubkey: `pk${i}` });
      writeFile(`${folder}/blueprint/prompt.md`, `prompt ${i}`);
      writeFile(`${folder}/config/agent.json`, `{"model":"sonnet-${i}"}`);
    }

    const { written, total } = initializeViewDir('config-manager');
    expect(total).toBe(50); // 25 agents × 2 surfaces (blueprint, config)
    expect(written).toBe(50);

    const viewDir = viewDirForConsole('config-manager');
    const files = fs.readdirSync(viewDir).sort();
    expect(files).toHaveLength(50);
    // Every summary file keys on folder, pairs blueprint + config.
    expect(files.filter((f) => f.endsWith('.blueprint.md'))).toHaveLength(25);
    expect(files.filter((f) => f.endsWith('.config.md'))).toHaveLength(25);

    // Spot-check one summary picks up identity metadata from its manifest.
    const sample = fs.readFileSync(path.join(viewDir, 'agent-05.blueprint.md'), 'utf-8');
    expect(sample).toContain('folder: agent-05');
    expect(sample).toContain('alias: alias-5');
    expect(sample).toContain('address: a:pk5');
  });

  it('rewrites when content changes', () => {
    writeManifest('a', { name: 'a' });
    writeFile('a/blueprint/prompt.md', 'v1');
    initializeViewDir('design-manager');

    writeFile('a/blueprint/prompt.md', 'v2-changed');
    const r = initializeViewDir('design-manager');
    expect(r.written).toBe(1);

    const content = fs.readFileSync(
      path.join(viewDirForConsole('design-manager'), 'a.blueprint.md'),
      'utf-8',
    );
    expect(content).toContain('v2-changed');
    expect(content).not.toContain('===== FILE: prompt.md =====\nv1');
  });
});

describe('maintainViewDir', () => {
  beforeEach(cleanRoot);

  it('on added: writes summary files for new agent', () => {
    writeManifest('new-agent', { name: 'new-agent' });
    writeFile('new-agent/blueprint/prompt.md', 'p');

    maintainViewDir('design-manager', { kind: 'added', folder: 'new-agent' });

    const viewDir = viewDirForConsole('design-manager');
    expect(fs.existsSync(path.join(viewDir, 'new-agent.blueprint.md'))).toBe(true);
  });

  it('on removed: deletes summary files', () => {
    writeManifest('to-remove', { name: 'to-remove' });
    writeFile('to-remove/blueprint/prompt.md', 'p');
    initializeViewDir('design-manager');

    const viewDir = viewDirForConsole('design-manager');
    expect(fs.existsSync(path.join(viewDir, 'to-remove.blueprint.md'))).toBe(true);

    maintainViewDir('design-manager', { kind: 'removed', folder: 'to-remove' });
    expect(fs.existsSync(path.join(viewDir, 'to-remove.blueprint.md'))).toBe(false);
  });

  it('on removed: deletes all surface files for CM', () => {
    writeManifest('cm-agent', { name: 'cm-agent' });
    writeFile('cm-agent/blueprint/prompt.md', 'p');
    writeFile('cm-agent/config/agent.json', '{}');
    initializeViewDir('config-manager');

    const viewDir = viewDirForConsole('config-manager');
    expect(fs.existsSync(path.join(viewDir, 'cm-agent.blueprint.md'))).toBe(true);
    expect(fs.existsSync(path.join(viewDir, 'cm-agent.config.md'))).toBe(true);

    maintainViewDir('config-manager', { kind: 'removed', folder: 'cm-agent' });
    expect(fs.existsSync(path.join(viewDir, 'cm-agent.blueprint.md'))).toBe(false);
    expect(fs.existsSync(path.join(viewDir, 'cm-agent.config.md'))).toBe(false);
  });

  it('on removed: no error when file already gone', () => {
    expect(() =>
      maintainViewDir('design-manager', { kind: 'removed', folder: 'never-existed' }),
    ).not.toThrow();
  });

  it('on added: creates view dir if missing', () => {
    writeManifest('agent', { name: 'agent' });
    writeFile('agent/blueprint/prompt.md', 'p');

    // view dir doesn't exist yet — maintainViewDir must mkdir it
    expect(fs.existsSync(viewDirForConsole('design-manager'))).toBe(false);

    maintainViewDir('design-manager', { kind: 'added', folder: 'agent' });
    expect(fs.existsSync(path.join(viewDirForConsole('design-manager'), 'agent.blueprint.md'))).toBe(true);
  });
});

describe('viewDirForConsole', () => {
  it('returns .<console>/view/ path', () => {
    expect(viewDirForConsole('design-manager')).toBe(path.join(TMP_ROOT, '.design-manager', 'view'));
    expect(viewDirForConsole('config-manager')).toBe(path.join(TMP_ROOT, '.config-manager', 'view'));
    expect(viewDirForConsole('security-manager')).toBe(path.join(TMP_ROOT, '.security-manager', 'view'));
  });
});
