import { describe, expect, it } from 'vitest';

import {
  buildAddress,
  decodeAddressValue,
  encodeAddressValue,
  extractHandle,
  extractHandlePrefix,
  extractIdentity,
  hasPrefix,
  isAgent,
  isExtAddress,
  isMember,
  isOperatorTier,
  isParticipantAddress,
  isReadTier,
  isSystemContext,
  isSystemSender,
  isUser,
  parseAddress,
  parseAgentAddress,
} from './auth/address.js';

describe('parseAddress', () => {
  it('parses standard addresses', () => {
    expect(parseAddress('agent:main')).toEqual({ prefix: 'agent', id: 'main' });
    expect(parseAddress('cli:alice')).toEqual({ prefix: 'cli', id: 'alice' });
    expect(parseAddress('tg:12345')).toEqual({ prefix: 'tg', id: '12345' });
    expect(parseAddress('ext:email')).toEqual({ prefix: 'ext', id: 'email' });
  });

  it('rejects addresses with paths (use parseAgentAddress)', () => {
    expect(() => parseAddress('agent:main/scratch')).toThrow('use parseAgentAddress');
  });

  it('rejects malformed addresses', () => {
    expect(() => parseAddress('')).toThrow('Invalid address');
    expect(() => parseAddress('nocolon')).toThrow('Invalid address');
    expect(() => parseAddress(':id')).toThrow('Invalid address');
    expect(() => parseAddress('prefix:')).toThrow('Invalid address');
  });
});

describe('parseAgentAddress', () => {
  it('parses address without channel', () => {
    expect(parseAgentAddress('agent:main')).toEqual({
      prefix: 'agent',
      id: 'main',
      channel: undefined,
    });
  });

  it('parses address with channel', () => {
    expect(parseAgentAddress('agent:main/scratch')).toEqual({
      prefix: 'agent',
      id: 'main',
      channel: 'scratch',
    });
  });

  it('works for non-agent prefixes too', () => {
    expect(parseAgentAddress('ext:email/inbox')).toEqual({
      prefix: 'ext',
      id: 'email',
      channel: 'inbox',
    });
  });

  it('rejects empty id or channel', () => {
    expect(() => parseAgentAddress('agent:/scratch')).toThrow('empty id or channel');
    expect(() => parseAgentAddress('agent:main/')).toThrow('empty id or channel');
  });

  it('rejects malformed addresses', () => {
    expect(() => parseAgentAddress('')).toThrow('Invalid agent address');
    expect(() => parseAgentAddress('nocolon')).toThrow('Invalid agent address');
  });
});

describe('hasPrefix', () => {
  it('returns true for matching prefix', () => {
    expect(hasPrefix('agent:main', 'agent')).toBe(true);
    expect(hasPrefix('cli:alice', 'cli')).toBe(true);
  });

  it('returns false for non-matching prefix', () => {
    expect(hasPrefix('agent:main', 'cli')).toBe(false);
    expect(hasPrefix('cli:alice', 'agent')).toBe(false);
  });

  it('does not match partial prefixes', () => {
    expect(hasPrefix('agent:main', 'agen')).toBe(false);
  });
});

describe('buildAddress', () => {
  it('builds base address', () => {
    expect(buildAddress('agent', 'main')).toBe('agent:main');
    expect(buildAddress('cli', 'alice')).toBe('cli:alice');
  });

  it('builds address with channel', () => {
    expect(buildAddress('agent', 'main', 'scratch')).toBe('agent:main/scratch');
  });

  it('omits channel when undefined', () => {
    expect(buildAddress('agent', 'main', undefined)).toBe('agent:main');
  });
});

// ---------------------------------------------------------------------------
// Percent-encoding
// ---------------------------------------------------------------------------

describe('encodeAddressValue / decodeAddressValue', () => {
  it('encodes reserved characters', () => {
    expect(encodeAddressValue('a%b')).toBe('a%25b');
    expect(encodeAddressValue('a/b')).toBe('a%2Fb');
    expect(encodeAddressValue('a:b')).toBe('a%3Ab');
    expect(encodeAddressValue('a~b')).toBe('a%7Eb');
    expect(encodeAddressValue('a|b')).toBe('a%7Cb');
    expect(encodeAddressValue('a@b')).toBe('a%40b');
  });

  it('passes through safe strings unchanged', () => {
    expect(encodeAddressValue('hello-world_123')).toBe('hello-world_123');
  });

  it('roundtrips', () => {
    const samples = ['hello', 'a%b/c:d~e|f', '100%', '/root/', '::', 'user@host', 'u:abc@srv'];
    for (const s of samples) {
      expect(decodeAddressValue(encodeAddressValue(s))).toBe(s);
    }
  });
});

// ---------------------------------------------------------------------------
// Participant address validity
// ---------------------------------------------------------------------------

describe('isParticipantAddress', () => {
  it('returns true for bare user identities', () => {
    expect(isParticipantAddress('u:a7f3k@srv')).toBe(true);
    expect(isParticipantAddress('u:f9a68fcd75@a9bdb7')).toBe(true);
  });

  it('returns true for agent addresses', () => {
    expect(isParticipantAddress('a:abc123@srv')).toBe(true);
    expect(isParticipantAddress('a:f945514f3a@a5e1f2')).toBe(true);
  });

  it('returns true for operator surfaces', () => {
    expect(isParticipantAddress('cli:alice')).toBe(true);
    expect(isParticipantAddress('admin:local')).toBe(true);
  });

  it('returns false for compounds — the wire never rides the participant above the gateway', () => {
    expect(isParticipantAddress('u:a7f3k/tg:12345')).toBe(false);
    expect(isParticipantAddress('u:a7f3k@srv/tg:12345')).toBe(false);
    expect(isParticipantAddress('cli:alice/cli:alice')).toBe(false);
  });

  it('returns false for raw transport handles', () => {
    expect(isParticipantAddress('tg:12345')).toBe(false);
    expect(isParticipantAddress('web:abc')).toBe(false);
    expect(isParticipantAddress('email:x@y.z')).toBe(false);
  });
});

describe('extractIdentity', () => {
  it('extracts identity from compound address', () => {
    expect(extractIdentity('u:a7f3k/tg:12345')).toBe('u:a7f3k');
  });

  it('passes operator handles through as their own identity (no local sentinel)', () => {
    expect(extractIdentity('cli:alice')).toBe('cli:alice');
    expect(extractIdentity('admin:local')).toBe('admin:local');
  });

  it('passes through unresolved transport handles', () => {
    expect(extractIdentity('tg:12345')).toBe('tg:12345');
  });
});

describe('extractHandle', () => {
  it('extracts handle from compound address', () => {
    expect(extractHandle('u:a7f3k/tg:12345')).toBe('tg:12345');
  });

  it('passes through unresolved address', () => {
    expect(extractHandle('tg:12345')).toBe('tg:12345');
    expect(extractHandle('cli:alice')).toBe('cli:alice');
  });

  it('returns undefined for agent addresses (no transport handle)', () => {
    expect(extractHandle('a:abc123@srv')).toBeUndefined();
    expect(extractHandle('a:f945514f3a@a5e1f2')).toBeUndefined();
  });
});

describe('extractHandlePrefix', () => {
  it('extracts prefix from compound address', () => {
    expect(extractHandlePrefix('u:a7f3k/tg:12345')).toBe('tg');
  });

  it('extracts prefix from unresolved address', () => {
    expect(extractHandlePrefix('tg:12345')).toBe('tg');
    expect(extractHandlePrefix('cli:alice')).toBe('cli');
  });
});

describe('isAgent', () => {
  it('returns true for agent GUIDs', () => {
    expect(isAgent('a:abc123@srv')).toBe(true);
    expect(isAgent('a:f945514f3a@a5e1f2')).toBe(true);
  });

  it('returns false for non-agent addresses', () => {
    expect(isAgent('tg:12345')).toBe(false);
    expect(isAgent('ext:email')).toBe(false);
    expect(isAgent('u:abc@srv')).toBe(false);
    expect(isAgent('agent:main')).toBe(false);
    expect(isAgent('my-agent@ca3aaa')).toBe(false);
  });
});

describe('isSystemSender', () => {
  it('returns true for agent GUIDs', () => {
    expect(isSystemSender('a:abc123@srv')).toBe(true);
  });

  it('returns true for ext: addresses', () => {
    expect(isSystemSender('ext:email')).toBe(true);
  });

  it('returns false for user addresses', () => {
    expect(isSystemSender('tg:12345')).toBe(false);
    expect(isSystemSender('cli:alice')).toBe(false);
    expect(isSystemSender('u:abc/tg:12345')).toBe(false);
  });
});

describe('isSystemContext', () => {
  const OWN = 'a:me@srv';

  it('returns true when there is no participant (system / scheduler fire)', () => {
    expect(isSystemContext(null, OWN)).toBe(true);
    expect(isSystemContext(undefined, OWN)).toBe(true);
  });

  it("returns true when the participant is the agent's own address", () => {
    expect(isSystemContext(OWN, OWN)).toBe(true);
  });

  it('returns false for a PEER agent — the masquerade case', () => {
    expect(isSystemContext('a:other@srv', OWN)).toBe(false);
  });

  it('returns false for a user participant', () => {
    expect(isSystemContext('u:abc@srv/tg:12345', OWN)).toBe(false);
    expect(isSystemContext('admin:local', OWN)).toBe(false);
  });

  it('is DISTINCT from isSystemSender: a peer is a system *sender* but not system *context*', () => {
    expect(isSystemSender('a:other@srv')).toBe(true);
    expect(isSystemContext('a:other@srv', OWN)).toBe(false);
  });
});

describe('isOperatorTier', () => {
  it('returns true for the operator — cli:/admin: handle (bare or the handle part of a compound)', () => {
    expect(isOperatorTier('cli:alice')).toBe(true);
    expect(isOperatorTier('admin:local')).toBe(true);
    expect(isOperatorTier('admin:local/admin:local')).toBe(true);
  });

  it('returns false for users, agents, services, and routed handles', () => {
    expect(isOperatorTier('u:abc@srv')).toBe(false);
    expect(isOperatorTier('u:abc@srv/tg:12345')).toBe(false);
    expect(isOperatorTier('a:x@srv')).toBe(false);
    expect(isOperatorTier('ext:email')).toBe(false);
    expect(isOperatorTier('tg:12345')).toBe(false);
  });
});

describe('isUser', () => {
  it('returns true for u: identities (bare or compound) and the operator', () => {
    expect(isUser('u:abc@srv')).toBe(true);
    expect(isUser('u:abc@srv/tg:12345')).toBe(true);
    expect(isUser('cli:alice')).toBe(true);
    expect(isUser('admin:local')).toBe(true);
  });

  it('returns false for agents and services', () => {
    expect(isUser('a:x@srv')).toBe(false);
    expect(isUser('ext:email')).toBe(false);
  });
});

describe('isReadTier', () => {
  const OWN = 'a:self@srv';

  it('returns true for system context (null participant or own address)', () => {
    expect(isReadTier(null, OWN)).toBe(true);
    expect(isReadTier(undefined, OWN)).toBe(true);
    expect(isReadTier(OWN, OWN)).toBe(true);
  });

  it('returns true for operator surfaces — bare cli:/admin: handles', () => {
    expect(isReadTier('cli:alice', OWN)).toBe(true);
    expect(isReadTier('admin:local', OWN)).toBe(true);
  });

  it('returns false for users — including a would-be configured owner identity', () => {
    // The owner arm lives in the WRITE tier (isOperatorOrOwner), never here:
    // a u: identity is member-tier for reads regardless of acl owner config.
    expect(isReadTier('u:abc@srv', OWN)).toBe(false);
    expect(isReadTier('u:abc@srv/tg:12345', OWN)).toBe(false);
  });

  it('returns false for peer agents and services — the masquerade case', () => {
    expect(isReadTier('a:other@srv', OWN)).toBe(false);
    expect(isReadTier('ext:email', OWN)).toBe(false);
  });
});

describe('isMember', () => {
  it('returns true when the bits include i (user placement) or a (agent placement)', () => {
    expect(isMember('i')).toBe(true);
    expect(isMember('a')).toBe(true);
    expect(isMember('io')).toBe(true);
    expect(isMember('qra')).toBe(true); // has 'a'
  });

  it('returns false for empty bits or bits without i/a', () => {
    expect(isMember('')).toBe(false);
    expect(isMember('o')).toBe(false);
    expect(isMember('qr')).toBe(false);
  });
});

describe('isExtAddress', () => {
  it('returns true for ext: addresses', () => {
    expect(isExtAddress('ext:email')).toBe(true);
    expect(isExtAddress('ext:web-fetch')).toBe(true);
  });

  it('returns false for non-ext addresses', () => {
    expect(isExtAddress('a:abc@srv')).toBe(false);
    expect(isExtAddress('cli:operator')).toBe(false);
    expect(isExtAddress('u:abc@srv/tg:12345')).toBe(false);
    expect(isExtAddress('agent:main')).toBe(false);
  });
});
