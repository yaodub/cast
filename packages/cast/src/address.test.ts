import { describe, expect, it } from 'vitest';

import {
  buildAddress,
  buildResolvedParticipant,
  decodeAddressValue,
  encodeAddressValue,
  extractHandle,
  extractHandlePrefix,
  extractIdentity,
  hasPrefix,
  isAgent,
  isExtAddress,
  isResolved,
  isSystemSender,
  parseAddress,
  parseAgentAddress,
  parseResolvedParticipant,
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
// Compound address types & parser
// ---------------------------------------------------------------------------

describe('isResolved', () => {
  it('returns true for compound addresses', () => {
    expect(isResolved('u:a7f3k/tg:12345')).toBe(true);
    expect(isResolved('local/cli:alice')).toBe(true);
  });

  it('returns true for agent addresses (inherently resolved)', () => {
    expect(isResolved('a:abc123@srv')).toBe(true);
    expect(isResolved('a:f945514f3a@a5e1f2')).toBe(true);
  });

  it('returns false for unresolved addresses', () => {
    expect(isResolved('tg:12345')).toBe(false);
    expect(isResolved('cli:alice')).toBe(false);
  });
});

describe('parseResolvedParticipant', () => {
  it('parses compound address', () => {
    expect(parseResolvedParticipant('u:a7f3k/tg:12345')).toEqual({
      identity: 'u:a7f3k',
      handle: 'tg:12345',
    });
  });

  it('parses local identity', () => {
    expect(parseResolvedParticipant('local/cli:alice')).toEqual({
      identity: 'local',
      handle: 'cli:alice',
    });
  });

  it('throws on unresolved address', () => {
    expect(() => parseResolvedParticipant('tg:12345')).toThrow('Not a resolved address');
  });
});

describe('buildResolvedParticipant', () => {
  it('builds compound address', () => {
    expect(buildResolvedParticipant('u:a7f3k', 'tg:12345')).toBe('u:a7f3k/tg:12345');
    expect(buildResolvedParticipant('local', 'cli:alice')).toBe('local/cli:alice');
  });
});

describe('extractIdentity', () => {
  it('extracts identity from compound address', () => {
    expect(extractIdentity('u:a7f3k/tg:12345')).toBe('u:a7f3k');
    expect(extractIdentity('local/cli:alice')).toBe('local');
  });

  it('passes through unresolved address', () => {
    expect(extractIdentity('tg:12345')).toBe('tg:12345');
    expect(extractIdentity('cli:alice')).toBe('cli:alice');
  });
});

describe('extractHandle', () => {
  it('extracts handle from compound address', () => {
    expect(extractHandle('u:a7f3k/tg:12345')).toBe('tg:12345');
    expect(extractHandle('local/cli:alice')).toBe('cli:alice');
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
    expect(extractHandlePrefix('local/cli:alice')).toBe('cli');
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
