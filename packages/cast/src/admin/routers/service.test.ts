/**
 * Service admin router — declaration-driven read/write over
 * blueprint/service/manifest.json (`secrets` + `config` fields) and
 * config/ext/service/{secrets,config}.json, plus the admin-page URL mint.
 *
 * Both-branches discipline: declared agents read masked/plain/typed values
 * AND undeclared agents report `declared: false`; writes within the declared
 * sets land AND undeclared keys / type mismatches reject atomically (no
 * partial state); blank keeps existing for secrets AND hand-added keys in
 * both files survive a save untouched.
 *
 * Uses the real agentPath against vitest's `CAST_AGENTS_DIR` tmpdir and the
 * router's own caller (procedures exercised end to end, including the
 * adminProcedure session gate's happy path).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';

import { agentPath } from '../../config.js';
import type { AdminDeps } from '../trpc.js';
import { serviceRouter } from './service.js';

const FOLDER = 'service-secrets-router-test';
const ALIAS = 'svc-secrets-alias';

/** Caller with a fake bus resolving ALIAS → FOLDER; session present. The fake
 *  `res.cookie` spy stands in for the Express response (adminPageUrl sets the
 *  page-session cookie on it) — pass your own to assert on it. */
function makeCaller(cookie = vi.fn(), getManager: () => unknown = () => undefined) {
  const deps = {
    bus: {
      resolveByLabel: (alias: string) => (alias === ALIAS ? `agent:${FOLDER}` : null),
      getMetadata: () => ({ folderPath: FOLDER }),
    },
    getManager,
  } as unknown as AdminDeps;
  return serviceRouter.createCaller({
    session: { token: 'test' },
    deps,
    res: { cookie } as never,
  });
}

interface ManifestShape {
  secrets?: Record<string, { label: string; secret?: boolean; required?: boolean }>;
  config?: Record<string, { label: string; type: 'string' | 'number' | 'boolean'; default?: string | number | boolean }>;
  admin?: boolean;
}

function writeManifest(decl: ManifestShape): void {
  fs.mkdirSync(agentPath(FOLDER, 'blueprint', 'service'), { recursive: true });
  fs.writeFileSync(
    agentPath(FOLDER, 'blueprint', 'service', 'manifest.json'),
    JSON.stringify({ name: 'test-svc', ...decl }),
  );
}

function writeFile(name: 'secrets.json' | 'config.json', content: Record<string, unknown>): void {
  fs.mkdirSync(agentPath(FOLDER, 'config', 'ext', 'service'), { recursive: true });
  fs.writeFileSync(agentPath(FOLDER, 'config', 'ext', 'service', name), JSON.stringify(content));
}

function readFile(name: 'secrets.json' | 'config.json'): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(agentPath(FOLDER, 'config', 'ext', 'service', name), 'utf-8'));
}

const SECRETS_DECL = {
  HN_USERNAME: { label: 'HN username' },
  HN_PASSWORD: { label: 'HN password', secret: true, required: true },
};

const CONFIG_DECL = {
  MODE: { label: 'Mode', type: 'string' as const },
  INTERVAL: { label: 'Scan interval (min)', type: 'number' as const, default: 30 },
  DRY_RUN: { label: 'Dry run', type: 'boolean' as const, default: false },
};

beforeEach(() => {
  fs.rmSync(agentPath(FOLDER), { recursive: true, force: true });
});

describe('getConfig — declared branch', () => {
  it('returns secrets in manifest order, masking secret values, plain otherwise', async () => {
    writeManifest({ secrets: SECRETS_DECL });
    writeFile('secrets.json', { HN_USERNAME: 'alice', HN_PASSWORD: 'super-secret-pw' });

    const res = await makeCaller().getConfig({ alias: ALIAS });

    expect(res.declared).toBe(true);
    expect(res.admin).toBe(false);
    expect(res.secrets.map((f) => f.key)).toEqual(['HN_USERNAME', 'HN_PASSWORD']);
    expect(res.secrets[0]).toEqual({
      key: 'HN_USERNAME', label: 'HN username', secret: false, required: false,
      value: 'alice', set: true,
    });
    expect(res.secrets[1]!.value).toBe('••••t-pw');
    expect(res.secrets[1]!.set).toBe(true);
  });

  it('returns typed settings — stored values when set, declared defaults otherwise', async () => {
    writeManifest({ config: CONFIG_DECL });
    writeFile('config.json', { MODE: 'fast' });

    const res = await makeCaller().getConfig({ alias: ALIAS });

    expect(res.declared).toBe(true);
    expect(res.config).toEqual([
      { key: 'MODE', label: 'Mode', type: 'string', value: 'fast', set: true },
      { key: 'INTERVAL', label: 'Scan interval (min)', type: 'number', value: 30, set: false },
      { key: 'DRY_RUN', label: 'Dry run', type: 'boolean', value: false, set: false },
    ]);
  });

  it('declares with admin flag alone (no fields)', async () => {
    writeManifest({ admin: true });
    const res = await makeCaller().getConfig({ alias: ALIAS });
    expect(res).toEqual({ present: false, status: 'unknown', declared: true, admin: true, secrets: [], config: [] });
  });
});

describe('getConfig — undeclared branch', () => {
  it('declares nothing when the manifest has no operator-facing fields', async () => {
    writeManifest({});
    expect(await makeCaller().getConfig({ alias: ALIAS })).toEqual({ present: false, status: 'unknown', declared: false, admin: false, secrets: [], config: [] });
  });

  it('declares nothing when there is no service manifest at all', async () => {
    expect(await makeCaller().getConfig({ alias: ALIAS })).toEqual({ present: false, status: 'unknown', declared: false, admin: false, secrets: [], config: [] });
  });
});

describe('getConfig — presence and status', () => {
  // Card renders on `present || declared`, so a declaration-less service still
  // surfaces (for restart + status). Presence keys on a runnable entrypoint.
  it('reports present + live status when a built bundle and manager exist', async () => {
    writeManifest({});
    fs.writeFileSync(agentPath(FOLDER, 'blueprint', 'service', 'index.js'), '// bundle');
    const res = await makeCaller(vi.fn(), () => ({ serviceStatus: 'running' })).getConfig({ alias: ALIAS });
    expect(res.present).toBe(true);
    expect(res.status).toBe('running');
  });

  it('reports absent + unknown with no bundle and no loaded manager', async () => {
    writeManifest({});
    const res = await makeCaller().getConfig({ alias: ALIAS });
    expect(res.present).toBe(false);
    expect(res.status).toBe('unknown');
  });
});

describe('setConfig — write branch', () => {
  it('persists declared secrets and creates the file on first save', async () => {
    writeManifest({ secrets: SECRETS_DECL });

    await makeCaller().setConfig({ alias: ALIAS, secrets: { HN_USERNAME: 'alice', HN_PASSWORD: 'pw' } });

    expect(readFile('secrets.json')).toEqual({ HN_USERNAME: 'alice', HN_PASSWORD: 'pw' });
  });

  it('keeps the stored secret for blank submissions (untouched secret fields)', async () => {
    writeManifest({ secrets: SECRETS_DECL });
    writeFile('secrets.json', { HN_USERNAME: 'alice', HN_PASSWORD: 'old-pw' });

    await makeCaller().setConfig({ alias: ALIAS, secrets: { HN_USERNAME: 'bob', HN_PASSWORD: '' } });

    expect(readFile('secrets.json')).toEqual({ HN_USERNAME: 'bob', HN_PASSWORD: 'old-pw' });
  });

  it('persists typed settings, coercing form strings to the declared type', async () => {
    writeManifest({ config: CONFIG_DECL });

    await makeCaller().setConfig({ alias: ALIAS, config: { MODE: 'slow', INTERVAL: '45', DRY_RUN: 'true' } });

    expect(readFile('config.json')).toEqual({ MODE: 'slow', INTERVAL: 45, DRY_RUN: true });
  });

  it('preserves hand-added keys outside the declared sets in both files', async () => {
    writeManifest({ secrets: SECRETS_DECL, config: CONFIG_DECL });
    writeFile('secrets.json', { HN_USERNAME: 'alice', EXTRA_BY_HAND: 'keep-me' });
    writeFile('config.json', { MODE: 'fast', HAND_TUNED: 99 });

    await makeCaller().setConfig({ alias: ALIAS, secrets: { HN_USERNAME: 'bob' }, config: { MODE: 'slow' } });

    expect(readFile('secrets.json')).toEqual({ HN_USERNAME: 'bob', EXTRA_BY_HAND: 'keep-me' });
    expect(readFile('config.json')).toEqual({ MODE: 'slow', HAND_TUNED: 99 });
  });
});

describe('setConfig — reject branch', () => {
  it('rejects an undeclared secret key and leaves both files untouched', async () => {
    writeManifest({ secrets: SECRETS_DECL, config: CONFIG_DECL });
    writeFile('secrets.json', { HN_USERNAME: 'alice' });

    await expect(
      makeCaller().setConfig({ alias: ALIAS, secrets: { HN_USERNAME: 'bob', NOT_DECLARED: 'x' } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(readFile('secrets.json')).toEqual({ HN_USERNAME: 'alice' });
  });

  it('rejects an undeclared setting key', async () => {
    writeManifest({ config: CONFIG_DECL });
    await expect(
      makeCaller().setConfig({ alias: ALIAS, config: { NOT_DECLARED: 'x' } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('rejects a type mismatch atomically — a bad setting blocks the valid secrets in the same save', async () => {
    writeManifest({ secrets: SECRETS_DECL, config: CONFIG_DECL });

    await expect(
      makeCaller().setConfig({ alias: ALIAS, secrets: { HN_USERNAME: 'bob' }, config: { INTERVAL: 'not-a-number' } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(fs.existsSync(agentPath(FOLDER, 'config', 'ext', 'service', 'secrets.json'))).toBe(false);
  });

  it('rejects every write when the agent declares nothing', async () => {
    writeManifest({});
    await expect(
      makeCaller().setConfig({ alias: ALIAS, secrets: { ANYTHING: 'x' } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('adminPageUrl', () => {
  it('sets a path-scoped session cookie and returns a clean URL (no credential in it)', async () => {
    writeManifest({ admin: true });
    const cookie = vi.fn();

    const { url } = await makeCaller(cookie).adminPageUrl({ alias: ALIAS });

    expect(url).toBe(`/agents/${FOLDER}/admin/`);
    expect(cookie).toHaveBeenCalledWith(
      'cast_svc_admin',
      expect.any(String),
      { path: `/agents/${FOLDER}/admin`, httpOnly: true, sameSite: 'lax' },
    );
  });

  it('refuses (and sets no cookie) when the manifest declares no admin page', async () => {
    writeManifest({ secrets: SECRETS_DECL });
    const cookie = vi.fn();
    await expect(makeCaller(cookie).adminPageUrl({ alias: ALIAS })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(cookie).not.toHaveBeenCalled();
  });
});
