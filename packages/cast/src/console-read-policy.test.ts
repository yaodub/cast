import { describe, it, expect } from 'vitest';

import { isReadable, POLICIES, WALKER_BLACKLIST, type ManagerConsole } from './console/shared/read-policy.js';

const CONSOLES: ManagerConsole[] = ['design-manager', 'config-manager', 'security-manager'];

describe('isReadable — path safety', () => {
  it.each(CONSOLES)('rejects absolute paths (%s)', (c) => {
    expect(isReadable(c, '/blueprint/prompt.md')).toBe(false);
    expect(isReadable(c, '/etc/passwd')).toBe(false);
  });

  it.each(CONSOLES)('rejects empty string (%s)', (c) => {
    expect(isReadable(c, '')).toBe(false);
  });

  it.each(CONSOLES)('rejects leading `..` (%s)', (c) => {
    expect(isReadable(c, '../../secrets/agent.key')).toBe(false);
    expect(isReadable(c, '../blueprint/prompt.md')).toBe(false);
  });

  it.each(CONSOLES)('rejects interior `..` segment that escapes (%s)', (c) => {
    // normalize('blueprint/../../etc/passwd') → '../etc/passwd' → leading `..`
    expect(isReadable(c, 'blueprint/../../etc/passwd')).toBe(false);
  });

  it.each(CONSOLES)('accepts `.` segments after normalization (%s)', (c) => {
    // normalize('blueprint/./prompt.md') → 'blueprint/prompt.md'
    expect(isReadable(c, 'blueprint/./prompt.md')).toBe(true);
  });

  it.each(CONSOLES)('rejects `.` alone (%s)', (c) => {
    expect(isReadable(c, '.')).toBe(false);
  });
});

describe('isReadable — Layer 1 include allowlist', () => {
  describe('design-manager', () => {
    it('admits blueprint/**', () => {
      expect(isReadable('design-manager', 'blueprint/prompt.md')).toBe(true);
      expect(isReadable('design-manager', 'blueprint/channels/default/prompt.md')).toBe(true);
      expect(isReadable('design-manager', 'blueprint')).toBe(true);
    });

    it('rejects config/** (DM is blueprint-only)', () => {
      expect(isReadable('design-manager', 'config/agent.json')).toBe(false);
      expect(isReadable('design-manager', 'config/acl.json')).toBe(false);
    });
  });

  describe('config-manager + security-manager', () => {
    it.each(['config-manager', 'security-manager'] as const)('admits blueprint/** (%s)', (c) => {
      expect(isReadable(c, 'blueprint/prompt.md')).toBe(true);
      expect(isReadable(c, 'blueprint/channels/default/prompt.md')).toBe(true);
    });

    it.each(['config-manager', 'security-manager'] as const)('admits config/** (%s)', (c) => {
      expect(isReadable(c, 'config/agent.json')).toBe(true);
      expect(isReadable(c, 'config/acl.json')).toBe(true);
      expect(isReadable(c, 'config/ext/whatsapp/config.json')).toBe(true);
      expect(isReadable(c, 'config/ext/whatsapp/secrets.json')).toBe(true);
    });
  });

  it.each(CONSOLES)('rejects state/ (%s)', (c) => {
    expect(isReadable(c, 'state/conversations.jsonl')).toBe(false);
  });

  it.each(CONSOLES)('rejects secrets/ (%s)', (c) => {
    expect(isReadable(c, 'secrets/agent.key')).toBe(false);
  });

  it.each(CONSOLES)('rejects ext/ private runtime (%s)', (c) => {
    expect(isReadable(c, 'ext/whatsapp/messages.db')).toBe(false);
    expect(isReadable(c, 'ext/email/cache.json')).toBe(false);
  });

  it.each(CONSOLES)('rejects shared/ agent-visible output (%s)', (c) => {
    expect(isReadable(c, 'shared/ext/email/output.json')).toBe(false);
    expect(isReadable(c, 'shared/ext/service/agent-context.md')).toBe(false);
  });

  it.each(CONSOLES)('rejects home/, memory/, sessions/, staging/, logs/, mcp/ (%s)', (c) => {
    expect(isReadable(c, 'home/notes.md')).toBe(false);
    expect(isReadable(c, 'memory/MEMORY.md')).toBe(false);
    expect(isReadable(c, 'sessions/abc.json')).toBe(false);
    expect(isReadable(c, 'staging/tmp.txt')).toBe(false);
    expect(isReadable(c, 'logs/agent.log')).toBe(false);
    expect(isReadable(c, 'mcp/cast.sock')).toBe(false);
  });

  it.each(CONSOLES)('rejects manifest.json at agent root (%s) — reaches prompts via snapshot', (c) => {
    expect(isReadable(c, 'manifest.json')).toBe(false);
  });
});

describe('isReadable — Layer 2 universal blacklist', () => {
  it.each(CONSOLES)('rejects node_modules anywhere (%s)', (c) => {
    expect(isReadable(c, 'blueprint/node_modules/lodash/index.js')).toBe(false);
    expect(isReadable(c, 'blueprint/service/node_modules/x/y.js')).toBe(false);
  });

  it.each(CONSOLES)('rejects .git (%s)', (c) => {
    expect(isReadable(c, 'blueprint/.git/HEAD')).toBe(false);
  });

  it.each(CONSOLES)('rejects dist + build (%s)', (c) => {
    expect(isReadable(c, 'blueprint/service/dist/index.js')).toBe(false);
    expect(isReadable(c, 'blueprint/service/build/bundle.js')).toBe(false);
  });

  it.each(CONSOLES)('rejects .venv (%s)', (c) => {
    expect(isReadable(c, 'blueprint/.venv/bin/python')).toBe(false);
  });

  it.each(CONSOLES)('rejects *.log (%s)', (c) => {
    expect(isReadable(c, 'blueprint/run.log')).toBe(false);
    expect(isReadable(c, 'blueprint/channels/default/debug.log')).toBe(false);
  });

  it('blacklist wins over allowlist', () => {
    // blueprint/** admits, but node_modules inside it is still blocked.
    expect(isReadable('config-manager', 'blueprint/node_modules/foo/index.js')).toBe(false);
  });
});

describe('POLICIES + WALKER_BLACKLIST shape', () => {
  it('covers exactly the three manager consoles', () => {
    expect(Object.keys(POLICIES).sort()).toEqual(
      ['config-manager', 'design-manager', 'security-manager'],
    );
  });

  it('DM scope is narrower than CM/SM', () => {
    expect(POLICIES['design-manager'].length).toBeLessThan(POLICIES['config-manager'].length);
    expect(POLICIES['config-manager']).toEqual(POLICIES['security-manager']);
  });

  it('blacklist is non-empty and all entries are supported glob shapes', () => {
    expect(WALKER_BLACKLIST.length).toBeGreaterThan(0);
    // Smoke: each pattern must produce a boolean against some probe path without throwing.
    for (const p of WALKER_BLACKLIST) {
      expect(() => isReadable('config-manager', `blueprint/${p.replace(/[*]/g, 'x')}`)).not.toThrow();
    }
  });
});
