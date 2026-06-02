import { describe, it, expect } from 'vitest';

import {
  ChannelJsonSchema,
  DEFAULT_CHANNEL,
  DEFAULT_CHANNEL_JSON,
} from './types.js';

describe('show_co_participants channel flag — schema', () => {
  it('defaults to true when omitted', () => {
    const parsed = ChannelJsonSchema.parse({ idle_timeout: 1_800_000 });
    expect(parsed.show_co_participants).toBe(true);
  });

  it('accepts an explicit false', () => {
    const parsed = ChannelJsonSchema.parse({ idle_timeout: null, show_co_participants: false });
    expect(parsed.show_co_participants).toBe(false);
  });

  it('rejects a non-boolean value', () => {
    expect(() =>
      ChannelJsonSchema.parse({ idle_timeout: null, show_co_participants: 'yes' }),
    ).toThrow();
  });

  it('still rejects unknown keys (.strict() intact)', () => {
    expect(() => ChannelJsonSchema.parse({ idle_timeout: null, unknown_key: true })).toThrow();
  });

  it('is true in the default-channel constants', () => {
    expect(DEFAULT_CHANNEL.show_co_participants).toBe(true);
    expect(DEFAULT_CHANNEL_JSON.show_co_participants).toBe(true);
  });
});
