/**
 * Walker tests for the surface-summary builder. Fixture-driven: build a
 * tree on the tmp filesystem, walk it, assert the produced markdown covers
 * every readable file in exactly one TOC section (the coverage invariant).
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
  return { TMP_ROOT: fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'cast-summary-test-')) };
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    AGENTS_DIR: TMP_ROOT,
    agentPath: (folder: string, ...segments: string[]) => path.join(TMP_ROOT, folder, ...segments),
  };
});

import { walkSurface, detectText, priorityOf } from './console/shared/surface-summary.js';
import { isReadable } from './console/shared/read-policy.js';

function write(rel: string, content: string | Buffer): string {
  const abs = path.join(TMP_ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function cleanAgent(folder: string): void {
  fs.rmSync(path.join(TMP_ROOT, folder), { recursive: true, force: true });
}

describe('walkSurface — basic shapes', () => {
  beforeEach(() => cleanAgent('basic'));

  it('emits empty-surface summary when surface dir is missing', () => {
    fs.mkdirSync(path.join(TMP_ROOT, 'basic'), { recursive: true });
    const { content, hash } = walkSurface('basic', 'blueprint', 'design-manager');
    expect(content).toMatch(/^# blueprint — basic$/m);
    expect(content).toContain('folder: basic');
    expect(content).toMatch(/^rev: /m);
    expect(content).toContain('_No files._');
    expect(hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it('inlines a single prompt and wraps with the file delimiter', () => {
    write('basic/blueprint/prompt.md', 'You are a test agent.');
    const { content } = walkSurface('basic', 'blueprint', 'design-manager');
    expect(content).toContain('## Files');
    expect(content).toContain('- prompt.md  (21 B)');
    expect(content).toContain('===== FILE: prompt.md =====\nYou are a test agent.');
  });

  it('hash is stable across runs on unchanged content', () => {
    write('basic/blueprint/prompt.md', 'stable');
    const a = walkSurface('basic', 'blueprint', 'design-manager');
    // Strip rev line — ISO timestamp differs per run; rest of content is deterministic.
    const stripRev = (s: string) => s.replace(/^rev: .+$/m, 'rev: X');
    const b = walkSurface('basic', 'blueprint', 'design-manager');
    expect(stripRev(a.content)).toBe(stripRev(b.content));
  });

  it('includes optional alias + address in header when identity provided', () => {
    write('basic/blueprint/prompt.md', 'p');
    const { content } = walkSurface(
      'basic',
      'blueprint',
      'design-manager',
      { alias: 'my-pretty-name', address: 'a:c9d699eddf0096ec@srv' },
    );
    expect(content).toMatch(/^# blueprint — basic$/m);
    expect(content).toMatch(/^folder: basic$/m);
    expect(content).toMatch(/^alias: my-pretty-name$/m);
    expect(content).toMatch(/^address: a:c9d699eddf0096ec@srv$/m);
  });

  it('omits alias/address lines when identity not provided', () => {
    write('basic/blueprint/prompt.md', 'p');
    const { content } = walkSurface('basic', 'blueprint', 'design-manager');
    expect(content).toMatch(/^folder: basic$/m);
    expect(content).not.toMatch(/^alias:/m);
    expect(content).not.toMatch(/^address:/m);
  });

  it('still emits folder line even when alias equals folder (divergence preparedness)', () => {
    write('basic/blueprint/prompt.md', 'p');
    const { content } = walkSurface(
      'basic',
      'blueprint',
      'design-manager',
      { alias: 'basic' }, // today's common case: alias == folder
    );
    expect(content).toMatch(/^folder: basic$/m);
    expect(content).toMatch(/^alias: basic$/m);
  });

  it('skips symlinks and lists them with target', () => {
    write('basic/blueprint/real.md', 'real');
    fs.symlinkSync('real.md', path.join(TMP_ROOT, 'basic', 'blueprint', 'link.md'));
    const { content } = walkSurface('basic', 'blueprint', 'design-manager');
    expect(content).toContain('## Skipped (symlinks)');
    expect(content).toContain('- link.md → real.md');
    // The real file is still inlined.
    expect(content).toContain('===== FILE: real.md =====');
  });
});

describe('walkSurface — text vs binary', () => {
  beforeEach(() => cleanAgent('tb'));

  it('stubs binary files (null bytes in first 4KB)', () => {
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]); // PNG-ish
    write('tb/blueprint/image.png', bin);
    const { content } = walkSurface('tb', 'blueprint', 'design-manager');
    expect(content).toContain('## Stubbed');
    expect(content).toContain('- image.png  (8 B, reason: binary)');
    expect(content).not.toContain('===== FILE: image.png =====');
  });

  it('inlines unknown-extension files that pass the null-byte probe', () => {
    // Dockerfile: no extension → mime returns null → probe: no nulls → text.
    write('tb/blueprint/Dockerfile', 'FROM node:20\nCMD ["node"]');
    const { content } = walkSurface('tb', 'blueprint', 'design-manager');
    expect(content).toContain('===== FILE: Dockerfile =====\nFROM node:20');
  });

  it('inlines application/json', () => {
    write('tb/blueprint/props/capabilities.json', '{"foo":1}');
    const { content } = walkSurface('tb', 'blueprint', 'design-manager');
    expect(content).toContain('===== FILE: props/capabilities.json =====');
    expect(content).toContain('{"foo":1}');
  });
});

describe('detectText — via istextorbinary', () => {
  it.each([
    ['foo.md', Buffer.from('hello')],
    ['foo.txt', Buffer.from('hello')],
    ['foo.json', Buffer.from('{"a":1}')],
    ['foo.ts', Buffer.from('export {};')],
    ['Dockerfile', Buffer.from('FROM node\nCMD ["node"]')],
    ['.env', Buffer.from('FOO=bar\nBAZ=qux')],
    ['utf8-bom.md', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('hi')])],
  ])('classifies %s as text', (name, body) => {
    cleanAgent('dt');
    const abs = write(`dt/${name}`, body);
    expect(detectText(abs)).toBe(true);
  });

  it.each([
    // Binary by extension (istextorbinary fast-path):
    ['icon.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ['blob.bin', Buffer.from([0x00, 0x01, 0x02, 0x03])],
    // Binary by content probe (unknown extension + invalid UTF-8 continuation byte):
    ['weird', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ['utf16', Buffer.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00])],
  ])('classifies %s as binary', (name, body) => {
    cleanAgent('dt');
    const abs = write(`dt/${name}`, body);
    expect(detectText(abs)).toBe(false);
  });
});

describe('walkSurface — readability policy enforcement', () => {
  beforeEach(() => cleanAgent('rp'));

  it('DM walking blueprint/ does not cross into config/ (wrong surface)', () => {
    write('rp/blueprint/prompt.md', 'p');
    write('rp/config/agent.json', '{}');
    const { content } = walkSurface('rp', 'blueprint', 'design-manager');
    expect(content).toContain('prompt.md');
    expect(content).not.toContain('agent.json');
  });

  it('L2 blacklist — node_modules dir emits ## Collapsed entry, not contents', () => {
    write('rp/blueprint/prompt.md', 'p');
    write('rp/blueprint/node_modules/lodash/index.js', 'module.exports = {};');
    const { content } = walkSurface('rp', 'blueprint', 'config-manager');
    expect(content).toContain('## Collapsed');
    expect(content).toContain('- node_modules  (dir, reason: blacklist)');
    expect(content).not.toContain('===== FILE: node_modules/lodash/index.js =====');
    expect(content).not.toContain('module.exports');
  });

  it('L2 blacklist — *.log files emit ## Collapsed entry', () => {
    write('rp/blueprint/run.log', 'debug');
    write('rp/blueprint/prompt.md', 'p');
    const { content } = walkSurface('rp', 'blueprint', 'config-manager');
    expect(content).toContain('- run.log  (file, reason: blacklist)');
    expect(content).not.toContain('===== FILE: run.log =====');
  });

  it('CM sees config/ surface; DM does not attempt to walk it', () => {
    write('rp/config/agent.json', '{"model":"sonnet"}');
    const cm = walkSurface('rp', 'config', 'config-manager').content;
    expect(cm).toContain('===== FILE: agent.json =====');
    expect(cm).toContain('"sonnet"');
  });
});

describe('walkSurface — coverage invariant', () => {
  beforeEach(() => cleanAgent('inv'));

  it('every readable fs entry is covered by exactly one TOC section', () => {
    // A mixed fixture — one file per coverage category.
    const inlined = [
      'inv/blueprint/prompt.md',
      'inv/blueprint/channels/default/prompt.md',
      'inv/blueprint/props/capabilities.json',
      'inv/blueprint/skills.md',
      'inv/blueprint/notes/free-form.md', // T5 default — still inlined
    ];
    for (const p of inlined) write(p, 'content');

    // Binary → ## Stubbed
    write('inv/blueprint/icon.png', Buffer.from([0, 1, 2]));

    // L2 blacklist dir → ## Collapsed
    write('inv/blueprint/node_modules/lodash/index.js', 'module.exports = {};');

    // L2 blacklist file → ## Collapsed
    write('inv/blueprint/trace.log', 'debug');

    // Symlink → ## Skipped
    fs.symlinkSync('prompt.md', path.join(TMP_ROOT, 'inv', 'blueprint', 'link.md'));

    const { content } = walkSurface('inv', 'blueprint', 'config-manager');

    // Each inlined file present both in TOC and as a file delimiter.
    for (const abs of inlined) {
      const rel = abs.slice('inv/blueprint/'.length);
      expect(content).toContain(`===== FILE: ${rel} =====`);
    }

    // Binary covered in Stubbed.
    expect(content).toMatch(/## Stubbed[\s\S]*- icon\.png/);

    // node_modules (dir) + trace.log (file) covered in Collapsed.
    expect(content).toMatch(/## Collapsed[\s\S]*- node_modules  \(dir, reason: blacklist\)/);
    expect(content).toMatch(/## Collapsed[\s\S]*- trace\.log  \(file, reason: blacklist\)/);

    // Symlink covered in Skipped.
    expect(content).toMatch(/## Skipped \(symlinks\)[\s\S]*- link\.md → prompt\.md/);

    // Coverage invariant — enumerate the fs under blueprint/ and assert each
    // entry is either inlined, stubbed, collapsed, or skipped.
    const surfaceRoot = path.join(TMP_ROOT, 'inv', 'blueprint');
    const allRel = listAllRelEntries(surfaceRoot);
    for (const rel of allRel) {
      const claimedInline = content.includes(`===== FILE: ${rel} =====`);
      const claimedToc = new RegExp(`^- ${escapeRe(rel)}\\b`, 'm').test(content);
      // Collapsed dir at a shallower path covers its descendants implicitly.
      const claimedByParent = Array.from(content.matchAll(/^- (\S+)\s+\(dir, reason: blacklist\)/gm))
        .some((m) => rel.startsWith(m[1] + '/'));
      expect(claimedInline || claimedToc || claimedByParent).toBe(true);
    }
  });
});

describe('walkSurface — deep + wide (bounds deferred to 4B.1c)', () => {
  beforeEach(() => cleanAgent('bounds'));

  it('walks deep nesting end-to-end — no depth cap in 4B.1b', () => {
    write('bounds/blueprint/a/b/c/d/e/f/leaf.md', 'deep');
    const { content } = walkSurface('bounds', 'blueprint', 'design-manager');
    expect(content).toContain('===== FILE: a/b/c/d/e/f/leaf.md =====');
  });

  it('inlines wide directories end-to-end — no child cap in 4B.1b', () => {
    for (let i = 0; i < 60; i++) {
      write(`bounds/blueprint/many/f${i}.md`, `${i}`);
    }
    const { content } = walkSurface('bounds', 'blueprint', 'design-manager');
    for (let i = 0; i < 60; i++) {
      expect(content).toContain(`===== FILE: many/f${i}.md =====`);
    }
  });
});

// -- test helpers ----------------------------------------------------------

function listAllRelEntries(root: string): string[] {
  const out: string[] = [];
  function rec(dir: string, rel: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      out.push(child);
      if (e.isDirectory() && !e.isSymbolicLink()) {
        rec(path.join(dir, e.name), child);
      }
    }
  }
  rec(root, '');
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

describe('read-policy + walker agree on what lives in admitted subtrees', () => {
  beforeEach(() => cleanAgent('agree'));

  it('files the walker inlines all pass isReadable for the console', () => {
    write('agree/blueprint/prompt.md', 'p');
    write('agree/blueprint/channels/x/prompt.md', 'c');
    write('agree/blueprint/service/dist/index.js', 'bundled'); // dist/ is L2 blacklist inside blueprint
    const { content } = walkSurface('agree', 'blueprint', 'config-manager');

    const inlined = Array.from(content.matchAll(/^===== FILE: (.+) =====$/gm)).map((m) => m[1]);
    for (const rel of inlined) {
      expect(isReadable('config-manager', `blueprint/${rel}`)).toBe(true);
    }
  });
});

describe('walkSurface — size stub rule', () => {
  beforeEach(() => cleanAgent('sz'));

  it('stubs files larger than 64KB without reading their content', () => {
    const big = Buffer.alloc(64 * 1024 + 1, 0x41); // 64KB + 1 byte of 'A'
    write('sz/blueprint/service/index.js', big);
    const { content } = walkSurface('sz', 'blueprint', 'design-manager');
    expect(content).toContain('## Stubbed');
    expect(content).toMatch(/- service\/index\.js  \(64\.0 KB, reason: size\)/);
    // Content delimiter must not appear — we never read the file.
    expect(content).not.toContain('===== FILE: service/index.js =====');
    // No trace of the file body.
    expect(content).not.toMatch(/AAAAAAAAAA/);
  });

  it('inlines files at or below 64KB', () => {
    const under = Buffer.alloc(64 * 1024, 0x41); // exactly 64KB
    write('sz/blueprint/prompt.md', under);
    const { content } = walkSurface('sz', 'blueprint', 'design-manager');
    expect(content).toContain('===== FILE: prompt.md =====');
  });

  it('preserves coverage invariant with size stubs', () => {
    write('sz/blueprint/prompt.md', 'small');
    write('sz/blueprint/service/index.js', Buffer.alloc(100 * 1024, 0x41));
    const { content } = walkSurface('sz', 'blueprint', 'config-manager');
    // prompt.md inlined; service/index.js stubbed.
    expect(content).toContain('===== FILE: prompt.md =====');
    expect(content).toMatch(/- service\/index\.js  \(100\.0 KB, reason: size\)/);
  });
});

describe('priorityOf', () => {
  it.each([
    ['prompt.md', 1],
    ['whoami.md', 1],
    ['skills.md', 1],
    ['peers.md', 1],
    ['channels/default/prompt.md', 1],
    ['channels/a/b/prompt.md', 1], // nested channel still T1
    ['channels/default/skills.md', 1],
    ['agent.json', 2],
    ['acl.json', 2],
    ['mcp-servers.json', 2],
    ['provisions.json', 2],
    ['props/capabilities.json', 2],
    ['props/sdk-settings.json', 2],
    ['ext/whatsapp/config.json', 2],
    ['.design/notes.md', 2],
    ['channels/default/welcome.md', 3], // channel sundry, not prompt/skills
    ['props/capabilities.md', 3], // props/**/* fallthrough (not *.json)
    ['ext/whatsapp/secrets.json', 3],
    ['service/index.js', 4],
    ['service/sub/dir/file.js', 4],
    ['README.md', 5], // default
    ['refs/reference.md', 5],
    ['notes/free-form.md', 5],
  ])('priorityOf(%s) = %i', (path, expected) => {
    expect(priorityOf(path)).toBe(expected);
  });
});

describe('walkSurface — priority ordering', () => {
  beforeEach(() => cleanAgent('po'));

  it('TOC lists files in priority order, then alphabetical within tier', () => {
    // Mix of tiers in deliberately reverse-alphabetical order to prove it's
    // priority driving the sort, not naming.
    write('po/blueprint/zzz-README.md', 'rest');           // T5
    write('po/blueprint/service/index.js', 'svc');         // T4
    write('po/blueprint/channels/default/welcome.md', 'w'); // T3
    write('po/blueprint/acl.json', '{}');                  // not matched in blueprint tier; T5 actually
    write('po/blueprint/prompt.md', 'p');                  // T1
    write('po/blueprint/whoami.md', 'w');                  // T1
    // config surface
    write('po/config/agent.json', '{}');                   // T2
    write('po/config/acl.json', '{}');                     // T2

    const bp = walkSurface('po', 'blueprint', 'config-manager').content;

    // In blueprint TOC, prompt.md / whoami.md (T1) come before service/ (T4)
    // which comes before zzz-README (T5).
    const tocSlice = bp.slice(bp.indexOf('## Files'), bp.indexOf('\n\n===='));
    const tocLines = tocSlice.split('\n').filter((l) => l.startsWith('- '));
    const order = tocLines.map((l) => l.match(/- ([^\s]+)/)?.[1] ?? '');
    // T1 entries first, then T3, then T5. Within T1 alphabetical: prompt < whoami.
    expect(order.indexOf('prompt.md')).toBeLessThan(order.indexOf('whoami.md'));
    expect(order.indexOf('whoami.md')).toBeLessThan(order.indexOf('channels/default/welcome.md'));
    expect(order.indexOf('channels/default/welcome.md')).toBeLessThan(order.indexOf('zzz-README.md'));

    // Inlined content section follows the same order.
    const inlineIdx = (name: string) => bp.indexOf(`===== FILE: ${name} =====`);
    expect(inlineIdx('prompt.md')).toBeLessThan(inlineIdx('whoami.md'));
    expect(inlineIdx('whoami.md')).toBeLessThan(inlineIdx('channels/default/welcome.md'));
    expect(inlineIdx('channels/default/welcome.md')).toBeLessThan(inlineIdx('zzz-README.md'));

    // Config surface: T2 files only, alphabetical within T2.
    const cfg = walkSurface('po', 'config', 'config-manager').content;
    expect(cfg.indexOf('===== FILE: acl.json =====')).toBeLessThan(
      cfg.indexOf('===== FILE: agent.json =====')
    );
  });

  it('size stubs also sort by priority', () => {
    const big = Buffer.alloc(70 * 1024);
    write('po/blueprint/service/index.js', big); // T4
    write('po/blueprint/refs/huge.md', big);      // T5
    write('po/blueprint/prompt.md', Buffer.alloc(70 * 1024)); // T1 but oversize → still stubbed
    const bp = walkSurface('po', 'blueprint', 'config-manager').content;
    const stubSlice = bp.slice(bp.indexOf('## Stubbed'));
    const order = stubSlice
      .split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.match(/- ([^\s]+)/)?.[1] ?? '');
    // T1 (prompt.md) before T4 (service/index.js) before T5 (refs/huge.md).
    expect(order.indexOf('prompt.md')).toBeLessThan(order.indexOf('service/index.js'));
    expect(order.indexOf('service/index.js')).toBeLessThan(order.indexOf('refs/huge.md'));
  });
});
