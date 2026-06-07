/**
 * Unit tests for `AgentManager.pair` — the per-agent pairing flow that
 * replaced the `tryPairing` free function (since deleted).
 *
 * Uses an `Object.create` prototype harness rather than constructing a
 * full `AgentManager`: the method depends only on `this.folder`,
 * `this.idp`, `this.bus`, `this.agentId`, `this.pairingFailedAttempts`,
 * and the two private rate-limit helpers — all of which we can plumb
 * via a minimal stub.
 *
 * Both-branches discipline: every branch of
 * the pairing decision tree gets a passing- and failing-path case where
 * applicable (valid/invalid code, ACL present/absent, identity
 * resolvable/not, rate-limit hot/cold).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    agentPath: (folder: string, ...segments: string[]) =>
      path.join('/tmp/test-agents', folder, ...segments),
  };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => { throw new Error('not found'); }),
      writeFileSync: vi.fn(),
      renameSync: vi.fn(),
      mkdirSync: vi.fn(),
      statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
    },
  };
});

import fs from 'fs';
import { LocalIdentityProvider } from './auth/identity.js';
import { AgentManager } from './agent/agent-manager.js';
import type { Bus } from './gateway/bus.js';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);

const MINIMAL_ACL = { owner: 'operator', peers: {} };

function mockWithCodes(codes: Record<string, object>): void {
  mockExistsSync.mockImplementation((p: unknown) => {
    const s = String(p);
    return s.endsWith('acl.json') || s.endsWith('pairing-codes.json');
  });
  mockReadFileSync.mockImplementation((p: unknown) => {
    const s = String(p);
    if (s.endsWith('acl.json')) return JSON.stringify(MINIMAL_ACL);
    if (s.endsWith('pairing-codes.json')) return JSON.stringify(codes);
    throw new Error('not found');
  });
}

function mockAclOnly(): void {
  mockExistsSync.mockImplementation((p: unknown) =>
    String(p).endsWith('acl.json'),
  );
  mockReadFileSync.mockImplementation((p: unknown) => {
    if (String(p).endsWith('acl.json')) return JSON.stringify(MINIMAL_ACL);
    throw new Error('not found');
  });
}

function getWrittenFile(suffix: string): Record<string, unknown> {
  const call = mockWriteFileSync.mock.calls.find(
    (c) => String(c[0]).endsWith(suffix) || String(c[0]).endsWith(suffix + '.tmp'),
  );
  if (!call) throw new Error(`${suffix} not written`);
  return JSON.parse(call[1] as string);
}

/**
 * Minimal AgentManager harness — enough fields for `pair()` and `unpair()`
 * to operate without constructing the full manager (which would require
 * the Conversations façade scope, ApprovalHandler, AgentDb, etc.).
 */
function makeHarness(idp: LocalIdentityProvider): {
  manager: AgentManager;
  busUpdate: ReturnType<typeof vi.fn>;
} {
  const busUpdate = vi.fn();
  const bus: Pick<Bus, 'update'> = { update: busUpdate };

  const harness = Object.create(AgentManager.prototype) as AgentManager
    & { pairingFailedAttempts: Map<string, { count: number; blockedUntil: number }> };
  Object.assign(harness, {
    folder: 'test',
    agentId: 'a:test@d9c1e2',
    bus,
    idp,
    pairingFailedAttempts: new Map(),
  });
  return { manager: harness, busUpdate };
}

describe('AgentManager.pair', () => {
  let idp: LocalIdentityProvider;
  let manager: AgentManager;
  let busUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReset();
    mockReadFileSync.mockImplementation(() => { throw new Error('not found'); });
    mockWriteFileSync.mockReset();
    idp = LocalIdentityProvider._createTest();
    ({ manager, busUpdate } = makeHarness(idp));
  });

  it('fails when no ACL configured', () => {
    const result = manager.pair('tg:12345', 'abc');
    expect(result.success).toBe(false);
    expect(result.message).toContain('No ACL');
    expect(busUpdate).not.toHaveBeenCalled();
  });

  it('fails with invalid code', () => {
    mockAclOnly();
    const result = manager.pair('tg:12345', 'wrong');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid');
    expect(busUpdate).not.toHaveBeenCalled();
  });

  it('fails when handle has no identity (not yet messaged)', () => {
    mockWithCodes({ secret: { for_handle: 'tg:99999' } });
    const result = manager.pair('tg:99999', 'secret');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Send any message first');
    expect(busUpdate).not.toHaveBeenCalled();
  });

  it('succeeds with valid code, writes both state files, fires bus.update', () => {
    mockWithCodes({ secret: { for_handle: 'tg:12345' } });
    idp.register('tg:12345', 'tg:12345');
    const result = manager.pair('tg:12345', 'secret');
    expect(result.success).toBe(true);
    expect(result.identity).toBeDefined();

    const users = getWrittenFile('paired-users.json');
    // Concrete per-channel grant — a code with no channel narrows to
    // `default` via the schema default, replacing the old wholesale `*: io`.
    expect(users[result.identity!.id]).toEqual({ 'default': 'io' });

    const codes = getWrittenFile('pairing-codes.json');
    expect((codes['secret'] as { consumed: boolean }).consumed).toBe(true);

    const aclWrites = mockWriteFileSync.mock.calls.filter(
      (c) => String(c[0]).endsWith('acl.json'),
    );
    expect(aclWrites).toHaveLength(0);

    expect(busUpdate).toHaveBeenCalledWith('a:test@d9c1e2', 'acl-changed');
  });

  it('grants io on the code\'s explicit channel, not the default', () => {
    mockWithCodes({ scoped: { for_handle: 'tg:12345', channel: 'focus' } });
    idp.register('tg:12345', 'tg:12345');
    const result = manager.pair('tg:12345', 'scoped');
    expect(result.success).toBe(true);

    const users = getWrittenFile('paired-users.json');
    expect(users[result.identity!.id]).toEqual({ 'focus': 'io' });
  });

  it('marks code as consumed (single-use)', () => {
    mockWithCodes({ once: { for_handle: 'tg:12345' } });
    idp.register('tg:12345', 'tg:12345');
    const result = manager.pair('tg:12345', 'once');
    expect(result.success).toBe(true);

    const codes = getWrittenFile('pairing-codes.json');
    expect((codes['once'] as { consumed: boolean }).consumed).toBe(true);
  });

  it('rejects already-consumed code', () => {
    mockWithCodes({ used: { consumed: true, for_handle: 'tg:12345' } });
    idp.register('tg:12345', 'tg:12345');
    const result = manager.pair('tg:12345', 'used');
    expect(result.success).toBe(false);
    expect(result.message).toContain('Invalid');
    expect(busUpdate).not.toHaveBeenCalled();
  });

  it('fails on expired code', () => {
    const expired = new Date(Date.now() - 60_000).toISOString();
    mockWithCodes({ old: { for_handle: 'tg:12345', expires: expired } });
    const result = manager.pair('tg:12345', 'old');
    expect(result.success).toBe(false);
    expect(result.message).toContain('expired');
    expect(busUpdate).not.toHaveBeenCalled();
  });

  it('identity is resolvable after pairing', () => {
    mockWithCodes({ go: { for_handle: 'tg:12345' } });
    idp.register('tg:12345', 'tg:12345');
    const result = manager.pair('tg:12345', 'go');
    expect(result.success).toBe(true);

    const resolved = idp.resolve('tg:12345');
    expect(resolved).not.toBeNull();
    expect(resolved!.id).toBe(result.identity!.id);
  });

  it('rate-limits with exponential backoff after failed attempt', () => {
    mockAclOnly();
    const handle = 'tg:brute';
    const r1 = manager.pair(handle, 'wrong');
    expect(r1.success).toBe(false);
    expect(r1.message).toContain('Invalid');
    const r2 = manager.pair(handle, 'wrong');
    expect(r2.success).toBe(false);
    expect(r2.message).toContain('Too many failed attempts');
  });

  it('rate-limit is scoped per AgentManager — lockout on one instance does not affect another', () => {
    mockAclOnly();
    const { manager: other } = makeHarness(idp);

    // Lock out the handle on the first manager
    manager.pair('tg:cross', 'wrong');
    const blocked = manager.pair('tg:cross', 'wrong');
    expect(blocked.message).toContain('Too many failed attempts');

    // Same handle on a different manager: not yet blocked.
    const fresh = other.pair('tg:cross', 'wrong');
    expect(fresh.message).toContain('Invalid');
    expect(fresh.message).not.toContain('Too many');
  });
});

describe('AgentManager.unpair', () => {
  let idp: LocalIdentityProvider;
  let manager: AgentManager;
  let busUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
    mockReadFileSync.mockReset();
    mockReadFileSync.mockImplementation(() => { throw new Error('not found'); });
    mockWriteFileSync.mockReset();
    idp = LocalIdentityProvider._createTest();
    ({ manager, busUpdate } = makeHarness(idp));
  });

  it('returns not-found when identity is not in paired-users.json', () => {
    const result = manager.unpair('u:abc@d9c1e2');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No paired user');
    expect(busUpdate).not.toHaveBeenCalled();
  });

  it('removes identity and emits bus.update on success', () => {
    mockExistsSync.mockImplementation((p) => String(p).endsWith('paired-users.json'));
    mockReadFileSync.mockImplementation((p) => {
      if (String(p).endsWith('paired-users.json')) {
        return JSON.stringify({ 'u:abc@d9c1e2': { '*': 'io' } });
      }
      throw new Error('not found');
    });

    const result = manager.unpair('u:abc@d9c1e2');
    expect(result.ok).toBe(true);

    const users = getWrittenFile('paired-users.json');
    expect(users['u:abc@d9c1e2']).toBeUndefined();

    expect(busUpdate).toHaveBeenCalledWith('a:test@d9c1e2', 'acl-changed');
  });
});
