import { describe, it, expect } from 'vitest';

import { WebMessageSchema } from './web.js';

// Regression: the `approval_response` variant omitted `tier`, so the
// discriminated-union parse silently stripped it before the transport handler
// ran — downgrading every web-chat "Always approve" to a one-shot grant that
// never persisted. The owner could never establish a standing cross-agent
// reach from the chat prompt, no matter which button they clicked.
describe('WebMessageSchema — approval_response tier passthrough', () => {
  it('preserves tier=always on an approval_response (the standing-grant decision)', () => {
    const parsed = WebMessageSchema.parse({
      type: 'approval_response',
      handle: 'u:5ce6d52424@ce2719',
      agent: 'talker',
      id: 'b76531c0',
      decision: 'approved',
      tier: 'always',
    });
    expect(parsed.type).toBe('approval_response');
    if (parsed.type === 'approval_response') {
      expect(parsed.tier).toBe('always');
    }
  });

  it('preserves tier=once explicitly', () => {
    const parsed = WebMessageSchema.parse({
      type: 'approval_response',
      handle: 'u:5ce6d52424@ce2719',
      agent: 'talker',
      id: 'x',
      decision: 'approved',
      tier: 'once',
    });
    if (parsed.type === 'approval_response') {
      expect(parsed.tier).toBe('once');
    }
  });

  it('leaves tier undefined when omitted (optional field)', () => {
    const parsed = WebMessageSchema.parse({
      type: 'approval_response',
      handle: 'u:5ce6d52424@ce2719',
      agent: 'talker',
      id: 'x',
      decision: 'rejected',
    });
    if (parsed.type === 'approval_response') {
      expect(parsed.tier).toBeUndefined();
    }
  });
});
