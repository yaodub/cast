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
import { checkAcl, gateInbound, getPeerChannels, hasBit, lookupDescriptorAcl, pickVerb } from './auth/acl.js';
import {
  STRICT_OUTBOUND_ACLS,
  NORMAL_OUTBOUND_ACLS,
  getConsoleOutboundAcls,
} from './auth/console-grants.js';
import { readPairedUsers } from './auth/pairing.js';
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

  it('recognizes r/p/h bits', () => {
    expect(hasBit('r', 'r')).toBe(true);
    expect(hasBit('p', 'p')).toBe(true);
    expect(hasBit('h', 'h')).toBe(true);
    expect(hasBit('ioaqrph', 'r')).toBe(true);
    expect(hasBit('ioaqrph', 'p')).toBe(true);
    expect(hasBit('ioaqrph', 'h')).toBe(true);
    expect(hasBit('p', 'h')).toBe(false);
    expect(hasBit('h', 'p')).toBe(false);
    expect(hasBit('a', 'r')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pickVerb
// ---------------------------------------------------------------------------

describe('pickVerb', () => {
  it('maps message to i (regular inbound conversation)', () => {
    expect(pickVerb('message')).toBe('i');
  });

  it('maps push to h (host push)', () => {
    expect(pickVerb('push')).toBe('h');
  });

  it('maps request to a (answer)', () => {
    expect(pickVerb('request')).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// gateInbound — composes pickVerb + hasBit. Both branches per security-gate
// test discipline.
// ---------------------------------------------------------------------------

describe('gateInbound', () => {
  it('allows message when bits include i', () => {
    expect(gateInbound('io', 'message')).toEqual({ allowed: true, verb: 'i' });
  });

  it('denies message when bits do not include i', () => {
    expect(gateInbound('h', 'message')).toEqual({ allowed: false, verb: 'i' });
  });

  it('allows push when bits include h', () => {
    expect(gateInbound('h', 'push')).toEqual({ allowed: true, verb: 'h' });
  });

  it('denies push when bits do not include h (paired io alone is not enough)', () => {
    expect(gateInbound('io', 'push')).toEqual({ allowed: false, verb: 'h' });
  });

  it('allows request when bits include a', () => {
    expect(gateInbound('a', 'request')).toEqual({ allowed: true, verb: 'a' });
  });

  it('denies request when bits do not include a', () => {
    expect(gateInbound('iop', 'request')).toEqual({ allowed: false, verb: 'a' });
  });

  it('denies all operations when bits are empty', () => {
    expect(gateInbound('', 'message')).toEqual({ allowed: false, verb: 'i' });
    expect(gateInbound('', 'push')).toEqual({ allowed: false, verb: 'h' });
    expect(gateInbound('', 'request')).toEqual({ allowed: false, verb: 'a' });
  });

  it('allows all operations when bits include the full set', () => {
    expect(gateInbound('ioaqrph', 'message')).toEqual({ allowed: true, verb: 'i' });
    expect(gateInbound('ioaqrph', 'push')).toEqual({ allowed: true, verb: 'h' });
    expect(gateInbound('ioaqrph', 'request')).toEqual({ allowed: true, verb: 'a' });
  });
});

// ---------------------------------------------------------------------------
// checkAcl — peers format
// ---------------------------------------------------------------------------

describe('checkAcl (peers format)', () => {
  it('allows local identity always with full bits', () => {
    const result = checkAcl(emptyBus(), 'test-agent', 'local/cli:alice');
    expect(result.bits).toBe('ioaqrph');
  });

  it('allows owner with full bits', () => {
    mockAclFile({ owner: 'u:abc123@test', peers: {} });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:abc123@test/tg:12345');
    expect(result.bits).toBe('ioaqrph');
  });

  it('returns specific bits for peer with wildcard channel', () => {
    mockAclFile({ peers: { 'u:abc@test': { '*': 'io' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:abc@test/tg:12345');
    expect(result.bits).toBe('io');
    expect(hasBit(result.bits, 'i')).toBe(true);
    expect(hasBit(result.bits, 'o')).toBe(true);
    expect(hasBit(result.bits, 'a')).toBe(false);
    expect(hasBit(result.bits, 'q')).toBe(false);
  });

  it('returns channel-specific bits over wildcard', () => {
    mockAclFile({ peers: { 'u:abc@test': { '*': 'io', 'sales-query': 'a' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:abc@test/tg:12345', 'sales-query');
    expect(result.bits).toBe('a');
  });

  it('falls back to wildcard when channel not listed', () => {
    mockAclFile({ peers: { 'u:abc@test': { '*': 'io', 'sales-query': 'a' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:abc@test/tg:12345', 'default');
    expect(result.bits).toBe('io');
  });

  it('returns empty bits for unknown identity', () => {
    mockAclFile({ peers: { 'u:known@test': { '*': 'io' } }, reject_message: 'Access denied.' });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:unknown@test/tg:12345');
    expect(result.bits).toBe('');
    expect(result.rejectMessage).toBe('Access denied.');
  });

  it('returns empty bits when channel not allowed and no wildcard', () => {
    mockAclFile({ peers: { 'u:abc@test': { 'scratch': 'io' } }, reject_message: 'Wrong channel.' });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:abc@test/tg:12345', 'private');
    expect(result.bits).toBe('');
    expect(result.rejectMessage).toBe('Wrong channel.');
  });

  it('handles agent peers with a-only access', () => {
    mockAclFile({ peers: { 'agent:main': { 'sales-query': 'a' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'agent:main', 'sales-query');
    expect(result.bits).toBe('a');
    expect(hasBit(result.bits, 'a')).toBe(true);
    expect(hasBit(result.bits, 'i')).toBe(false);
  });

  it('handles agent peers with q-only access', () => {
    mockAclFile({ peers: { 'agent:research': { '*': 'q' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'agent:research');
    expect(result.bits).toBe('q');
  });

  it('denies access when no acl.json (secure by default)', () => {
    const result = checkAcl(emptyBus(), 'test-agent', 'tg:12345');
    expect(result.bits).toBe('');
  });
});

// ---------------------------------------------------------------------------
// readPairedUsers
// ---------------------------------------------------------------------------

describe('readPairedUsers', () => {
  it('returns empty object when file does not exist', () => {
    expect(readPairedUsers('test-agent')).toEqual({});
  });

  it('returns parsed content when file exists', () => {
    const users = { 'u:abc@test': { '*': 'io' } };
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify(users));
    expect(readPairedUsers('test-agent')).toEqual(users);
  });

});

// ---------------------------------------------------------------------------
// checkAcl — merged peers (config/acl.json + state/paired-users.json)
// ---------------------------------------------------------------------------

function mockAclAndPairedUsers(acl: object, pairedUsers: Record<string, Record<string, string>>): void {
  // ACL goes through config-reader (watcher mock)
  const aclPath = path.join('/tmp/test-agents', 'test-agent', 'config', 'acl.json');
  watcherFiles.set(aclPath, JSON.stringify(acl));
  // Paired users go through direct fs.readFileSync
  mockReadFileSync.mockImplementation((p: unknown) => {
    if (String(p).endsWith('paired-users.json')) return JSON.stringify(pairedUsers);
    throw new Error('not found');
  });
}

describe('checkAcl (merged peers)', () => {
  it('finds operator peer from config/acl.json', () => {
    mockAclAndPairedUsers(
      { peers: { 'u:fam001@test123': { '*': 'ioaq' } } },
      { 'u:abc@test': { '*': 'io' } },
    );
    const result = checkAcl(emptyBus(), 'test-agent', 'u:fam001@test123');
    expect(result.bits).toBe('ioaq');
  });

  it('finds paired user from state/paired-users.json', () => {
    mockAclAndPairedUsers(
      { peers: { 'a:fam001@test123': { '*': 'q' } } },
      { 'u:abc@test': { '*': 'io' } },
    );
    const result = checkAcl(emptyBus(), 'test-agent', 'u:abc@test/tg:12345');
    expect(result.bits).toBe('io');
  });

  it('both sources are accessible', () => {
    mockAclAndPairedUsers(
      { peers: { 'a:sales01@srv': { 'query': 'a' } } },
      { 'u:xyz@test': { '*': 'io' } },
    );
    expect(checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'query').bits).toBe('a');
    expect(checkAcl(emptyBus(), 'test-agent', 'u:xyz@test/tg:99').bits).toBe('io');
  });
});

// ---------------------------------------------------------------------------
// checkAcl — agent peer matching (GUID form)
// ---------------------------------------------------------------------------

describe('checkAcl (agent peer matching)', () => {
  it('matches agent peer by canonical a:<guid>@<issuer> address', () => {
    // Agent-identity bit restriction limits bits to q/r/a — the test verifies
    // the *matching* mechanism (canonical address → ACL row), not the bit set.
    mockAclFile({ peers: { 'a:fam001@ca3aaa': { '*': 'qra' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:fam001@ca3aaa');
    expect(result.bits).toBe('qra');
  });

  it('matches user identities by u: prefix', () => {
    mockAclFile({ peers: { 'u:abc@test': { '*': 'io' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:abc@test/tg:12345');
    expect(result.bits).toBe('io');
  });

  it('rejects unknown agent', () => {
    mockAclFile({ peers: { 'a:sales01@ca3aaa': { '*': 'q' } }, reject_message: 'No.' });
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
    mockAclFile({ peers: { 'a:sales01@ca3aaa': { 'query': 'a', '*': 'q' } } });
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
    mockAclFile({ peers: { 'sales': { '*': 'q' } } });
    const bus = busWith([{ alias: 'sales', canonical: 'a:sales01@ca3aaa' }]);
    const result = checkAcl(bus, 'test-agent', 'a:sales01@ca3aaa');
    expect(result.bits).toBe('q');
  });

  it('alias-keyed owner is resolved via bus', () => {
    mockAclFile({ owner: 'my-agent', peers: {} });
    const bus = busWith([{ alias: 'my-agent', canonical: 'a:fam001@ca3aaa' }]);
    const result = checkAcl(bus, 'test-agent', 'a:fam001@ca3aaa');
    expect(result.bits).toBe('ioaqrph');
  });

  it('alias not registered on bus → peer lookup fails loudly (deny)', () => {
    mockAclFile({ peers: { 'sales': { '*': 'q' } }, reject_message: 'Unknown.' });
    // bus has no "sales" alias registered; the peer key stays unresolved ("sales"),
    // the inbound identity is canonical ("a:sales01@ca3aaa"), so lookup misses.
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@ca3aaa');
    expect(result.bits).toBe('');
    expect(result.rejectMessage).toBe('Unknown.');
  });

  it('canonical-keyed peer still matches (backward compat)', () => {
    mockAclFile({ peers: { 'a:sales01@ca3aaa': { '*': 'q' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@ca3aaa');
    expect(result.bits).toBe('q');
  });
});

// ---------------------------------------------------------------------------
// Peer-key globs — a:*, console:*; u:* rejected at schema parse
// ---------------------------------------------------------------------------

describe('checkAcl — peer-key globs', () => {
  it('a:* grants on matching agent peer', () => {
    mockAclFile({ peers: { 'a:*': { 'default': 'q' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('q');
  });

  it('exact peer match beats a:* glob', () => {
    mockAclFile({ peers: {
      'a:*': { 'default': 'q' },
      'a:sales01@srv': { 'default': 'a' },
    } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('a');
  });

  it('a:* does NOT match non-agent identities', () => {
    mockAclFile({ peers: { 'a:*': { 'default': 'q' } }, reject_message: 'No.' });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:abc@test/tg:1', 'default');
    expect(result.bits).toBe('');
  });

  it('console:* grants on matching console peer', () => {
    mockAclFile({ peers: { 'console:*': { 'default': 'ioaq' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'console:some-future-manager', 'default');
    expect(result.bits).toBe('ioaq');
  });

  it('peer glob + channel wildcard still does NOT grant on __* infra channels', () => {
    // Infra-channel invariant: peer glob + channel wildcard compose, but the
    // channel-wildcard-does-not-match-__* rule is preserved.
    mockAclFile({ peers: { 'a:*': { '*': 'q' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', '__design');
    expect(result.bits).toBe('');
  });

  it('disk __design grants are IGNORED — system-owned channel, code table is authoritative', () => {
    // Operator writes an explicit __design grant in acl.json — it's silently
    // ignored because __design is in SYSTEM_OWNED_CHANNELS. Only
    // CONSOLE_INFRA_GRANTS can grant these channels.
    mockAclFile({ peers: { 'a:*': { '__design': 'h' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', '__design');
    expect(result.bits).toBe('');
  });

  it('u:* peer key is rejected at schema parse — deny-all', () => {
    mockAclFile({ peers: { 'u:*': { '*': 'io' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:abc@test/tg:1', 'default');
    // Schema refine fails → catch block denies all
    expect(result.bits).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Agent-identity bit restriction — a:* peers may only carry q/r/a.
// Reject branch: i/o/p/h on an agent identity fails schema parse → deny-all.
// Allow branch: q/r/a (any subset) passes through to the live bits.
// Negative-space branch: u:* and console:* identities are unaffected.
// ---------------------------------------------------------------------------

describe('AclSchema — agent-identity bit restriction', () => {
  it('reject: a:* glob with i bit fails parse → deny-all', () => {
    mockAclFile({ peers: { 'a:*': { 'default': 'i' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('');
  });

  it('reject: a:* glob with p bit (the loop-substrate case) fails parse → deny-all', () => {
    mockAclFile({ peers: { 'a:*': { 'default': 'pq' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('');
  });

  it('reject: a:* glob with h bit fails parse → deny-all', () => {
    mockAclFile({ peers: { 'a:*': { 'default': 'h' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('');
  });

  it('reject: exact a:<id> peer with o bit fails parse → deny-all', () => {
    mockAclFile({ peers: { 'a:sales01@srv': { 'default': 'qo' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('');
  });

  it('reject: one violating channel taints the whole file (sibling channel also denied)', () => {
    // Schema-level rejection is all-or-nothing: a single forbidden bit anywhere
    // in the peer map fails the parse, so even a perfectly-fine sibling channel
    // returns deny. This is the intended chokepoint behavior.
    mockAclFile({ peers: { 'a:*': { 'default': 'qra', 'coord': 'p' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('');
  });

  it('allow: a:* glob with qra bits parses cleanly', () => {
    mockAclFile({ peers: { 'a:*': { 'default': 'qra' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('qra');
  });

  it('allow: a:* glob with single allowed bit (a) parses cleanly', () => {
    mockAclFile({ peers: { 'a:*': { 'default': 'a' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('a');
  });

  it('allow: exact a:<id> peer with q bit parses cleanly', () => {
    mockAclFile({ peers: { 'a:sales01@srv': { 'default': 'q' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(result.bits).toBe('q');
  });

  it('allow: restriction does not touch u:<id> peers — user identities still carry iohap', () => {
    mockAclFile({ peers: { 'u:alice@srv': { 'default': 'iohap' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:alice@srv', 'default');
    expect(result.bits).toBe('iohap');
  });

  it('allow: restriction does not touch console:* peers — console identities still carry iohap', () => {
    mockAclFile({ peers: { 'console:*': { 'default': 'iohap' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'console:some-manager', 'default');
    expect(result.bits).toBe('iohap');
  });
});

// ---------------------------------------------------------------------------
// System-owned infra channels — code-declared grants
// ---------------------------------------------------------------------------

describe('checkAcl — system-owned infra channel short-circuit', () => {
  it('grants ha to console:design-manager on __design regardless of disk acl.json', () => {
    // Empty acl.json on disk; code table grants h (delegation receiver) + a
    // (query answerer).
    mockAclFile({ peers: {} });
    const result = checkAcl(emptyBus(), 'test-agent', 'console:design-manager', '__design');
    expect(result.bits).toBe('ha');
    expect(hasBit(result.bits, 'h')).toBe(true);
    expect(hasBit(result.bits, 'a')).toBe(true);
    // No `i` — regular inbound conversation bit is separate and unused
    // for delegation/query traffic.
    expect(hasBit(result.bits, 'i')).toBe(false);
  });

  it('grants ha to console:design-manager on __design even with no acl.json file', () => {
    const result = checkAcl(emptyBus(), 'test-agent', 'console:design-manager', '__design');
    expect(result.bits).toBe('ha');
  });

  it('denies unknown identity on __design (code table miss, disk not consulted)', () => {
    mockAclFile({ peers: { 'a:*': { '__design': 'h' } } }); // disk entry is ignored
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', '__design');
    expect(result.bits).toBe('');
  });

  it('non-infra channels fall through to disk (console:* is just another peer there)', () => {
    mockAclFile({ peers: { 'console:design-manager': { 'default': 'q' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'console:design-manager', 'default');
    expect(result.bits).toBe('q');
  });
});

describe('lookupDescriptorAcl — sender-side code-declared ACL', () => {
  it('resolves a:* glob to pq on __design for DM', () => {
    const acl = getConsoleOutboundAcls()['console:design-manager']!;
    const bits = lookupDescriptorAcl(acl, 'a:sales01@srv', '__design');
    expect(bits).toBe('pq');
    expect(hasBit(bits, 'p')).toBe(true);
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
      'a:*': { '__design': 'p' },
      'a:special@srv': { '__design': 'ph' },
    } };
    expect(lookupDescriptorAcl(acl, 'a:sales01@srv', '__design')).toBe('p');
    expect(lookupDescriptorAcl(acl, 'a:special@srv', '__design')).toBe('ph');
  });
});

// ---------------------------------------------------------------------------
// Manager <cast:query> round-trip grants. DM and CM must be able to send
// `<cast:query>` (q) into per-agent __design / __configure and receive the
// `<cast:answer>` reply.
// ---------------------------------------------------------------------------

describe('manager query round-trip grants (q + a)', () => {
  it('DM sender-side: q+p on __design via a:* glob', () => {
    const acl = getConsoleOutboundAcls()['console:design-manager']!;
    const bits = lookupDescriptorAcl(acl, 'a:anything@srv', '__design');
    expect(hasBit(bits, 'q')).toBe(true);
    expect(hasBit(bits, 'p')).toBe(true);
  });

  it('CM sender-side: q+p on __configure via a:* glob', () => {
    const acl = getConsoleOutboundAcls()['console:config-manager']!;
    const bits = lookupDescriptorAcl(acl, 'a:anything@srv', '__configure');
    expect(hasBit(bits, 'q')).toBe(true);
    expect(hasBit(bits, 'p')).toBe(true);
  });

  it('SM has no outbound grant — read-only auditor', () => {
    expect(getConsoleOutboundAcls()['console:security-manager']).toBeUndefined();
  });

  it('receiver-side: per-agent __design accepts queries from DM (a bit)', () => {
    // checkAcl with channel=__design short-circuits to CONSOLE_INFRA_GRANTS.
    const result = checkAcl(emptyBus(), 'test-agent', 'console:design-manager', '__design');
    expect(hasBit(result.bits, 'a')).toBe(true);
    expect(hasBit(result.bits, 'h')).toBe(true); // push still works
  });

  it('receiver-side: per-agent __configure accepts queries from CM (a bit)', () => {
    const result = checkAcl(emptyBus(), 'test-agent', 'console:config-manager', '__configure');
    expect(hasBit(result.bits, 'a')).toBe(true);
    expect(hasBit(result.bits, 'h')).toBe(true);
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
    ).toBe('pq');
    // CM never gains reach — exfil-carrier direction stays closed in both modes.
    expect(
      lookupDescriptorAcl(getConsoleOutboundAcls()['console:config-manager']!, 'a:x@srv', '__design'),
    ).toBe('');
  });

  it('normal mode: DM → CM cross-manager grant (default channel)', () => {
    setIsolation('normal');
    expect(
      lookupDescriptorAcl(getConsoleOutboundAcls()['console:design-manager']!, 'console:config-manager', 'default'),
    ).toBe('pq');
    // CM has no symmetric grant — DM is the only cross-manager direction opened.
    expect(
      lookupDescriptorAcl(getConsoleOutboundAcls()['console:config-manager']!, 'console:design-manager', 'default'),
    ).toBe('');
  });

  it('static STRICT and NORMAL tables exposed for shape assertions', () => {
    // Tests that need to assert mode-specific shape without going through
    // the runtime accessor can import these directly.
    expect(STRICT_OUTBOUND_ACLS['console:design-manager']!.peers['a:*']!['__design']).toBe('pq');
    expect(NORMAL_OUTBOUND_ACLS['console:design-manager']!.peers['a:*']!['__configure']).toBe('pq');
  });
});

// ---------------------------------------------------------------------------
// r / p / h bits — sender-side verb grants
// ---------------------------------------------------------------------------

describe('checkAcl — r/p/h bits', () => {
  // p/h are restricted to user (u:*) and console (console:*) identities — see the
  // agent-identity bit restriction in acl.ts. These tests exercise bit semantics
  // through a user peer so the schema admits them.
  it('p-only grant yields outbound push, no inbound', () => {
    mockAclFile({ peers: { 'u:sales01@srv': { 'default': 'p' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:sales01@srv', 'default');
    expect(result.bits).toBe('p');
    expect(hasBit(result.bits, 'p')).toBe(true);
    expect(hasBit(result.bits, 'i')).toBe(false);
    expect(hasBit(result.bits, 'h')).toBe(false);
  });

  it('h-only grant accepts push, does not send', () => {
    mockAclFile({ peers: { 'u:sales01@srv': { 'default': 'h' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:sales01@srv', 'default');
    expect(hasBit(result.bits, 'h')).toBe(true);
    expect(hasBit(result.bits, 'p')).toBe(false);
  });

  it('r-only grant allows send request; no inbound, no answer', () => {
    mockAclFile({ peers: { 'a:sales01@srv': { 'default': 'r' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(hasBit(result.bits, 'r')).toBe(true);
    expect(hasBit(result.bits, 'a')).toBe(false);
    expect(hasBit(result.bits, 'i')).toBe(false);
  });

  it('a-only accepts both query and request (payload tag disambiguates)', () => {
    mockAclFile({ peers: { 'a:sales01@srv': { 'default': 'a' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'a:sales01@srv', 'default');
    expect(hasBit(result.bits, 'a')).toBe(true);
    expect(hasBit(result.bits, 'r')).toBe(false);
  });

  it('combined ph grant is both sender and host on same peer', () => {
    mockAclFile({ peers: { 'u:sales01@srv': { 'default': 'ph' } } });
    const result = checkAcl(emptyBus(), 'test-agent', 'u:sales01@srv', 'default');
    expect(hasBit(result.bits, 'p')).toBe(true);
    expect(hasBit(result.bits, 'h')).toBe(true);
  });
});

describe('getPeerChannels — alias-keyed peers resolved via bus', () => {
  it('returns channels for a peer stored by alias', () => {
    mockAclFile({ peers: { 'sales': { 'query': 'a', '*': 'q' } } });
    const bus = busWith([{ alias: 'sales', canonical: 'a:sales01@ca3aaa' }]);
    const channels = getPeerChannels(bus, 'test-agent', 'a:sales01@ca3aaa');
    expect(channels).toEqual([
      { name: 'query', bits: 'a' },
      { name: '*', bits: 'q' },
    ]);
  });

  it('alias-keyed owner returns wildcard full bits', () => {
    mockAclFile({ owner: 'my-agent', peers: {} });
    const bus = busWith([{ alias: 'my-agent', canonical: 'a:fam001@ca3aaa' }]);
    const channels = getPeerChannels(bus, 'test-agent', 'a:fam001@ca3aaa');
    expect(channels).toEqual([{ name: '*', bits: 'ioaqrph' }]);
  });
});
