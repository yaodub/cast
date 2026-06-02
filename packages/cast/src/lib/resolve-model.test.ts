import { describe, it, expect } from 'vitest';
import { AgentConfigSchema, type AgentConfig } from '@getcast/agent-schema/v1';
import { resolveModel } from './resolve-model.js';

// Helper: parse minimal config through the schema so all defaulted fields
// (e.g. containerAllowedEndpoints) are populated. Avoids per-test boilerplate.
function makeConfig(extra: Record<string, unknown>): AgentConfig {
  return AgentConfigSchema.parse({ ...extra });
}

const baseConfig: AgentConfig = makeConfig({ model: 'claude-sonnet-4-6' });

describe('resolveModel', () => {
  it('returns top-level model when no overrides exist', () => {
    expect(resolveModel(baseConfig, { channelName: 'default' })).toBe('claude-sonnet-4-6');
  });

  it('returns top-level model when context has no channelName', () => {
    const cfg: AgentConfig = {
      ...baseConfig,
      modelOverrides: [{ channel: 'email', model: 'claude-haiku-4-5' }],
    };
    expect(resolveModel(cfg, {})).toBe('claude-sonnet-4-6');
  });

  it('returns override model when a channel-only override matches', () => {
    const cfg: AgentConfig = {
      ...baseConfig,
      modelOverrides: [{ channel: 'email', model: 'claude-haiku-4-5' }],
    };
    expect(resolveModel(cfg, { channelName: 'email' })).toBe('claude-haiku-4-5');
  });

  it('returns top-level model when channel does not match any override', () => {
    const cfg: AgentConfig = {
      ...baseConfig,
      modelOverrides: [{ channel: 'email', model: 'claude-haiku-4-5' }],
    };
    expect(resolveModel(cfg, { channelName: 'default' })).toBe('claude-sonnet-4-6');
  });

  it('channel-only override matches a bootstrap spawn on that channel', () => {
    const cfg: AgentConfig = {
      ...baseConfig,
      modelOverrides: [{ channel: 'email', model: 'claude-haiku-4-5' }],
    };
    expect(resolveModel(cfg, { channelName: 'email', phase: 'bootstrap' })).toBe(
      'claude-haiku-4-5',
    );
  });

  it('channel-only override matches a cleanup spawn on that channel', () => {
    const cfg: AgentConfig = {
      ...baseConfig,
      modelOverrides: [{ channel: 'email', model: 'claude-haiku-4-5' }],
    };
    expect(resolveModel(cfg, { channelName: 'email', phase: 'cleanup' })).toBe(
      'claude-haiku-4-5',
    );
  });

  it('most-specific entry wins (channel+phase beats channel-only)', () => {
    const cfg: AgentConfig = {
      ...baseConfig,
      modelOverrides: [
        { channel: 'email', model: 'channel-only-model' },
        { channel: 'email', phase: 'cleanup', model: 'cleanup-specific-model' },
      ],
    };
    expect(resolveModel(cfg, { channelName: 'email', phase: 'cleanup' })).toBe(
      'cleanup-specific-model',
    );
    // Non-cleanup phases still fall through to channel-only:
    expect(resolveModel(cfg, { channelName: 'email', phase: 'bootstrap' })).toBe(
      'channel-only-model',
    );
    expect(resolveModel(cfg, { channelName: 'email' })).toBe('channel-only-model');
  });

  it('phase-specific entry does NOT match other phases', () => {
    const cfg: AgentConfig = {
      ...baseConfig,
      modelOverrides: [
        { channel: 'email', phase: 'bootstrap', model: 'bootstrap-model' },
      ],
    };
    expect(resolveModel(cfg, { channelName: 'email', phase: 'cleanup' })).toBe(
      'claude-sonnet-4-6',
    );
    expect(resolveModel(cfg, { channelName: 'email' })).toBe('claude-sonnet-4-6');
  });

  it('returns undefined when no override matches and top-level model is unset', () => {
    const cfg: AgentConfig = makeConfig({
      modelOverrides: [{ channel: 'email', model: 'claude-haiku-4-5' }],
    });
    expect(resolveModel(cfg, { channelName: 'default' })).toBeUndefined();
  });

  it('returns override even when top-level model is unset, if it matches', () => {
    const cfg: AgentConfig = makeConfig({
      modelOverrides: [{ channel: 'email', model: 'claude-haiku-4-5' }],
    });
    expect(resolveModel(cfg, { channelName: 'email' })).toBe('claude-haiku-4-5');
  });

  it('selects the right override across multiple channels', () => {
    const cfg: AgentConfig = {
      ...baseConfig,
      modelOverrides: [
        { channel: 'email', model: 'email-model' },
        { channel: 'analysis', model: 'analysis-model' },
        { channel: 'default', phase: 'cleanup', model: 'default-cleanup-model' },
      ],
    };
    expect(resolveModel(cfg, { channelName: 'email' })).toBe('email-model');
    expect(resolveModel(cfg, { channelName: 'analysis' })).toBe('analysis-model');
    expect(resolveModel(cfg, { channelName: 'default', phase: 'cleanup' })).toBe(
      'default-cleanup-model',
    );
    expect(resolveModel(cfg, { channelName: 'default' })).toBe('claude-sonnet-4-6');
  });
});
