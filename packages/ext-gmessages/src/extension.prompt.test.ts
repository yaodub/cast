/**
 * promptSection tests — it is injected every turn, so its content is a
 * behavioural surface: what it says (or fails to say) about modes is what the
 * agent believes it may do.
 */
import { describe, it, expect, vi } from 'vitest';

import { GmessagesExtension } from './extension.js';
import { GmessagesConfigSchema, type GmessagesConfig } from './schemas.js';
import type { ExtensionContext } from '@getcast/extension-schema';

function promptFor(config: Partial<GmessagesConfig>): string {
  const ctx = {
    config: GmessagesConfigSchema.parse(config),
    privateDir: '/tmp/unused-prompt',
    deliver: vi.fn(),
  } as unknown as ExtensionContext<GmessagesConfig, never>;
  return new GmessagesExtension(ctx).promptSection;
}

describe('promptSection', () => {
  it('always carries the two protocol facts an agent gets wrong by default', () => {
    const p = promptFor({});
    expect(p).toContain('SMS threads never report delivery');
    expect(p).toContain('raw participant id');
  });

  it('describes sending as disabled by default and offers no send guidance', () => {
    const p = promptFor({});
    expect(p).toContain('Sending is disabled.');
    // No point telling an agent how to send when it cannot.
    expect(p).not.toContain('IRREVERSIBLE');
  });

  it('warns about irreversibility and the cold-send limit once sending is on', () => {
    for (const mode of ['approval', 'direct'] as const) {
      const p = promptFor({ send_mode: mode });
      expect(p).toContain('IRREVERSIBLE');
      expect(p).toContain('conversation that already exists');
      expect(p).toContain('reading the thread back');
    }
  });

  it('reflects the read mode', () => {
    expect(promptFor({ read_mode: 'open' })).toContain('**Reading:** open.');
    expect(promptFor({ read_mode: 'disabled' })).toContain('All reads are blocked.');
    expect(promptFor({ read_mode: 'approval' })).toContain('asks the user for permission');
  });

  it('stays short enough to carry every turn', () => {
    // A prompt section is paid for on every turn; this is a regression guard,
    // not a style rule.
    expect(promptFor({ send_mode: 'approval' }).length).toBeLessThan(2000);
  });
});
