import { describe, it, expect } from 'vitest';
import { AgentConfigSchema, ModelOverrideEntrySchema } from '@getcast/agent-schema/v1';

describe('ModelOverrideEntrySchema', () => {
  it('accepts a channel-only entry', () => {
    expect(
      ModelOverrideEntrySchema.safeParse({ channel: 'email', model: 'claude-haiku-4-5' }).success,
    ).toBe(true);
  });

  it('accepts a channel + bootstrap phase entry', () => {
    expect(
      ModelOverrideEntrySchema.safeParse({
        channel: 'email',
        phase: 'bootstrap',
        model: 'claude-haiku-4-5',
      }).success,
    ).toBe(true);
  });

  it('accepts a channel + cleanup phase entry', () => {
    expect(
      ModelOverrideEntrySchema.safeParse({
        channel: 'email',
        phase: 'cleanup',
        model: 'claude-haiku-4-5',
      }).success,
    ).toBe(true);
  });

  it('rejects a missing channel', () => {
    const result = ModelOverrideEntrySchema.safeParse({ model: 'claude-haiku-4-5' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty channel string', () => {
    const result = ModelOverrideEntrySchema.safeParse({ channel: '', model: 'x' });
    expect(result.success).toBe(false);
  });

  it('rejects console channels (__-prefixed)', () => {
    const result = ModelOverrideEntrySchema.safeParse({
      channel: '__configure',
      model: 'claude-haiku-4-5',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/console channel/i);
    }
  });

  it('rejects an empty model string', () => {
    const result = ModelOverrideEntrySchema.safeParse({ channel: 'email', model: '' });
    expect(result.success).toBe(false);
  });

  it('rejects phase: "main" (not in enum)', () => {
    const result = ModelOverrideEntrySchema.safeParse({
      channel: 'email',
      phase: 'main',
      model: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown phase value', () => {
    const result = ModelOverrideEntrySchema.safeParse({
      channel: 'email',
      phase: 'foo',
      model: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys (service)', () => {
    const result = ModelOverrideEntrySchema.safeParse({
      channel: 'email',
      service: 'reflector',
      model: 'x',
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys (tier)', () => {
    const result = ModelOverrideEntrySchema.safeParse({
      channel: 'email',
      tier: 'vip',
      model: 'x',
    });
    expect(result.success).toBe(false);
  });
});

describe('AgentConfigSchema modelOverrides', () => {
  it('accepts a config with no modelOverrides field', () => {
    expect(AgentConfigSchema.safeParse({ model: 'claude-sonnet-4-6' }).success).toBe(true);
  });

  it('accepts a config with multiple distinct overrides', () => {
    const cfg = {
      model: 'claude-sonnet-4-6',
      modelOverrides: [
        { channel: 'email', model: 'claude-haiku-4-5' },
        { channel: 'analysis', model: 'claude-opus-4-7' },
        { channel: 'default', phase: 'cleanup', model: 'claude-haiku-4-5' },
      ],
    };
    expect(AgentConfigSchema.safeParse(cfg).success).toBe(true);
  });

  it('accepts same channel with different phases (and channel-only)', () => {
    const cfg = {
      modelOverrides: [
        { channel: 'email', model: 'a' },
        { channel: 'email', phase: 'bootstrap', model: 'b' },
        { channel: 'email', phase: 'cleanup', model: 'c' },
      ],
    };
    expect(AgentConfigSchema.safeParse(cfg).success).toBe(true);
  });

  it('rejects duplicate (channel, phase=undefined) entries', () => {
    const cfg = {
      modelOverrides: [
        { channel: 'email', model: 'a' },
        { channel: 'email', model: 'b' },
      ],
    };
    const result = AgentConfigSchema.safeParse(cfg);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toMatch(/duplicate/i);
    }
  });

  it('rejects duplicate (channel, phase=bootstrap) entries', () => {
    const cfg = {
      modelOverrides: [
        { channel: 'email', phase: 'bootstrap', model: 'a' },
        { channel: 'email', phase: 'bootstrap', model: 'b' },
      ],
    };
    expect(AgentConfigSchema.safeParse(cfg).success).toBe(false);
  });
});
