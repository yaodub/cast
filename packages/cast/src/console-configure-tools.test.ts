/**
 * Unit tests for Configure console tools.
 *
 * Covers the six `configure__*` handlers + the `revokePairedUser` helper +
 * the `listExtensionSecrets` helper. Uses a tmpdir-backed mock for
 * `agentPath` so filesystem state stays isolated per test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { z } from 'zod';

const { TMP_ROOT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require('path') as typeof import('path');
  return { TMP_ROOT: fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'cast-configure-tools-')) };
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    agentPath: (folder: string, ...segments: string[]) =>
      path.join(TMP_ROOT, folder, ...segments),
  };
});

// The registry pulls from a module-level Map. Registering the same extension
// twice throws, so we use `beforeEach` with a fresh name per test.
import {
  handleValidate,
  handleListParticipants,
  handleListExtensionSecrets,
  handlePairUser,
  handleRevokeUser,
} from './console/configure/tools.js';
import { readPairedUsers, writePairedUsers } from './auth/pairing.js';

/**
 * Per-test revoke stub. Mirrors `AgentManager.unpair()` minus the bus
 * emit (we're testing the Configure MCP handler's changelog/error
 * behavior here, not the bus signal). Replaces the deleted free
 * function `revokePairedUser`.
 */
function revokeViaFile(folder: string, identityId: string): { ok: boolean; error?: string } {
  const users = readPairedUsers(folder);
  if (!(identityId in users)) {
    return { ok: false, error: `No paired user with identity \`${identityId}\`.` };
  }
  delete users[identityId];
  writePairedUsers(folder, users);
  return { ok: true };
}
import { listExtensionSecrets } from './extensions/list-secrets.js';
import { registerExtension } from './extensions/registry.js';
import { _setMockWatcher } from './lib/config-reader.js';
import type { ConsoleMcpContext, ConsoleMcpDeps } from './console/strategy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A cheap in-memory watcher stub — readJson() inside the registry calls this. */
class InMemoryWatcher {
  private files = new Map<string, string>();
  set(filePath: string, content: string): void { this.files.set(filePath, content); }
  get(filePath: string): string | null {
    if (this.files.has(filePath)) return this.files.get(filePath)!;
    try { return fs.readFileSync(filePath, 'utf-8'); } catch { return null; }
  }
}

function setupWatcher(): InMemoryWatcher {
  const w = new InMemoryWatcher();
  _setMockWatcher(w);
  return w;
}

function ctx(hostFolder: string, participant = 'local'): ConsoleMcpContext {
  return {
    hostFolder,
    agentId: `a:${hostFolder}@test`,
    participant,
    channelName: '__configure',
    consoleName: 'configure',
  };
}

function firstText(result: { content: { type: string; text: string }[] }): string {
  const first = result.content[0];
  if (!first || first.type !== 'text') return '';
  return first.text;
}

/**
 * Write the smallest fixture that passes validate: manifest + identity files.
 * The unified validator checks identity-file presence, so the older
 * "manifest only" fixture would now report two problems.
 */
function writeMinimalAgent(folder: string): void {
  const idDir = path.join(TMP_ROOT, folder, 'blueprint', 'identity');
  fs.mkdirSync(idDir, { recursive: true });
  fs.writeFileSync(
    path.join(TMP_ROOT, folder, 'manifest.json'),
    JSON.stringify({ name: 'test', spec: '1', pubkey: 'abc' }),
  );
  fs.writeFileSync(path.join(idDir, 'whoami.md'), 'A test agent.');
  fs.writeFileSync(path.join(idDir, 'prompt.md'), 'You are a test agent.');
}

function readChangelog(folder: string): Record<string, unknown>[] {
  const p = path.join(TMP_ROOT, folder, 'state', 'admin-changelog.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').trimEnd().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

beforeEach(() => {
  for (const entry of fs.readdirSync(TMP_ROOT)) {
    fs.rmSync(path.join(TMP_ROOT, entry), { recursive: true, force: true });
  }
  setupWatcher();
});

// ---------------------------------------------------------------------------
// handleValidate
// ---------------------------------------------------------------------------

describe('handleValidate', () => {
  it('passes on an agent with valid manifest + identity files + no config files', () => {
    const folder = 'v-ok';
    writeMinimalAgent(folder);

    const result = handleValidate(folder);
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toContain('Validation **passed**');
  });

  it('fails when config/mcp-servers.json is malformed JSON', () => {
    const folder = 'v-bad';
    writeMinimalAgent(folder);
    const cfgDir = path.join(TMP_ROOT, folder, 'config');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'mcp-servers.json'), '{ not json }');

    const result = handleValidate(folder);
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('Validation **failed**');
    expect(firstText(result)).toContain('mcp-servers.json');
  });

  it('fails when a required resource slot has no host path bound', () => {
    const folder = 'v-missing-required';
    writeMinimalAgent(folder);
    const propsDir = path.join(TMP_ROOT, folder, 'blueprint', 'props');
    fs.mkdirSync(propsDir, { recursive: true });
    fs.writeFileSync(
      path.join(propsDir, 'capabilities.json'),
      JSON.stringify({
        resources: {
          codebase: { description: 'src tree', access: 'ro', required: true },
          notes: { description: 'optional notes', access: 'ro', required: false },
        },
      }),
    );

    const result = handleValidate(folder);
    expect(result.isError).toBe(true);
    const text = firstText(result);
    expect(text).toContain('Validation **failed**');
    expect(text).toContain('codebase');
    expect(text).toContain('required resource');
    // optional slot must not be flagged as a problem; it can appear in the passes list
    // but never as a problem line — assert on the problems section explicitly.
    const problemsSection = text.split('warning')[0] ?? text;
    expect(problemsSection).not.toContain('notes');
  });

  it('passes when all required resource slots are bound', () => {
    const folder = 'v-required-bound';
    writeMinimalAgent(folder);
    const propsDir = path.join(TMP_ROOT, folder, 'blueprint', 'props');
    const cfgDir = path.join(TMP_ROOT, folder, 'config');
    fs.mkdirSync(propsDir, { recursive: true });
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(
      path.join(propsDir, 'capabilities.json'),
      JSON.stringify({
        resources: {
          codebase: { description: 'src tree', access: 'ro', required: true },
        },
      }),
    );
    fs.writeFileSync(
      path.join(cfgDir, 'provisions.json'),
      JSON.stringify({ resources: { codebase: '/tmp/some/path' } }),
    );

    const result = handleValidate(folder);
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toContain('Validation **passed**');
  });
});

// ---------------------------------------------------------------------------
// handleListParticipants
// ---------------------------------------------------------------------------

describe('handleListParticipants', () => {
  it('reports empty list cleanly', () => {
    const folder = 'lp-empty';
    const deps: ConsoleMcpDeps = {
      getAgentDb: () => ({ getAllParticipants: () => [] }) as never,
    };
    const result = handleListParticipants(folder, deps);
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toContain('No participants');
  });

  it('enriches participants with roster display names', () => {
    const folder = 'lp-enriched';
    fs.mkdirSync(path.join(TMP_ROOT, folder, 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(TMP_ROOT, folder, 'state', 'identity-roster.json'),
      JSON.stringify({
        'u:abc@srv': { name: 'Alice', handles: ['tg:111'] },
      }),
    );

    const deps: ConsoleMcpDeps = {
      getAgentDb: () => ({
        getAllParticipants: () => [
          { address: 'u:abc@srv/tg:111', last_active: '2026-04-21T10:00:00Z' },
          { address: 'u:xyz@srv/tg:222', last_active: '2026-04-21T09:00:00Z' },
        ],
      }) as never,
    };
    const result = handleListParticipants(folder, deps);
    expect(result.isError).toBeFalsy();
    const text = firstText(result);
    expect(text).toContain('2 participants');
    expect(text).toContain('Alice');
    expect(text).toContain('(no display name)');
  });

  it('reports unavailability if getAgentDb is missing', () => {
    const folder = 'lp-nodb';
    const result = handleListParticipants(folder, {});
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('unavailable');
  });
});

// ---------------------------------------------------------------------------
// handleListExtensionSecrets
// ---------------------------------------------------------------------------

describe('handleListExtensionSecrets', () => {
  it('formats the deps list grouped by extension', () => {
    const deps: ConsoleMcpDeps = {
      listExtensionSecrets: () => [
        { extension: 'email', key: 'EMAIL_ADDRESS', isSet: true },
        { extension: 'email', key: 'EMAIL_PASSWORD', isSet: false },
        { extension: 'x', key: 'TOKEN', isSet: false },
      ],
    };
    const result = handleListExtensionSecrets(deps);
    expect(result.isError).toBeFalsy();
    const text = firstText(result);
    expect(text).toContain('**email** — 1/2 set');
    expect(text).toContain('✓ set');
    expect(text).toContain('✗ missing');
    expect(text).toContain('**x** — 0/1 set');
  });

  it('reports no-extensions case cleanly', () => {
    const deps: ConsoleMcpDeps = { listExtensionSecrets: () => [] };
    const result = handleListExtensionSecrets(deps);
    expect(firstText(result)).toContain('No extensions');
  });
});

// ---------------------------------------------------------------------------
// handlePairUser
// ---------------------------------------------------------------------------

describe('handlePairUser', () => {
  it('returns a code and writes a changelog entry', () => {
    const folder = 'pu-ok';
    const deps: ConsoleMcpDeps = { pairUser: () => '123456' };
    const result = handlePairUser(ctx(folder), deps, 'tg:12345', 'Sam can message content-writer on the default channel');
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toContain('123456');
    expect(firstText(result)).toContain('/pair 123456');
    expect(firstText(result)).toContain('Sam can message content-writer');

    const log = readChangelog(folder);
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe('pair_user');
    expect(log[0].handle).toBe('tg:12345');
    expect(log[0].code).toBe('123456');
    expect(log[0].actor).toBe('local');
    expect(log[0].accessScope).toBe('Sam can message content-writer on the default channel');
  });

  it('fails cleanly if deps.pairUser throws', () => {
    const folder = 'pu-fail';
    const deps: ConsoleMcpDeps = { pairUser: () => { throw new Error('boom'); } };
    const result = handlePairUser(ctx(folder), deps, 'tg:1', 'scope test');
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('Failed');

    expect(readChangelog(folder)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleRevokeUser + revokePairedUser helper
// ---------------------------------------------------------------------------

describe('handleRevokeUser', () => {
  it('succeeds when the identity is paired, writes changelog', () => {
    const folder = 'ru-ok';
    fs.mkdirSync(path.join(TMP_ROOT, folder, 'state'), { recursive: true });
    fs.writeFileSync(
      path.join(TMP_ROOT, folder, 'state', 'paired-users.json'),
      JSON.stringify({ 'u:abc@srv': { '*': 'io' } }),
    );

    const deps: ConsoleMcpDeps = { revokeUser: (id) => revokeViaFile(folder, id) };
    const result = handleRevokeUser(ctx(folder), deps, 'u:abc@srv');
    expect(result.isError).toBeFalsy();
    expect(firstText(result)).toContain('Revoked paired user');

    const raw = fs.readFileSync(path.join(TMP_ROOT, folder, 'state', 'paired-users.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual({});
    expect(readChangelog(folder)[0].action).toBe('revoke_user');
    expect(readChangelog(folder)[0].identityId).toBe('u:abc@srv');
  });

  it('errors when the identity is not paired, no changelog entry', () => {
    const folder = 'ru-missing';
    const deps: ConsoleMcpDeps = { revokeUser: (id) => revokeViaFile(folder, id) };
    const result = handleRevokeUser(ctx(folder), deps, 'u:ghost@srv');
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('No paired user');
    expect(readChangelog(folder)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// listExtensionSecrets helper
// ---------------------------------------------------------------------------

describe('listExtensionSecrets helper', () => {
  it('detects set vs missing keys for a registered extension', async () => {
    // Register a fake extension once for this test file's lifetime. The
    // module-level registry throws on duplicate names, so the unique name
    // ensures no collision with other test files that might register.
    const extName = 'test-ext-cfgtools';
    const { defineExtension } = await import('@getcast/extension-schema');
    const fakeExt = defineExtension({
      name: extName,
      configSchema: z.object({}),
      secretsSchema: z.object({ API_KEY: z.string(), OPT: z.string().optional() }),
      create: () => ({ tools: [] } as never),
    });
    try { registerExtension(fakeExt); } catch { /* already registered in a prior test run */ }

    const folder = 'les-ext';
    const secretsDir = path.join(TMP_ROOT, folder, 'config', 'ext', extName);
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(
      path.join(secretsDir, 'secrets.json'),
      JSON.stringify({ API_KEY: 'secret-value' }) + '\n',
    );

    const result = listExtensionSecrets(folder);
    const forExt = result.filter((r) => r.extension === extName);
    expect(forExt).toContainEqual({ extension: extName, key: 'API_KEY', isSet: true });
    expect(forExt).toContainEqual({ extension: extName, key: 'OPT', isSet: false });
  });
});
