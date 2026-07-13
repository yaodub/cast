import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

import type { ConsoleIsolation } from './config.js';

// Mutable mode state read by the mocked `readServerConfig`. Tests flip it
// when they need to assert mode-specific behavior; default is `normal` to
// match the production default.
let testIsolation: ConsoleIsolation = 'normal';
function setIsolation(mode: ConsoleIsolation): void {
  testIsolation = mode;
}

vi.mock('./config.js', () => ({
  agentPath: (folder: string, ...segments: string[]) =>
    path.join('/tmp/test-agents', folder, ...segments),
  readServerConfig: () => ({
    consoleModel: 'claude-opus-4-7',
    consoleIsolation: testIsolation,
  }),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      readFileSync: vi.fn(() => { throw new Error('not found'); }),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
    },
  };
});

import fs from 'fs';
import { aclVerdict, checkAcl, gateInbound, getOwner, getOwnerConversation, getPeerChannels, hasBit, isOperatorOrOwner, listChannelMembers, listPlacedChannels, lookupDescriptorAcl, membershipBits, pickVerb } from './auth/acl.js';
import { isReadTier } from './auth/address.js';
import {
  STRICT_OUTBOUND_ACLS,
  NORMAL_OUTBOUND_ACLS,
  getConsoleOutboundAcls,
} from './auth/console-grants.js';
import { Bus } from './gateway/bus.js';
import type { BusHandler } from './gateway/bus.js';
import { _setMockWatcher } from './lib/config-reader.js';

/** Fresh bus with no registrations — resolveAddress returns undefined for any alias. */
function emptyBus(): Bus {
  return new Bus();
}

/** Bus with a pre-registered agent so alias → canonical resolution works in tests. */
function busWith(registrations: { alias: string; canonical: string }[]): Bus {
  const bus = new Bus();
  const noop: BusHandler = {
    handleMessage: async () => {},
    handleEvent: async () => {},
  };
  for (const { alias, canonical } of registrations) {
    bus.register(canonical, noop, 'exact', { label: alias, type: 'agent', folderPath: alias });
  }
  return bus;
}

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockMkdirSync = vi.mocked(fs.mkdirSync);

/** File content map used by the mock watcher. */
const watcherFiles = new Map<string, string>();

beforeEach(() => {
  watcherFiles.clear();
  _setMockWatcher({ get: (p) => watcherFiles.get(p) ?? null });
  mockExistsSync.mockReset();
  mockExistsSync.mockReturnValue(false);
  mockReadFileSync.mockReset();
  mockReadFileSync.mockImplementation(() => { throw new Error('not found'); });
  mockWriteFileSync.mockReset();
  mockMkdirSync.mockReset();
  setIsolation('normal');
});

function mockAclFile(content: object, folder = 'test-agent'): void {
  const aclPath = path.join('/tmp/test-agents', folder, 'config', 'acl.json');
  watcherFiles.set(aclPath, JSON.stringify(content));
}

// ---------------------------------------------------------------------------
// hasBit
// ---------------------------------------------------------------------------

describe('hasBit', () => {
  it('checks individual bits', () => {
    expect(hasBit('ioaq', 'i')).toBe(true);
    expect(hasBit('ioaq', 'o')).toBe(true);
    expect(hasBit('ioaq', 'a')).toBe(true);
    expect(hasBit('ioaq', 'q')).toBe(true);
    expect(hasBit('io', 'a')).toBe(false);
    expect(hasBit('a', 'q')).toBe(false);
    expect(hasBit('', 'i')).toBe(false);
  });

  it('recognizes the r bit', () => {
    expect(hasBit('r', 'r')).toBe(true);
    expect(hasBit('ioaqr', 'r')).toBe(true);
    expect(hasBit('ioaqr', 'i')).toBe(true);
    expect(hasBit('ioaqr', 'o')).toBe(true);
    expect(hasBit('a', 'r')).toBe(false);
    expect(hasBit('r', 'a')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pickVerb
// ---------------------------------------------------------------------------

describe('pickVerb', () => {
  it('maps message to i (regular inbound conversation — and pushes, post-fold)', () => {
    expect(pickVerb('message')).toBe('i');
  });

  it('maps request to a (answer)', () => {
    expect(pickVerb('request')).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// gateInbound — composes pickVerb + hasBit. Both branches per security-gate
// test discipline. Post-fold a push is gated as a message (both check `i`).
// ---------------------------------------------------------------------------

describe('gateInbound', () => {
  it('allows message when bits include i', () => {
    expect(gateInbound('io', 'message')).toEqual({ allowed: true, verb: 'i' });
  });

  it('denies message when bits do not include i', () => {
    expect(gateInbound('a', 'message')).toEqual({ allowed: false, verb: 'i' });
  });

  it('allows request when bits include a', () => {
    expect(gateInbound('a', 'request')).toEqual({ allowed: true, verb: 'a' });
  });

  it('denies request when bits do not include a', () => {
    expect(gateInbound('io', 'request')).toEqual({ allowed: false, verb: 'a' });
  });

  it('denies all operations when bits are empty', () => {
    expect(gateInbound('', 'message')).toEqual({ allowed: false, verb: 'i' });
    expect(gateInbound('', 'request')).toEqual({ allowed: false, verb: 'a' });
  });

  it('allows all operations when bits include the full set', () => {
    expect(gateInbound('ioaqr', 'message')).toEqual({ allowed: true, verb: 'i' });
    expect(gateInbound('ioaqr', 'request')).toEqual({ allowed: true, verb: 'a' });
  });
});

// ---------------------------------------------------------------------------
// checkAcl — allowed format
// ---------------------------------------------------------------------------

describe('checkAcl (allowed format)', () => {
  it('allows the operator tier always with full bits', () => {
    const result = checkAcl(emptyBus(), 'test-agent', 'cli:alice');
    expect(result.bits).toBe('ioaqrp');
  });

  it('allows owner with full bits', () => {
    mockAclFile({ owner: 'u:abc123@test', allowed: {} });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:abc123@test/tg:12345');
    expect(result.bits).toBe('ioaqrp');
  });

  it('returns specific bits for peer with wildcard channel', () => {
    mockAclFile({ allowed: { 'u:abc@test': { '*': 'io' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:abc@test/tg:12345');
    expect(result.bits).toBe('io');
    expect(hasBit(result.bits, 'i')).toBe(true);
    expect(hasBit(result.bits, 'o')).toBe(true);
    expect(hasBit(result.bits, 'a')).toBe(false);
    expect(hasBit(result.bits, 'q')).toBe(false);
  });

  it('returns channel-specific bits over wildcard', () => {
    mockAclFile({ allowed: { 'u:abc@test': { '*': 'io', 'sales-query': 'a' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:abc@test/tg:12345', 'sales-query');
    expect(result.bits).toBe('a');
  });

  it('falls back to wildcard when channel not listed', () => {
    mockAclFile({ allowed: { 'u:abc@test': { '*': 'io', 'sales-query': 'a' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:abc@test/tg:12345', 'default');
    expect(result.bits).toBe('io');
  });

  it('returns empty bits for unknown identity', () => {
    mockAclFile({ allowed: { 'u:known@test': { '*': 'io' } }, reject_message: 'Access denied.' });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:unknown@test/tg:12345');
    expect(result.bits).toBe('');
    expect(result.rejectMessage).toBe('Access denied.');
  });

  it('returns empty bits when channel not allowed and no wildcard', () => {
    mockAclFile({ allowed: { 'u:abc@test': { 'scratch': 'io' } }, reject_message: 'Wrong channel.' });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:abc@test/tg:12345', 'private');
    expect(result.bits).toBe('');
    expect(result.rejectMessage).toBe('Wrong channel.');
  });

  it('handles agent peers with a-only access', () => {
    mockAclFile({ allowed: { 'agent:main': { 'sales-query': 'a' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'agent:main', 'sales-query');
    expect(result.bits).toBe('a');
    expect(hasBit(result.bits, 'a')).toBe(true);
    expect(hasBit(result.bits, 'i')).toBe(false);
  });

  it('handles agent peers with q-only access', () => {
    mockAclFile({ allowed: { 'agent:research': { '*': 'q' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'agent:research');
    expect(result.bits).toBe('q');
  });

  it('denies access when no acl.json (secure by default)', () => {
    const result = checkAcl(emptyBus(), 'test-agent', 'tg:12345');
    expect(result.bits).toBe('');
  });
});

// ---------------------------------------------------------------------------
// getOwnerConversation (2A.6)
// ---------------------------------------------------------------------------

describe('getOwnerConversation (2A.6)', () => {
  it('returns {id, channel} for a real owner with a pinned approval_channel', () => {
    mockAclFile({ owner: 'u:alice@test', approval_channel: 'room', allowed: {} });
    expect(getOwnerConversation(emptyBus(), 'test-agent')).toEqual({ id: 'u:alice@test', channel: 'room' });
  });

  it('returns null for the operator sentinel owner (the inbox handles it)', () => {
    mockAclFile({ owner: 'operator', approval_channel: 'room', allowed: {} });
    expect(getOwnerConversation(emptyBus(), 'test-agent')).toBeNull();
  });

  it('returns null for a real owner with no approval_channel pinned', () => {
    mockAclFile({ owner: 'u:alice@test', allowed: {} });
    expect(getOwnerConversation(emptyBus(), 'test-agent')).toBeNull();
  });

  it('returns null when there is no acl.json', () => {
    expect(getOwnerConversation(emptyBus(), 'no-such-agent')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getOwner — owner validation / fallback (2A.6: an invalid/unresolvable owner
// resolves to the operator sentinel, so a misconfigured owner routes approvals
// to the operator inbox instead of black-holing them).
// ---------------------------------------------------------------------------

describe('getOwner — invalid owner falls back to operator', () => {
  it('keeps the operator sentinel', () => {
    mockAclFile({ owner: 'operator', allowed: {} });
    expect(getOwner(emptyBus(), 'test-agent')).toBe('operator');
  });

  it('keeps a real user-identity owner', () => {
    mockAclFile({ owner: 'u:alice@test', allowed: {} });
    expect(getOwner(emptyBus(), 'test-agent')).toBe('u:alice@test');
  });

  it('keeps an operator-tier handle owner', () => {
    mockAclFile({ owner: 'admin:local', allowed: {} });
    expect(getOwner(emptyBus(), 'test-agent')).toBe('admin:local');
  });

  it('falls back to operator for the legacy bare-word owner "local"', () => {
    mockAclFile({ owner: 'local', allowed: {} });
    expect(getOwner(emptyBus(), 'test-agent')).toBe('operator');
  });

  it('falls back to operator for any non-principal owner string', () => {
    mockAclFile({ owner: 'whatever', allowed: {} });
    expect(getOwner(emptyBus(), 'test-agent')).toBe('operator');
  });

  it('so getOwnerConversation routes a "local"-owned agent to the inbox (null), not to "local"', () => {
    mockAclFile({ owner: 'local', approval_channel: 'room', allowed: {} });
    expect(getOwnerConversation(emptyBus(), 'test-agent')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Single-store test helper. Previously this mocked acl.json + a separate
// state/paired-users.json and leaned on the merge. There is one store now: fold
// the "paired" grants into acl.allowed (operator config wins per identity — the
// old identity-level precedence) and mock the single acl.json. Membership and
// placement read the post-merge peer map, so behavior is identical; only the
// source moved.
// ---------------------------------------------------------------------------
function mockAclAndPairedUsers(
  acl: { allowed?: Record<string, Record<string, string>> } & Record<string, unknown>,
  pairedUsers: Record<string, Record<string, string>>,
): void {
  mockAclFile({ ...acl, allowed: { ...pairedUsers, ...(acl.allowed ?? {}) } });
}

// ---------------------------------------------------------------------------
// checkAcl — agent peer matching (GUID form)
// ---------------------------------------------------------------------------

describe('checkAcl (agent peer matching)', () => {
  it('matches agent peer by canonical a:<guid>@<issuer> address', () => {
    // Agent-identity bit restriction limits bits to q/r/a — the test verifies
    // the *matching* mechanism (canonical address → ACL row), not the bit set.
    mockAclFile({ allowed: { 'a:fam001@ca3aaa': { '*': 'qra' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:fam001@ca3aaa');
    expect(result.bits).toBe('qra');
  });

  it('matches user identities by u: prefix', () => {
    mockAclFile({ allowed: { 'u:abc@test': { '*': 'io' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:abc@test/tg:12345');
    expect(result.bits).toBe('io');
  });

  it('rejects unknown agent', () => {
    mockAclFile({ allowed: { 'a:sales01@ca3aaa': { '*': 'q' } }, reject_message: 'No.' });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:unknown99@ca3aaa');
    expect(result.bits).toBe('');
    expect(result.rejectMessage).toBe('No.');
  });
});

// ---------------------------------------------------------------------------
// getPeerChannels — agent peer lookup
// ---------------------------------------------------------------------------

describe('getPeerChannels (agent peer lookup)', () => {
  it('returns channels for agent peer by canonical address', () => {
    mockAclFile({ allowed: { 'a:sales01@ca3aaa': { 'query': 'a', '*': 'q' } } });
    const channels = getPeerChannels(emptyBus(), 'test-agent', 'a:sales01@ca3aaa');
    expect(channels).toEqual([
      { name: 'query', bits: 'a' },
      { name: '*', bits: 'q' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Alias resolution — ACL peer keys as manifest aliases (C7 / V6, V15)
// ---------------------------------------------------------------------------

describe('checkAcl — alias-keyed peers resolved via bus', () => {
  it('matches a peer stored under alias when the peer is registered under canonical', () => {
    mockAclFile({ allowed: { 'sales': { '*': 'q' } } });
    const bus = busWith([{ alias: 'sales', canonical: 'a:sales01@ca3aaa' }]);
    const result = checkAcl(bus, 'test-agent', 'a:sales01@ca3aaa');
    expect(result.bits).toBe('q');
  });

  it('alias-keyed owner is resolved via bus', () => {
    mockAclFile({ owner: 'my-agent', allowed: {} });
    const bus = busWith([{ alias: 'my-agent', canonical: 'a:fam001@ca3aaa' }]);
    const result = checkAcl(bus, 'test-agent', 'a:fam001@ca3aaa');
    expect(result.bits).toBe('ioaqrp');
  });

  it('alias not registered on bus → peer lookup fails loudly (deny)', () => {
    mockAclFile({ allowed: { 'sales': { '*': 'q' } }, reject_message: 'Unknown.' });
    // bus has no "sales" alias registered; the peer key stays unresolved ("sales"),
    // the inbound identity is canonical ("a:sales01@ca3aaa"), so lookup misses.
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@ca3aaa');
    expect(result.bits).toBe('');
    expect(result.rejectMessage).toBe('Unknown.');
  });

  it('canonical-keyed peer still matches (backward compat)', () => {
    mockAclFile({ allowed: { 'a:sales01@ca3aaa': { '*': 'q' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@ca3aaa');
    expect(result.bits).toBe('q');
  });
});

// ---------------------------------------------------------------------------
// Peer-key globs — a:*, console:*; u:* rejected at schema parse
// ---------------------------------------------------------------------------

describe('checkAcl — peer-key globs', () => {
  it('a:* grants on matching agent peer', () => {
    mockAclFile({ allowed: { 'a:*': { 'default': 'q' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('q');
  });

  it('exact peer match beats a:* glob', () => {
    mockAclFile({ allowed: {
      'a:*': { 'default': 'q' },
      'a:sales01@srv': { 'default': 'a' },
    } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('a');
  });

  it('a:* does NOT match non-agent identities', () => {
    mockAclFile({ allowed: { 'a:*': { 'default': 'q' } }, reject_message: 'No.' });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:abc@test/tg:1', 'default');
    expect(result.bits).toBe('');
  });

  it('console:* grants on matching console peer', () => {
    mockAclFile({ allowed: { 'console:*': { 'default': 'ioaq' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'console:some-future-manager', 'default');
    expect(result.bits).toBe('ioaq');
  });

  it('peer glob + channel wildcard still does NOT grant on __* infra channels', () => {
    // Infra-channel invariant: peer glob + channel wildcard compose, but the
    // channel-wildcard-does-not-match-__* rule is preserved.
    mockAclFile({ allowed: { 'a:*': { '*': 'q' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', '__design');
    expect(result.bits).toBe('');
  });

  it('disk __design grants are IGNORED — system-owned channel, code table is authoritative', () => {
    // Operator writes an explicit __design grant in acl.json — it's silently
    // ignored because __design is in SYSTEM_OWNED_CHANNELS. Only
    // CONSOLE_INFRA_GRANTS can grant these channels.
    mockAclFile({ allowed: { 'a:*': { '__design': 'q' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', '__design');
    expect(result.bits).toBe('');
  });

  it('u:* peer key is rejected at schema parse — deny-all', () => {
    mockAclFile({ allowed: { 'u:*': { '*': 'io' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:abc@test/tg:1', 'default');
    // Schema refine fails → catch block denies all
    expect(result.bits).toBe('');
  });

  it('ext:* owner is rejected at schema parse — deny-all', () => {
    // An extension is an injection origin, never an approval controller. An
    // ext owner would route approvals to a principal that cannot respond, so
    // the file fails parse and every lookup denies.
    mockAclFile({ owner: 'ext:email', allowed: { 'u:known@test': { '*': 'io' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:known@test', 'default');
    expect(result.bits).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Agent-identity bit restriction — a:* peers may only carry q/r/a/p.
// Reject branch: i/o on an agent identity fails schema parse → deny-all.
// Allow branch: q/r/a/p (any subset) passes through to the live bits.
// Negative-space branch: u:* and console:* identities are unaffected.
// ---------------------------------------------------------------------------

describe('AclSchema — agent-identity bit restriction', () => {
  it('reject: a:* glob with i bit fails parse → deny-all', () => {
    mockAclFile({ allowed: { 'a:*': { 'default': 'i' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('');
  });

  it('reject: a:* glob with o bit (the loop-substrate case) fails parse → deny-all', () => {
    mockAclFile({ allowed: { 'a:*': { 'default': 'oq' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('');
  });

  it('reject: a:* glob with combined io bits fails parse → deny-all', () => {
    mockAclFile({ allowed: { 'a:*': { 'default': 'io' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('');
  });

  it('reject: exact a:<id> peer with o bit fails parse → deny-all', () => {
    mockAclFile({ allowed: { 'a:sales01@srv': { 'default': 'qo' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('');
  });

  it('reject: one violating channel taints the whole file (sibling channel also denied)', () => {
    // Schema-level rejection is all-or-nothing: a single forbidden bit anywhere
    // in the peer map fails the parse, so even a perfectly-fine sibling channel
    // returns deny. This is the intended chokepoint behavior.
    mockAclFile({ allowed: { 'a:*': { 'default': 'qra', 'coord': 'o' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('');
  });

  it('allow: a:* glob with qra bits parses cleanly', () => {
    mockAclFile({ allowed: { 'a:*': { 'default': 'qra' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('qra');
  });

  it('allow: a:* glob with single allowed bit (a) parses cleanly', () => {
    mockAclFile({ allowed: { 'a:*': { 'default': 'a' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('a');
  });

  it('allow: exact a:<id> peer with q bit parses cleanly', () => {
    mockAclFile({ allowed: { 'a:sales01@srv': { 'default': 'q' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('q');
  });

  it('allow: a:<id> peer with p (push-containment) bit round-trips', () => {
    // `p` is reactive-only in practice (grantAclEdge writes it), but the schema
    // must admit it so a granted edge re-parses on the next read.
    mockAclFile({ allowed: { 'a:sales01@srv': { 'default': 'p' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('p');
  });

  it('allow: a:<id> peer with combined qrap bits parses cleanly', () => {
    mockAclFile({ allowed: { 'a:sales01@srv': { 'default': 'qrap' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('qrap');
  });

  it('allow: restriction does not touch u:<id> peers — user identities still carry ioa', () => {
    mockAclFile({ allowed: { 'u:alice@srv': { 'default': 'ioa' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:alice@srv', 'default');
    expect(result.bits).toBe('ioa');
  });

  it('allow: restriction does not touch console:* peers — console identities still carry ioa', () => {
    mockAclFile({ allowed: { 'console:*': { 'default': 'ioa' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'console:some-manager', 'default');
    expect(result.bits).toBe('ioa');
  });
});

// ---------------------------------------------------------------------------
// Agent-bit restriction via alias — loophole closure. The
// parse-time superRefine sees RAW keys, so a config alias that resolves to an
// agent (`billing` → a:<guid>) escapes it. `resolveMergedPeers` re-applies the
// restriction AFTER normalization, failing the file closed — the same outcome
// a canonical-keyed violation gets at parse, just via a different mechanism.
// ---------------------------------------------------------------------------

describe('AclSchema — agent-bit restriction via alias (loophole closure)', () => {
  it('reject: alias-keyed agent `i` grant fails post-normalization → deny-all', () => {
    // `billing` passes parse (not an `a:` key), then resolves to an agent at
    // runtime; the post-normalization check catches the forbidden `i`.
    mockAclFile({ allowed: { 'billing': { 'support': 'i' } } });
    const bus = busWith([{ alias: 'billing', canonical: 'a:bill01@srv' }]);
    expect(checkAcl(bus, 'test-agent', 'a:bill01@srv', 'support').bits).toBe('');
  });

  it('parity: canonical-keyed agent `i` grant also denies (parse-time)', () => {
    // Same outcome as the alias case above, different mechanism — proves alias
    // and canonical forms reject identically.
    mockAclFile({ allowed: { 'a:bill01@srv': { 'support': 'i' } } });
    expect(checkAcl(emptyBus(), 'test-agent', 'a:bill01@srv', 'support').bits).toBe('');
  });

  it('allow: alias-keyed agent `qra` grant resolves cleanly (no over-block)', () => {
    mockAclFile({ allowed: { 'billing': { 'support': 'qra' } } });
    const bus = busWith([{ alias: 'billing', canonical: 'a:bill01@srv' }]);
    expect(checkAcl(bus, 'test-agent', 'a:bill01@srv', 'support').bits).toBe('qra');
  });

  it('reject: alias-keyed agent `i` cannot make a peer a room member (membershipBits)', () => {
    // The security-relevant case: without the loophole closure an alias-keyed
    // `i` would slip through and membershipBits would report the agent as a
    // member, subverting the membership model. The file fails closed.
    mockAclFile({ allowed: { 'billing': { 'room': 'i' } } });
    const bus = busWith([{ alias: 'billing', canonical: 'a:bill01@srv' }]);
    expect(membershipBits(bus, 'test-agent', 'a:bill01@srv', 'room')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// System-owned infra channels — code-declared grants
// ---------------------------------------------------------------------------

describe('checkAcl — system-owned infra channel short-circuit', () => {
  it('grants ia to console:design-manager on __design regardless of disk acl.json', () => {
    // Empty acl.json on disk; code table grants i (delegation receiver, post-fold
    // the inbound bit) + a (query answerer).
    mockAclFile({ allowed: {} });
    const result = checkAcl(emptyBus(), 'test-agent', 'console:design-manager', '__design');
    expect(result.bits).toBe('ia');
    expect(hasBit(result.bits, 'i')).toBe(true);
    expect(hasBit(result.bits, 'a')).toBe(true);
    // No `o` — outbound conversation bit is separate and unused on the
    // receiver side for delegation/query traffic.
    expect(hasBit(result.bits, 'o')).toBe(false);
  });

  it('grants ia to console:design-manager on __design even with no acl.json file', () => {
    const result = checkAcl(emptyBus(), 'test-agent', 'console:design-manager', '__design');
    expect(result.bits).toBe('ia');
  });

  it('denies unknown identity on __design (code table miss, disk not consulted)', () => {
    mockAclFile({ allowed: { 'a:*': { '__design': 'q' } } }); // disk entry is ignored
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', '__design');
    expect(result.bits).toBe('');
  });

  it('non-infra channels fall through to disk (console:* is just another peer there)', () => {
    mockAclFile({ allowed: { 'console:design-manager': { 'default': 'q' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'console:design-manager', 'default');
    expect(result.bits).toBe('q');
  });
});

describe('lookupDescriptorAcl — sender-side code-declared ACL', () => {
  it('resolves a:* glob to oq on __design for DM', () => {
    const acl = getConsoleOutboundAcls()['console:design-manager']!;
    const bits = lookupDescriptorAcl(acl, 'a:sales01@srv', '__design');
    expect(bits).toBe('oq');
    expect(hasBit(bits, 'o')).toBe(true);
    expect(hasBit(bits, 'q')).toBe(true);
  });

  it('u:* does not match a:* glob (user identities do not get agent grants)', () => {
    const acl = getConsoleOutboundAcls()['console:design-manager']!;
    const bits = lookupDescriptorAcl(acl, 'u:abc@xyz', '__design');
    expect(bits).toBe('');
  });

  it('wrong channel returns empty', () => {
    const acl = getConsoleOutboundAcls()['console:design-manager']!;
    const bits = lookupDescriptorAcl(acl, 'a:sales01@srv', 'default');
    expect(bits).toBe('');
  });

  it('exact peer match beats glob', () => {
    const acl = { peers: {
      'a:*': { '__design': 'o' },
      'a:special@srv': { '__design': 'io' },
    } };
    expect(lookupDescriptorAcl(acl, 'a:sales01@srv', '__design')).toBe('o');
    expect(lookupDescriptorAcl(acl, 'a:special@srv', '__design')).toBe('io');
  });
});

// ---------------------------------------------------------------------------
// Manager <cast:query> round-trip grants. DM and CM must be able to send
// `<cast:query>` (q) into per-agent __design / __configure and receive the
// `<cast:answer>` reply.
// ---------------------------------------------------------------------------

describe('manager query round-trip grants (q + a)', () => {
  it('DM sender-side: q+o (query+push) on __design via a:* glob', () => {
    const acl = getConsoleOutboundAcls()['console:design-manager']!;
    const bits = lookupDescriptorAcl(acl, 'a:anything@srv', '__design');
    expect(hasBit(bits, 'q')).toBe(true);
    expect(hasBit(bits, 'o')).toBe(true);
  });

  it('CM sender-side: q+o (query+push) on __configure via a:* glob', () => {
    const acl = getConsoleOutboundAcls()['console:config-manager']!;
    const bits = lookupDescriptorAcl(acl, 'a:anything@srv', '__configure');
    expect(hasBit(bits, 'q')).toBe(true);
    expect(hasBit(bits, 'o')).toBe(true);
  });

  it('SM has no outbound grant — read-only auditor', () => {
    expect(getConsoleOutboundAcls()['console:security-manager']).toBeUndefined();
  });

  it('receiver-side: per-agent __design accepts queries from DM (a bit)', () => {
    // checkAcl with channel=__design short-circuits to CONSOLE_INFRA_GRANTS.
    const result = checkAcl(emptyBus(), 'test-agent', 'console:design-manager', '__design');
    expect(hasBit(result.bits, 'a')).toBe(true);
    expect(hasBit(result.bits, 'i')).toBe(true); // push (inbound conversation, post-fold) still works
  });

  it('receiver-side: per-agent __configure accepts queries from CM (a bit)', () => {
    const result = checkAcl(emptyBus(), 'test-agent', 'console:config-manager', '__configure');
    expect(hasBit(result.bits, 'a')).toBe(true);
    expect(hasBit(result.bits, 'i')).toBe(true);
  });

  it('receiver-side: no grant for SM on any infra channel', () => {
    const result = checkAcl(emptyBus(), 'test-agent', 'console:security-manager', '__design');
    expect(result.bits).toBe('');
  });

  it('strict mode: cross-wired query denied — DM cannot query __configure, CM cannot query __design', () => {
    setIsolation('strict');
    expect(
      lookupDescriptorAcl(getConsoleOutboundAcls()['console:design-manager']!, 'a:x@srv', '__configure'),
    ).toBe('');
    expect(
      lookupDescriptorAcl(getConsoleOutboundAcls()['console:config-manager']!, 'a:x@srv', '__design'),
    ).toBe('');
  });

  it('normal mode: DM gains __configure reach (push + query); CM still cannot reach __design', () => {
    setIsolation('normal');
    expect(
      lookupDescriptorAcl(getConsoleOutboundAcls()['console:design-manager']!, 'a:x@srv', '__configure'),
    ).toBe('oq');
    // CM never gains reach — exfil-carrier direction stays closed in both modes.
    expect(
      lookupDescriptorAcl(getConsoleOutboundAcls()['console:config-manager']!, 'a:x@srv', '__design'),
    ).toBe('');
  });

  it('normal mode: DM → CM cross-manager grant (default channel)', () => {
    setIsolation('normal');
    expect(
      lookupDescriptorAcl(getConsoleOutboundAcls()['console:design-manager']!, 'console:config-manager', 'default'),
    ).toBe('oq');
    // CM has no symmetric grant — DM is the only cross-manager direction opened.
    expect(
      lookupDescriptorAcl(getConsoleOutboundAcls()['console:config-manager']!, 'console:design-manager', 'default'),
    ).toBe('');
  });

  it('static STRICT and NORMAL tables exposed for shape assertions', () => {
    // Tests that need to assert mode-specific shape without going through
    // the runtime accessor can import these directly.
    expect(STRICT_OUTBOUND_ACLS['console:design-manager']!.peers['a:*']!['__design']).toBe('oq');
    expect(NORMAL_OUTBOUND_ACLS['console:design-manager']!.peers['a:*']!['__configure']).toBe('oq');
  });
});

// ---------------------------------------------------------------------------
// r / i / o bits — conversation verb grants. The old `h` (host) bit folded into
// `i` (inbound): a pushed-in turn IS inbound conversation, so access rides the
// carried user's `io`. (`p` returned as a reactive push-CONTAINMENT
// edge on the sender side — a different axis from these access bits.) i/o are
// restricted to user (u:*) and console (console:*) identities — see the
// agent-identity bit restriction in acl.ts. These tests exercise bit semantics
// through a user peer so the schema admits them.
// ---------------------------------------------------------------------------

describe('checkAcl — r/i/o bits', () => {
  it('o-only grant yields outbound only, no inbound', () => {
    mockAclFile({ allowed: { 'u:sales01@srv': { 'default': 'o' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:sales01@srv', 'default');
    expect(result.bits).toBe('o');
    expect(hasBit(result.bits, 'o')).toBe(true);
    expect(hasBit(result.bits, 'i')).toBe(false);
  });

  it('i-only grant yields inbound only, no outbound', () => {
    mockAclFile({ allowed: { 'u:sales01@srv': { 'default': 'i' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:sales01@srv', 'default');
    expect(hasBit(result.bits, 'i')).toBe(true);
    expect(hasBit(result.bits, 'o')).toBe(false);
  });

  it('r-only grant allows send request; no inbound, no answer', () => {
    mockAclFile({ allowed: { 'a:sales01@srv': { 'default': 'r' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(hasBit(result.bits, 'r')).toBe(true);
    expect(hasBit(result.bits, 'a')).toBe(false);
    expect(hasBit(result.bits, 'i')).toBe(false);
  });

  it('a-only accepts both query and request (payload tag disambiguates)', () => {
    mockAclFile({ allowed: { 'a:sales01@srv': { 'default': 'a' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(hasBit(result.bits, 'a')).toBe(true);
    expect(hasBit(result.bits, 'r')).toBe(false);
  });

  it('combined io grant is both inbound and outbound on same peer', () => {
    mockAclFile({ allowed: { 'u:sales01@srv': { 'default': 'io' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:sales01@srv', 'default');
    expect(hasBit(result.bits, 'i')).toBe(true);
    expect(hasBit(result.bits, 'o')).toBe(true);
  });
});

describe('getPeerChannels — alias-keyed peers resolved via bus', () => {
  it('returns channels for a peer stored by alias', () => {
    mockAclFile({ allowed: { 'sales': { 'query': 'a', '*': 'q' } } });
    const bus = busWith([{ alias: 'sales', canonical: 'a:sales01@ca3aaa' }]);
    const channels = getPeerChannels(bus, 'test-agent', 'a:sales01@ca3aaa');
    expect(channels).toEqual([
      { name: 'query', bits: 'a' },
      { name: '*', bits: 'q' },
    ]);
  });

  it('alias-keyed owner returns wildcard full bits', () => {
    mockAclFile({ owner: 'my-agent', allowed: {} });
    const bus = busWith([{ alias: 'my-agent', canonical: 'a:fam001@ca3aaa' }]);
    const channels = getPeerChannels(bus, 'test-agent', 'a:fam001@ca3aaa');
    expect(channels).toEqual([{ name: '*', bits: 'ioaqrp' }]);
  });
});

// ---------------------------------------------------------------------------
// membershipBits — concrete per-channel room placement. Reads the SAME merged
// table as checkAcl, but omits every widening rule (no `*` fallback, no
// local/owner ALL_BITS short-circuit, no prefix-glob). Both branches per the
// security-gate test discipline. F1 (wildcard) and F2 (operator) are the
// regression-critical cases — driven at the real fs boundary, since what they
// assert is the ABSENCE of a rule that a stub could never prove.
// ---------------------------------------------------------------------------

describe('membershipBits', () => {
  it('returns the concrete named-channel grant (allow branch)', () => {
    mockAclFile({ allowed: { 'u:abc@test': { 'default': 'io', 'focus': 'io' } } });
    expect(membershipBits(emptyBus(), 'test-agent', 'u:abc@test/tg:1', 'default')).toBe('io');
    expect(membershipBits(emptyBus(), 'test-agent', 'u:abc@test/tg:1', 'focus')).toBe('io');
  });

  it('returns empty for a room the identity is not placed in (reject branch)', () => {
    mockAclFile({ allowed: { 'u:abc@test': { 'default': 'io' } } });
    expect(membershipBits(emptyBus(), 'test-agent', 'u:abc@test/tg:1', 'focus')).toBe('');
  });

  it('places an agent peer via the a bit on its named channel', () => {
    mockAclFile({ allowed: { 'a:peer@srv': { 'room': 'a' } } });
    expect(membershipBits(emptyBus(), 'test-agent', 'a:peer@srv', 'room')).toBe('a');
    expect(membershipBits(emptyBus(), 'test-agent', 'a:peer@srv', 'other')).toBe('');
  });

  // F1 — the `*` channel wildcard confers AUTHORIZATION but not PLACEMENT.
  // checkAcl falls back to `*`; membershipBits must not. This is the hole that
  // once made "member of this room" mean "is paired at all".
  it('F1: does NOT honour the `*` channel wildcard (config peers)', () => {
    mockAclFile({ allowed: { 'u:abc@test': { '*': 'io' } } });
    // checkAcl still authorizes via the wildcard…
    expect(checkAcl(emptyBus(), 'test-agent', 'u:abc@test/tg:1', 'default').bits).toBe('io');
    // …but membership requires a concrete named grant.
    expect(membershipBits(emptyBus(), 'test-agent', 'u:abc@test/tg:1', 'default')).toBe('');
  });

  it('F1: does NOT honour the `*` wildcard from paired-users (the production case)', () => {
    // paired-users.json holding { '*': 'io' } is exactly what the pairing-grant migration narrows.
    mockAclAndPairedUsers({ allowed: {} }, { 'u:abc@test': { '*': 'io' } });
    expect(checkAcl(emptyBus(), 'test-agent', 'u:abc@test/tg:1', 'default').bits).toBe('io');
    expect(membershipBits(emptyBus(), 'test-agent', 'u:abc@test/tg:1', 'default')).toBe('');
  });

  it('places a concrete paired-users grant', () => {
    mockAclAndPairedUsers({ allowed: {} }, { 'u:abc@test': { 'default': 'io' } });
    expect(membershipBits(emptyBus(), 'test-agent', 'u:abc@test/tg:1', 'default')).toBe('io');
  });

  // F2 — the operator tier and the owner get ALL_BITS from checkAcl, but are
  // members of nothing: standing alone is authorization, not placement.
  it('F2: the operator tier is a member of nothing despite ALL_BITS authorization', () => {
    mockAclFile({ allowed: { 'u:abc@test': { 'default': 'io' } } });
    expect(membershipBits(emptyBus(), 'test-agent', 'cli:alice', 'default')).toBe('');
  });

  it('F2: the owner is a member of nothing despite ALL_BITS authorization', () => {
    mockAclFile({ owner: 'u:owner@test', allowed: {} });
    expect(checkAcl(emptyBus(), 'test-agent', 'u:owner@test/tg:1', 'default').bits).toBe('ioaqrp');
    expect(membershipBits(emptyBus(), 'test-agent', 'u:owner@test/tg:1', 'default')).toBe('');
  });

  // A glob is a capability grant, not a concrete placement.
  it('does NOT expand the a:* prefix-glob into membership', () => {
    mockAclFile({ allowed: { 'a:*': { 'default': 'a' } } });
    expect(checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default').bits).toBe('a');
    expect(membershipBits(emptyBus(), 'test-agent', 'a:sales01@srv', 'default')).toBe('');
  });

  it('returns empty when there is no acl.json (member of nothing by default)', () => {
    expect(membershipBits(emptyBus(), 'test-agent', 'u:abc@test/tg:1', 'default')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// listPlacedChannels / listChannelMembers — membershipBits' two inversions
// (which rooms is X in? / who is in room Y?). Same merged table, same
// exclusions: no `*` expansion, no prefix-glob keys, no `__*` rows, no
// operator/owner god-mode. Driven at the real fs boundary like membershipBits
// — what they assert is the ABSENCE of widening rules, which a stub could
// never prove.
// ---------------------------------------------------------------------------

describe('listPlacedChannels', () => {
  it('returns the concrete placements for one identity (allow branch)', () => {
    mockAclFile({ allowed: { 'u:abc@test': { 'default': 'io', 'focus': 'ioa' } } });
    expect(listPlacedChannels(emptyBus(), 'test-agent', 'u:abc@test/tg:1')).toEqual([
      { channel: 'default', bits: 'io' },
      { channel: 'focus', bits: 'ioa' },
    ]);
  });

  it('returns empty for an unplaced identity (reject branch)', () => {
    mockAclFile({ allowed: { 'u:abc@test': { 'default': 'io' } } });
    expect(listPlacedChannels(emptyBus(), 'test-agent', 'u:other@test/tg:2')).toEqual([]);
  });

  it('reads placements from both sources (config peers + paired users)', () => {
    mockAclAndPairedUsers(
      { allowed: { 'a:peer@srv': { 'room': 'a' } } },
      { 'u:abc@test': { 'default': 'io' } },
    );
    expect(listPlacedChannels(emptyBus(), 'test-agent', 'u:abc@test/tg:1')).toEqual([
      { channel: 'default', bits: 'io' },
    ]);
    expect(listPlacedChannels(emptyBus(), 'test-agent', 'a:peer@srv')).toEqual([
      { channel: 'room', bits: 'a' },
    ]);
  });

  it('config rows replace paired-users rows for the same identity (merge is identity-level)', () => {
    mockAclAndPairedUsers(
      { allowed: { 'u:abc@test': { 'focus': 'io' } } },
      { 'u:abc@test': { 'default': 'io' } },
    );
    expect(listPlacedChannels(emptyBus(), 'test-agent', 'u:abc@test/tg:1')).toEqual([
      { channel: 'focus', bits: 'io' },
    ]);
  });

  it('excludes the `*` channel wildcard while keeping concrete rows', () => {
    mockAclFile({ allowed: { 'u:abc@test': { '*': 'io', 'default': 'io' } } });
    expect(listPlacedChannels(emptyBus(), 'test-agent', 'u:abc@test/tg:1')).toEqual([
      { channel: 'default', bits: 'io' },
    ]);
  });

  it('excludes `__*` infra rows', () => {
    mockAclFile({ allowed: { 'u:abc@test': { '__design': 'i', 'default': 'io' } } });
    expect(listPlacedChannels(emptyBus(), 'test-agent', 'u:abc@test/tg:1')).toEqual([
      { channel: 'default', bits: 'io' },
    ]);
  });

  it('excludes empty-bits rows (no standing, no placement)', () => {
    mockAclFile({ allowed: { 'u:abc@test': { 'default': '', 'focus': 'io' } } });
    expect(listPlacedChannels(emptyBus(), 'test-agent', 'u:abc@test/tg:1')).toEqual([
      { channel: 'focus', bits: 'io' },
    ]);
  });

  it('operator tier is placed nowhere unless concretely placed', () => {
    mockAclFile({ allowed: { 'u:abc@test': { 'default': 'io' } } });
    expect(listPlacedChannels(emptyBus(), 'test-agent', 'cli:alice')).toEqual([]);
  });

  it('operator tier with a concrete row gets exactly that row (no ALL_BITS widening)', () => {
    mockAclFile({ allowed: { 'cli:alice': { 'ops': 'io' } } });
    expect(listPlacedChannels(emptyBus(), 'test-agent', 'cli:alice')).toEqual([
      { channel: 'ops', bits: 'io' },
    ]);
  });

  it('the owner field alone places the owner nowhere', () => {
    mockAclFile({ owner: 'u:owner@test', allowed: {} });
    expect(checkAcl(emptyBus(), 'test-agent', 'u:owner@test/tg:1', 'default').bits).toBe('ioaqrp');
    expect(listPlacedChannels(emptyBus(), 'test-agent', 'u:owner@test/tg:1')).toEqual([]);
  });

  it('does NOT expand a prefix-glob into placements', () => {
    mockAclFile({ allowed: { 'a:*': { 'default': 'a' } } });
    expect(checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default').bits).toBe('a');
    expect(listPlacedChannels(emptyBus(), 'test-agent', 'a:sales01@srv')).toEqual([]);
  });

  it('returns empty when there is no acl.json', () => {
    expect(listPlacedChannels(emptyBus(), 'test-agent', 'u:abc@test/tg:1')).toEqual([]);
  });

  it('consistency: every enumerated row is confirmed by membershipBits', () => {
    mockAclAndPairedUsers(
      { allowed: { 'u:cfg@test': { '*': 'io', 'default': 'io', 'focus': 'ai' } } },
      { 'u:paired@test': { 'default': 'io' } },
    );
    for (const addr of ['u:cfg@test/tg:1', 'u:paired@test/tg:2']) {
      const rows = listPlacedChannels(emptyBus(), 'test-agent', addr);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(membershipBits(emptyBus(), 'test-agent', addr, row.channel)).toBe(row.bits);
      }
    }
  });
});

describe('listChannelMembers', () => {
  it('returns the concrete members of one channel from both sources (allow branch)', () => {
    mockAclAndPairedUsers(
      { allowed: { 'a:peer@srv': { 'room': 'a' } } },
      { 'u:abc@test': { 'room': 'io', 'other': 'io' } },
    );
    expect(listChannelMembers(emptyBus(), 'test-agent', 'room')).toEqual([
      { identity: 'u:abc@test', bits: 'io' },
      { identity: 'a:peer@srv', bits: 'a' },
    ]);
  });

  it('returns empty for a channel no one is placed in (reject branch)', () => {
    mockAclFile({ allowed: { 'u:abc@test': { 'default': 'io' } } });
    expect(listChannelMembers(emptyBus(), 'test-agent', 'empty-room')).toEqual([]);
  });

  it('a `*` wildcard row does not make an identity a member of a named channel', () => {
    mockAclFile({ allowed: { 'u:abc@test': { '*': 'io' } } });
    expect(checkAcl(emptyBus(), 'test-agent', 'u:abc@test/tg:1', 'default').bits).toBe('io');
    expect(listChannelMembers(emptyBus(), 'test-agent', 'default')).toEqual([]);
  });

  it('skips prefix-glob peer keys (capability grants, not placements)', () => {
    mockAclFile({ allowed: {
      'a:*': { 'room': 'a' },
      'console:*': { 'room': 'i' },
      'u:abc@test': { 'room': 'io' },
    } });
    expect(listChannelMembers(emptyBus(), 'test-agent', 'room')).toEqual([
      { identity: 'u:abc@test', bits: 'io' },
    ]);
  });

  it('`__*` infra channels enumerate as empty even with explicit rows', () => {
    mockAclFile({ allowed: { 'u:abc@test': { '__design': 'i' } } });
    expect(listChannelMembers(emptyBus(), 'test-agent', '__design')).toEqual([]);
  });

  it('the `*` channel name itself enumerates as empty', () => {
    mockAclFile({ allowed: { 'u:abc@test': { '*': 'io' } } });
    expect(listChannelMembers(emptyBus(), 'test-agent', '*')).toEqual([]);
  });

  it('operator and owner appear only when concretely placed', () => {
    mockAclFile({ owner: 'u:owner@test', allowed: {
      'cli:alice': { 'room': 'io' },
      'u:member@test': { 'room': 'i' },
    } });
    // cli:alice is placed by its concrete row; u:owner@test (owner field only) is absent.
    expect(listChannelMembers(emptyBus(), 'test-agent', 'room')).toEqual([
      { identity: 'cli:alice', bits: 'io' },
      { identity: 'u:member@test', bits: 'i' },
    ]);
  });

  it('alias-keyed peers surface as canonical identities (the addressable form)', () => {
    mockAclFile({ allowed: { 'sales': { 'room': 'a' } } });
    const bus = busWith([{ alias: 'sales', canonical: 'a:sales01@ca3aaa' }]);
    expect(listChannelMembers(bus, 'test-agent', 'room')).toEqual([
      { identity: 'a:sales01@ca3aaa', bits: 'a' },
    ]);
  });

  it('returns empty when there is no acl.json', () => {
    expect(listChannelMembers(emptyBus(), 'test-agent', 'room')).toEqual([]);
  });

  it('consistency: every member row is confirmed by membershipBits', () => {
    mockAclAndPairedUsers(
      { allowed: { 'a:peer@srv': { 'room': 'a' }, 'u:cfg@test': { 'room': 'i', '*': 'io' } } },
      { 'u:paired@test': { 'room': 'io' } },
    );
    const members = listChannelMembers(emptyBus(), 'test-agent', 'room');
    expect(members).toHaveLength(3);
    for (const m of members) {
      expect(membershipBits(emptyBus(), 'test-agent', m.identity, 'room')).toBe(m.bits);
    }
  });
});

// ---------------------------------------------------------------------------
// Read tier ⊂ write tier — structural subset pin. The read tier
// (`isReadTier`: system context ∥ operator tier) gates enumeration; the write
// tier (`isOperatorOrOwner`: operator tier ∥ configured owner) gates the push
// verdict's god-mode arm. Every read-tier caller must pass the write tier;
// the configured `u:` owner is the deliberate asymmetry — write without read.
// Pinned at the fs boundary so a future edit to either side trips it.
// ---------------------------------------------------------------------------

describe('read tier ⊂ write tier', () => {
  const OWN = 'a:self@srv';

  it('every non-system read-tier caller passes the write tier', () => {
    mockAclFile({ owner: 'u:owner@test', allowed: {} });
    for (const operator of ['cli:alice', 'admin:local']) {
      expect(isReadTier(operator, OWN)).toBe(true);
      expect(isOperatorOrOwner(emptyBus(), 'test-agent', operator)).toBe(true);
    }
  });

  it('the configured u: owner gets write without read — the deliberate asymmetry', () => {
    mockAclFile({ owner: 'u:owner@test', allowed: {} });
    expect(isOperatorOrOwner(emptyBus(), 'test-agent', 'u:owner@test/tg:1')).toBe(true);
    expect(isReadTier('u:owner@test/tg:1', OWN)).toBe(false);
  });

  it('member-tier callers pass neither', () => {
    mockAclFile({ allowed: { 'u:abc@test': { 'default': 'io' } } });
    expect(isReadTier('u:abc@test/tg:1', OWN)).toBe(false);
    expect(isOperatorOrOwner(emptyBus(), 'test-agent', 'u:abc@test/tg:1')).toBe(false);
  });
});

describe('aclVerdict — three-state (2B.1)', () => {
  it('granted when the bit is in the allowed map', () => {
    mockAclFile({ allowed: { 'a:peer@srv': { default: 'q' } } });
    expect(aclVerdict(emptyBus(), 'test-agent', 'a:peer@srv', 'default', 'q')).toBe('granted');
  });

  it('rejected when the bit is in the rejected tombstone map', () => {
    mockAclFile({ allowed: {}, rejected: { 'a:peer@srv': { default: 'q' } } });
    expect(aclVerdict(emptyBus(), 'test-agent', 'a:peer@srv', 'default', 'q')).toBe('rejected');
  });

  it('askable when neither allowed nor rejected (intra-pod default)', () => {
    mockAclFile({ allowed: {} });
    expect(aclVerdict(emptyBus(), 'test-agent', 'a:peer@srv', 'default', 'q')).toBe('askable');
  });

  it('rejected (secure default) when there is no acl.json', () => {
    expect(aclVerdict(emptyBus(), 'no-such-agent', 'a:peer@srv', 'default', 'q')).toBe('rejected');
  });
});

describe('aclVerdict — grants/tombstones live in acl.json (single store)', () => {
  // Single ACL store: there is no separate reactive-acl.json. A runtime grant is
  // just an entry in acl.json.allowed (written by grantAclEdge); a tombstone is an
  // entry in acl.json.rejected. aclVerdict reads the one file.
  it('a grant in allowed → granted', () => {
    mockAclFile({ owner: 'u:owner@iss', allowed: { 'u:alice@iss': { default: 'a' } } });
    expect(aclVerdict(emptyBus(), 'test-agent', 'u:alice@iss', 'default', 'a')).toBe('granted');
  });

  it('a tombstone in rejected → rejected', () => {
    mockAclFile({ owner: 'u:owner@iss', allowed: {}, rejected: { 'u:alice@iss': { default: 'a' } } });
    expect(aclVerdict(emptyBus(), 'test-agent', 'u:alice@iss', 'default', 'a')).toBe('rejected');
  });

  it('neither grant nor tombstone → askable', () => {
    mockAclFile({ owner: 'u:owner@iss', allowed: {} });
    expect(aclVerdict(emptyBus(), 'test-agent', 'u:alice@iss', 'default', 'a')).toBe('askable');
  });

  it('a grant on one channel does not leak to another', () => {
    mockAclFile({ owner: 'u:owner@iss', allowed: { 'u:alice@iss': { ops: 'a' } } });
    expect(aclVerdict(emptyBus(), 'test-agent', 'u:alice@iss', 'ops', 'a')).toBe('granted');
    expect(aclVerdict(emptyBus(), 'test-agent', 'u:alice@iss', 'default', 'a')).toBe('askable');
  });
});
