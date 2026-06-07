import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

vi.mock('./config.js', () => ({
  agentPath: (folder: string, ...segments: string[]) =>
    path.join('/tmp/test-agents', folder, ...segments),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(() => { throw new Error('not found'); }),
      statSync: vi.fn(() => ({ mtimeMs: Date.now() })),
    },
  };
});

vi.mock('./profiles/index.js', () => ({
  getProfile: (name: string) => {
    if (name === 'minimal') return { prompt: 'Minimal profile prompt.', skills: 'Minimal profile skills.', bootstrap: '', cleanup: '' };
    return { prompt: 'Standard profile prompt.', skills: 'Standard profile skills.', bootstrap: 'Profile bootstrap.', cleanup: 'Profile cleanup.' };
  },
}));

import fs from 'fs';
import { assembleSystemPrompt } from './agent/prompt-assembly.js';
import type { PromptAssemblyOpts } from './agent/prompt-assembly.js';
import { _setMockWatcher } from './lib/config-reader.js';

const mockReadFileSync = vi.mocked(fs.readFileSync);

function baseOpts(overrides?: Partial<PromptAssemblyOpts>): PromptAssemblyOpts {
  return {
    agentFolder: 'test-agent',
    agentName: 'test',
    participant: 'cli:alice',
    channel: { idle_timeout: 86400000, bootstrapEnabled: false, cleanupEnabled: false, log_messages: true, use_sharding: false, disabled_tools: [] },
    channelName: 'default',
    ...overrides,
  };
}

describe('assembleSystemPrompt', () => {
  beforeEach(() => {
    // Mock watcher delegates to the existing fs.readFileSync mock —
    // tests continue to use mockReadFileSync.mockImplementation() for file setup.
    _setMockWatcher({
      get: (p) => { try { return mockReadFileSync(p, 'utf-8') as string; } catch { return null; } },
    });
    mockReadFileSync.mockReset();
    mockReadFileSync.mockImplementation(() => { throw new Error('not found'); });
  });

  it('includes protocol layer with directory layout', () => {
    const result = assembleSystemPrompt(baseOpts());
    expect(result).toContain('<cast-protocol>');
    expect(result).toContain('/home/agent');
    expect(result).toContain('/identity');
    expect(result).toContain('/memory');
    expect(result).toContain('</cast-protocol>');
  });

  it('protocol layer contains only directory layout and network access', () => {
    const result = assembleSystemPrompt(baseOpts());
    const protocol = result.slice(result.indexOf('<cast-protocol>'), result.indexOf('</cast-protocol>'));
    expect(protocol).toContain('Directory Layout');
    expect(protocol).toContain('Network Access');
    expect(protocol).not.toContain('Communication');
    expect(protocol).not.toContain('Memory');
  });

  it('does not include main agent references for any agent', () => {
    const result = assembleSystemPrompt(baseOpts({ agentFolder: 'main' }));
    expect(result).not.toContain('main agent');
    expect(result).not.toContain('Admin Context');
    expect(result).not.toContain('elevated privileges');
  });

  it('includes prompt.md when file exists', () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('prompt.md')) return 'You are a helpful assistant.';
      throw new Error('not found');
    });

    const result = assembleSystemPrompt(baseOpts());
    expect(result).toContain('You are a helpful assistant.');
  });

  it('wraps whoami.md in agent-identity tags', () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('whoami.md')) return '# Identity\n- Name: Andy';
      throw new Error('not found');
    });

    const result = assembleSystemPrompt(baseOpts());
    expect(result).toContain('<agent-identity>');
    expect(result).toContain('# Identity');
    expect(result).toContain('</agent-identity>');
  });

  it('includes skills.md in agent-skills tags', () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('skills.md')) return '## Memory\nUse /memory for notes.';
      throw new Error('not found');
    });

    const result = assembleSystemPrompt(baseOpts());
    expect(result).toContain('<agent-skills>');
    expect(result).toContain('Use /memory for notes.');
    expect(result).toContain('</agent-skills>');
  });

  it('does not inject INSTRUCTIONS.md from memory/', () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('INSTRUCTIONS.md')) return '# My instructions';
      throw new Error('not found');
    });

    const result = assembleSystemPrompt(baseOpts());
    expect(result).not.toContain('<agent-instructions>');
  });

  it('includes agent-context.md from shared/ext/service/ when present', () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('agent-context.md')) return 'Weather: Sunny 72F';
      throw new Error('not found');
    });

    const result = assembleSystemPrompt(baseOpts());
    expect(result).toContain('<service-context>');
    expect(result).toContain('Weather: Sunny 72F');
  });

  it('includes conversation context with the bare participant identity (transport-blind)', () => {
    const result = assembleSystemPrompt(baseOpts({ participant: 'u:abc123@srv' }));
    expect(result).toContain('<conversation-context>');
    expect(result).toContain('id="u:abc123@srv"');
    // The transport handle is stripped at the gateway and never reaches the prompt.
    expect(result).not.toContain('handle=');
    expect(result).toContain('name="default"');
  });

  it('throws on a raw transport handle', () => {
    expect(() => assembleSystemPrompt(baseOpts({ participant: 'tg:12345' }))).toThrow('Invalid participant');
  });

  it('throws on a compound participant — the wire never rides the participant above the gateway', () => {
    expect(() => assembleSystemPrompt(baseOpts({ participant: 'u:abc123@srv/tg:12345' }))).toThrow('Invalid participant');
  });

  it('accepts a bare user identity on a cold spawn (push/scheduler targeting form)', () => {
    // Regression: pre-108 the guard demanded the compound, so push- and
    // scheduler-originated cold spawns (which carry the bare identity) threw.
    const result = assembleSystemPrompt(baseOpts({ participant: 'u:f9a68fcd75@a9bdb7' }));
    expect(result).toContain('id="u:f9a68fcd75@a9bdb7"');
  });

  it('skips empty files', () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('skills.md')) return '   \n  ';
      throw new Error('not found');
    });

    const result = assembleSystemPrompt(baseOpts());
    expect(result).not.toContain('<agent-skills>');
  });

  it('includes sdk-only network info by default', () => {
    const result = assembleSystemPrompt(baseOpts());
    expect(result).toContain('Direct network access is not available');
    expect(result).toContain('WebSearch** tool for web lookups');
  });

  it('includes sdk-only network info when explicitly set', () => {
    const result = assembleSystemPrompt(baseOpts({ containerNetwork: 'sdk-only' }));
    expect(result).toContain('Direct network access is not available');
    expect(result).toContain('WebSearch** tool for web lookups');
  });

  it('escapes XML special characters in participant IDs', () => {
    const result = assembleSystemPrompt(baseOpts({ participant: 'u:a<script>@srv' }));
    expect(result).toContain('id="u:a&lt;script&gt;@srv"');
  });

  it('strips HTML comments from file contents', () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('whoami.md')) return '# Identity\n<!-- base defaults -->\n- Name: Andy\n<!-- overrides -->\n- Location: Durham';
      throw new Error('not found');
    });

    const result = assembleSystemPrompt(baseOpts());
    expect(result).toContain('Name: Andy');
    expect(result).toContain('Location: Durham');
    expect(result).not.toContain('<!-- base defaults -->');
    expect(result).not.toContain('<!-- overrides -->');
  });

  it('strips comments from skills.md', () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('skills.md')) return '## Skill\n<!-- internal note -->\nDo the thing.';
      throw new Error('not found');
    });

    const result = assembleSystemPrompt(baseOpts());
    expect(result).toContain('Do the thing.');
    expect(result).not.toContain('internal note');
  });

  it('returns null for files that are only comments', () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('skills.md')) return '<!-- placeholder -->';
      throw new Error('not found');
    });

    const result = assembleSystemPrompt(baseOpts());
    expect(result).not.toContain('<agent-skills>');
  });

  it('injects profile prompt and skills before prompt.md', () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (String(p).endsWith('prompt.md')) return 'You are a helpful assistant.';
      throw new Error('not found');
    });

    const result = assembleSystemPrompt(baseOpts());
    expect(result).toContain('<agent-profile>');
    expect(result).toContain('Standard profile prompt.');
    expect(result).toContain('<agent-profile-skills>');
    expect(result).toContain('Standard profile skills.');
    // Both profile layers should appear before prompt.md
    const profileIdx = result.indexOf('<agent-profile>');
    const skillsIdx = result.indexOf('<agent-profile-skills>');
    const promptIdx = result.indexOf('You are a helpful assistant.');
    expect(profileIdx).toBeLessThan(skillsIdx);
    expect(skillsIdx).toBeLessThan(promptIdx);
  });

  it('injects minimal profile for minimal profile', () => {
    const result = assembleSystemPrompt(baseOpts({ profileName: 'minimal' }));
    expect(result).toContain('Minimal profile prompt.');
    expect(result).toContain('Minimal profile skills.');
    expect(result).not.toContain('Standard profile');
  });

  it('omits other-participants block when none are present', () => {
    const result = assembleSystemPrompt(baseOpts({ otherChannelParticipants: [] }));
    expect(result).not.toContain('<other-participants>');
  });

  it('renders other-participants block with names and relative times', () => {
    const result = assembleSystemPrompt(baseOpts({
      otherChannelParticipants: [
        { name: 'Bob', lastActive: '3h ago' },
        { name: 'Carol', lastActive: 'yesterday' },
      ],
    }));
    expect(result).toContain('<other-participants>Bob (3h ago), Carol (yesterday)</other-participants>');
  });

  it('emits an explicit disabled marker (not a blank) when show_co_participants is false', () => {
    const result = assembleSystemPrompt(baseOpts({
      channel: {
        idle_timeout: 86400000,
        bootstrapEnabled: false,
        cleanupEnabled: false,
        log_messages: true,
        use_sharding: false,
        disabled_tools: [],
        show_co_participants: false,
      },
      otherChannelParticipants: [{ name: 'Bob', lastActive: '3h ago' }],
    }));
    expect(result).toContain('<other-participants visibility="disabled" />');
    expect(result).not.toContain('Bob');
  });

  it('appends …more when the participant list is capped', () => {
    const result = assembleSystemPrompt(baseOpts({
      otherChannelParticipants: [{ name: 'Bob', lastActive: '3h ago' }],
      moreChannelParticipants: true,
    }));
    expect(result).toContain('<other-participants>Bob (3h ago), …more</other-participants>');
  });

  it('escapes XML special characters in participant names', () => {
    const result = assembleSystemPrompt(baseOpts({
      otherChannelParticipants: [{ name: '<b>', lastActive: '1h ago' }],
    }));
    expect(result).toContain('&lt;b&gt; (1h ago)');
  });

});
