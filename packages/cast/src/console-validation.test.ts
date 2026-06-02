/**
 * Unit tests for the shared agent-blueprint validator.
 *
 * Same TMP_ROOT-mocked-agentPath pattern as console-configure-tools.test.ts.
 * One describe per check function; each test writes the minimum fixture
 * needed to exercise that check.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';

const { TMP_ROOT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const osH = require('os') as typeof import('os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pathH = require('path') as typeof import('path');
  return { TMP_ROOT: fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'cast-validation-')) };
});

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    agentPath: (folder: string, ...segments: string[]) =>
      path.join(TMP_ROOT, folder, ...segments),
  };
});

import { validateAgentBlueprint, renderValidationReport } from './console/shared/validation.js';
import { registerExtension } from './extensions/registry.js';

// ---------------------------------------------------------------------------
// Fake extensions registered once for this file's lifetime
// ---------------------------------------------------------------------------

const FAKE_EXT_NAME = 'fake-web-fetch';
const FakeWebFetchSchema = z.object({
  fetch_mode: z.enum(['disabled', 'approval', 'open']).default('approval'),
  allowed_domains: z.array(z.string()).default([]),
});

const FAKE_SECRETS_EXT_NAME = 'fake-with-secrets';
const FakeSecretsSchema = z.object({ API_KEY: z.string().min(1) });

beforeAll(async () => {
  const { defineExtension } = await import('@getcast/extension-schema');
  try {
    registerExtension(defineExtension({
      name: FAKE_EXT_NAME,
      configSchema: FakeWebFetchSchema,
      secretsSchema: z.object({}),
      create: () => ({ tools: [] } as never),
    }));
  } catch { /* already registered in a prior run */ }
  try {
    registerExtension(defineExtension({
      name: FAKE_SECRETS_EXT_NAME,
      configSchema: z.object({}),
      secretsSchema: FakeSecretsSchema,
      create: () => ({ tools: [] } as never),
    }));
  } catch { /* already registered */ }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function writeManifest(folder: string): void {
  fs.mkdirSync(path.join(TMP_ROOT, folder), { recursive: true });
  fs.writeFileSync(
    path.join(TMP_ROOT, folder, 'manifest.json'),
    JSON.stringify({ name: 'test', spec: '1', pubkey: 'abc' }),
  );
}

function writeIdentity(folder: string, whoami = 'hi', prompt = 'You are a test agent.'): void {
  const dir = path.join(TMP_ROOT, folder, 'blueprint', 'identity');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'whoami.md'), whoami);
  fs.writeFileSync(path.join(dir, 'prompt.md'), prompt);
}

function writeMinimalAgent(folder: string): void {
  writeManifest(folder);
  writeIdentity(folder);
}

function writeCaps(folder: string, contents: object): void {
  const dir = path.join(TMP_ROOT, folder, 'blueprint', 'props');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'capabilities.json'), JSON.stringify(contents));
}

function writeJson(folder: string, segments: string[], contents: unknown): void {
  const full = path.join(TMP_ROOT, folder, ...segments);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(contents));
}

beforeEach(() => {
  for (const entry of fs.readdirSync(TMP_ROOT)) {
    fs.rmSync(path.join(TMP_ROOT, entry), { recursive: true, force: true });
  }
});

function problemFiles(report: ReturnType<typeof validateAgentBlueprint>): string[] {
  return report.problems.map((p) => p.file);
}

function problemMessages(report: ReturnType<typeof validateAgentBlueprint>): string[] {
  return report.problems.map((p) => `${p.file} — ${p.message}`);
}

function warningMessages(report: ReturnType<typeof validateAgentBlueprint>): string[] {
  return report.warnings.map((w) => `${w.file} — ${w.message}`);
}

// ---------------------------------------------------------------------------
// manifest + identity
// ---------------------------------------------------------------------------

describe('checkManifest + checkIdentityFiles', () => {
  it('clean minimal agent reports zero problems and zero warnings', () => {
    writeMinimalAgent('a1');
    const r = validateAgentBlueprint('a1');
    expect(r.problems).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('missing manifest is a problem', () => {
    fs.mkdirSync(path.join(TMP_ROOT, 'a2'), { recursive: true });
    writeIdentity('a2');
    const r = validateAgentBlueprint('a2');
    expect(problemFiles(r)).toContain('manifest.json');
  });

  it('empty whoami.md is a problem', () => {
    writeManifest('a3');
    writeIdentity('a3', '', 'You are X.');
    const r = validateAgentBlueprint('a3');
    expect(problemMessages(r).some((m) => m.startsWith('blueprint/identity/whoami.md'))).toBe(true);
  });

  it('missing prompt.md is a problem', () => {
    writeManifest('a4');
    const dir = path.join(TMP_ROOT, 'a4', 'blueprint', 'identity');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'whoami.md'), 'hi');
    const r = validateAgentBlueprint('a4');
    expect(problemFiles(r)).toContain('blueprint/identity/prompt.md');
  });
});

// ---------------------------------------------------------------------------
// channels
// ---------------------------------------------------------------------------

describe('checkChannels', () => {
  it('invalid channel directory name is a problem', () => {
    writeMinimalAgent('c1');
    const badDir = path.join(TMP_ROOT, 'c1', 'blueprint', 'channels', 'Bad-Name');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'channel.json'), JSON.stringify({ idle_timeout: 60000 }));
    const r = validateAgentBlueprint('c1');
    expect(problemMessages(r).some((m) => m.includes('Bad-Name'))).toBe(true);
  });

  it('missing channel.json is a problem', () => {
    writeMinimalAgent('c2');
    fs.mkdirSync(path.join(TMP_ROOT, 'c2', 'blueprint', 'channels', 'general'), { recursive: true });
    const r = validateAgentBlueprint('c2');
    expect(problemFiles(r)).toContain('blueprint/channels/general/channel.json');
  });

  it('channel.json with unknown key fails strict schema', () => {
    writeMinimalAgent('c3');
    const dir = path.join(TMP_ROOT, 'c3', 'blueprint', 'channels', 'general');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'channel.json'),
      JSON.stringify({ idle_timeout: 60000, typo_key: 'oops' }),
    );
    const r = validateAgentBlueprint('c3');
    expect(problemFiles(r)).toContain('blueprint/channels/general/channel.json');
  });
});

// ---------------------------------------------------------------------------
// capabilities strict flip
// ---------------------------------------------------------------------------

describe('checkCapabilities (strict)', () => {
  it('unknown top-level key in capabilities.json is a problem (strict flip)', () => {
    writeMinimalAgent('cap1');
    writeCaps('cap1', { extensions: {}, hallucinated_field: 'oops' });
    const r = validateAgentBlueprint('cap1');
    expect(problemFiles(r)).toContain('blueprint/props/capabilities.json');
  });

  it('extension referenced but not registered is a problem', () => {
    writeMinimalAgent('cap2');
    writeCaps('cap2', { extensions: { 'never-heard-of-this': { enabled: true } } });
    const r = validateAgentBlueprint('cap2');
    expect(problemMessages(r).some((m) => m.includes('not registered'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extension config validation — the motivating bug
// ---------------------------------------------------------------------------

describe('checkExtensions', () => {
  it('illegal enum value in extension config surfaces as a problem (fetch_mode=banana regression)', () => {
    writeMinimalAgent('e1');
    writeCaps('e1', {
      extensions: { [FAKE_EXT_NAME]: { enabled: true, fetch_mode: 'banana' } },
    });
    const r = validateAgentBlueprint('e1');
    expect(problemMessages(r).some((m) => m.includes(`extensions.${FAKE_EXT_NAME}`) && m.includes('fetch_mode'))).toBe(true);
  });

  it('unknown key in extension blob surfaces as a warning (strict reparse)', () => {
    writeMinimalAgent('e2');
    writeCaps('e2', {
      extensions: {
        [FAKE_EXT_NAME]: { enabled: true, fetch_mode: 'open', typo_key: 'oops' },
      },
    });
    const r = validateAgentBlueprint('e2');
    expect(warningMessages(r).some((m) => m.includes('typo_key'))).toBe(true);
    // Schema parse still passes (strip dropped the key) — no problem
    expect(problemMessages(r).every((m) => !m.includes('typo_key'))).toBe(true);
  });

  it('enabled extension with missing required secrets surfaces a non-blocking warning (deferred to Configure)', () => {
    writeMinimalAgent('e3');
    writeCaps('e3', { extensions: { [FAKE_SECRETS_EXT_NAME]: { enabled: true } } });
    const r = validateAgentBlueprint('e3');
    const secretsFile = `ext/${FAKE_SECRETS_EXT_NAME}/secrets.json`;
    expect(warningMessages(r).some((m) => m.includes(secretsFile))).toBe(true);
    expect(problemMessages(r).some((m) => m.includes(secretsFile))).toBe(false);
  });

  it('enabled extension with present-but-invalid secrets surfaces a problem', () => {
    writeMinimalAgent('e3b');
    writeCaps('e3b', { extensions: { [FAKE_SECRETS_EXT_NAME]: { enabled: true } } });
    writeJson('e3b', ['config', 'ext', FAKE_SECRETS_EXT_NAME, 'secrets.json'], { API_KEY: '' });
    const r = validateAgentBlueprint('e3b');
    expect(
      problemMessages(r).some(
        (m) => m.includes(`ext/${FAKE_SECRETS_EXT_NAME}/secrets.json`) && m.includes('secrets invalid'),
      ),
    ).toBe(true);
  });

  it('operator override of locked author key surfaces as a warning', () => {
    writeMinimalAgent('e4');
    writeCaps('e4', {
      extensions: { [FAKE_EXT_NAME]: { enabled: true, fetch_mode: 'approval' } },
    });
    writeJson('e4', ['config', 'ext', FAKE_EXT_NAME, 'config.json'], { fetch_mode: 'open' });
    const r = validateAgentBlueprint('e4');
    expect(warningMessages(r).some((m) => m.includes('fetch_mode') && m.includes('locked'))).toBe(true);
  });

  it('operator key not declared by author surfaces as a warning', () => {
    writeMinimalAgent('e5');
    writeCaps('e5', { extensions: { [FAKE_EXT_NAME]: { enabled: true } } });
    writeJson('e5', ['config', 'ext', FAKE_EXT_NAME, 'config.json'], { mystery: 1 });
    const r = validateAgentBlueprint('e5');
    expect(warningMessages(r).some((m) => m.includes('mystery') && m.includes('not declared'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// agent.json + modelOverrides cross-ref
// ---------------------------------------------------------------------------

describe('checkAgentConfig', () => {
  it('unknown top-level key in agent.json is a problem (strict flip)', () => {
    writeMinimalAgent('ac1');
    writeJson('ac1', ['config', 'agent.json'], { model: 'x', not_a_real_key: 7 });
    const r = validateAgentBlueprint('ac1');
    expect(problemFiles(r)).toContain('config/agent.json');
  });

  it('modelOverrides referencing a non-existent channel is a problem', () => {
    writeMinimalAgent('ac2');
    writeJson('ac2', ['config', 'agent.json'], {
      modelOverrides: [{ channel: 'ghost', model: 'claude-haiku-4-5' }],
    });
    const r = validateAgentBlueprint('ac2');
    expect(problemMessages(r).some((m) => m.includes('ghost'))).toBe(true);
  });

  it('modelOverrides referencing an existing channel passes', () => {
    writeMinimalAgent('ac3');
    const chDir = path.join(TMP_ROOT, 'ac3', 'blueprint', 'channels', 'email');
    fs.mkdirSync(chDir, { recursive: true });
    fs.writeFileSync(path.join(chDir, 'channel.json'), JSON.stringify({ idle_timeout: 60000 }));
    writeJson('ac3', ['config', 'agent.json'], {
      modelOverrides: [{ channel: 'email', model: 'claude-haiku-4-5' }],
    });
    const r = validateAgentBlueprint('ac3');
    expect(r.problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// provisions + resource invariants
// ---------------------------------------------------------------------------

describe('checkProvisions', () => {
  it('orphan provision (key not declared in caps) is a warning, not a problem', () => {
    writeMinimalAgent('p1');
    writeCaps('p1', { resources: { codebase: { access: 'ro', required: false } } });
    writeJson('p1', ['config', 'provisions.json'], {
      resources: { codebase: '/x', orphan: '/y' },
    });
    const r = validateAgentBlueprint('p1');
    expect(warningMessages(r).some((m) => m.includes('orphan'))).toBe(true);
    expect(problemMessages(r).every((m) => !m.includes('orphan'))).toBe(true);
  });

  it('access escalation (slot ro, provision rw) is a problem', () => {
    writeMinimalAgent('p2');
    writeCaps('p2', { resources: { codebase: { access: 'ro', required: false } } });
    writeJson('p2', ['config', 'provisions.json'], {
      resources: { codebase: { path: '/x', access: 'rw' } },
    });
    const r = validateAgentBlueprint('p2');
    expect(problemMessages(r).some((m) => m.includes('escalated'))).toBe(true);
  });

  it('pip.extra_packages without unlock is a problem', () => {
    writeMinimalAgent('p3');
    writeCaps('p3', {
      pip: { allowed_packages: ['requests'], extra_packages: [] },  // locked (bare array)
    });
    writeJson('p3', ['config', 'provisions.json'], {
      pip: { extra_packages: ['numpy'] },
    });
    const r = validateAgentBlueprint('p3');
    expect(problemMessages(r).some((m) => m.includes('extra_packages') && m.includes('unlock'))).toBe(true);
  });

  it('pip wildcard in extra_packages is a problem', () => {
    writeMinimalAgent('p4');
    writeCaps('p4', {
      pip: {
        allowed_packages: ['requests'],
        extra_packages: { unlocked: true, value: [] },
      },
    });
    writeJson('p4', ['config', 'provisions.json'], {
      pip: { extra_packages: ['nump*'] },
    });
    const r = validateAgentBlueprint('p4');
    expect(problemMessages(r).some((m) => m.includes('wildcard'))).toBe(true);
  });

  it('additional_disabled_tools without unlock is a problem', () => {
    writeMinimalAgent('p5');
    writeCaps('p5', { additional_disabled_tools: [] });  // locked bare array
    writeJson('p5', ['config', 'provisions.json'], {
      additional_disabled_tools: ['Bash'],
    });
    const r = validateAgentBlueprint('p5');
    expect(problemMessages(r).some((m) => m.includes('additional_disabled_tools') && m.includes('unlock'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MCP server checks
// ---------------------------------------------------------------------------

describe('checkMcpServers', () => {
  it('stdio MCP server missing "command" field is a problem', () => {
    writeMinimalAgent('m1');
    writeCaps('m1', {
      mcp_servers: { sandbox: { transport: 'stdio', env: {} } },
    });
    const r = validateAgentBlueprint('m1');
    expect(problemMessages(r).some((m) => m.includes('mcp_servers.sandbox') && m.includes('command'))).toBe(true);
  });

  it('http MCP server missing "url" is a problem', () => {
    writeMinimalAgent('m2');
    writeCaps('m2', {
      mcp_servers: { remote: { transport: 'streamable-http', env: {} } },
    });
    const r = validateAgentBlueprint('m2');
    expect(problemMessages(r).some((m) => m.includes('mcp_servers.remote') && m.includes('url'))).toBe(true);
  });

  it('required MCP env slot unprovisioned is a problem', () => {
    writeMinimalAgent('m3');
    writeCaps('m3', {
      mcp_servers: {
        sandbox: {
          transport: 'stdio',
          command: '/bin/sandbox',
          env: { API_KEY: { unlocked: true, required: true, value: '' } },
        },
      },
    });
    const r = validateAgentBlueprint('m3');
    expect(problemMessages(r).some((m) => m.includes('sandbox.API_KEY') && m.includes('required'))).toBe(true);
  });

  it('required MCP env slot provisioned passes', () => {
    writeMinimalAgent('m4');
    writeCaps('m4', {
      mcp_servers: {
        sandbox: {
          transport: 'stdio',
          command: '/bin/sandbox',
          env: { API_KEY: { unlocked: true, required: true, value: '' } },
        },
      },
    });
    writeJson('m4', ['config', 'mcp-servers.json'], { sandbox: { API_KEY: 'secret' } });
    const r = validateAgentBlueprint('m4');
    expect(problemMessages(r).every((m) => !m.includes('sandbox.API_KEY'))).toBe(true);
  });

  it('optional MCP env slot unset and no default is a warning, not a problem', () => {
    writeMinimalAgent('m5');
    writeCaps('m5', {
      mcp_servers: {
        sandbox: {
          transport: 'stdio',
          command: '/bin/sandbox',
          env: { OPTIONAL: { unlocked: true, value: '' } },
        },
      },
    });
    const r = validateAgentBlueprint('m5');
    expect(warningMessages(r).some((m) => m.includes('sandbox.OPTIONAL'))).toBe(true);
    expect(problemMessages(r).every((m) => !m.includes('sandbox.OPTIONAL'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderValidationReport
// ---------------------------------------------------------------------------

describe('renderValidationReport', () => {
  it('clean report says "passed"', () => {
    const out = renderValidationReport({ problems: [], warnings: [], passes: ['x — ok'] });
    expect(out).toContain('Validation **passed**');
  });

  it('failure report enumerates problems', () => {
    const out = renderValidationReport({
      problems: [{ file: 'f', message: 'broken' }],
      warnings: [],
      passes: [],
    });
    expect(out).toContain('Validation **failed**');
    expect(out).toContain('f — broken');
  });

  it('warnings render under their own header even when problems is empty', () => {
    const out = renderValidationReport({
      problems: [],
      warnings: [{ file: 'g', message: 'sus' }],
      passes: [],
    });
    expect(out).toContain('1 warning');
    expect(out).toContain('g — sus');
  });
});
