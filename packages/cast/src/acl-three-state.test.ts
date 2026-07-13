/**
 * Three-state ACL schema + q⊇r.
 *
 * Covers the additive schema changes: the `allowed` grant map, the `rejected`
 * tombstone map, the q⊇r hierarchy validation, and the `canEmit` check-time
 * implication. Schema-level (direct `AclSchema.parse` /
 * `canEmit`) — the fs-mocked `checkAcl` path is exercised in acl.test.ts.
 */
import { describe, it, expect } from 'vitest';

import { AclSchema, canEmit } from './auth/acl.js';

describe('canEmit — q ⊇ r capability hierarchy', () => {
  it('query requires q (r alone does not imply q)', () => {
    expect(canEmit('q', 'query')).toBe(true);
    expect(canEmit('r', 'query')).toBe(false);
    expect(canEmit('', 'query')).toBe(false);
  });

  it('request accepts q (q implies r) or r', () => {
    expect(canEmit('q', 'request')).toBe(true);  // the widening: q ⊇ r
    expect(canEmit('r', 'request')).toBe(true);
    expect(canEmit('qr', 'request')).toBe(true);
    expect(canEmit('io', 'request')).toBe(false);
  });
});

describe('AclSchema — allowed/rejected maps', () => {
  it('accepts canonical `allowed`', () => {
    const acl = AclSchema.parse({ allowed: { 'u:a@t': { '*': 'io' } } });
    expect(acl.allowed).toEqual({ 'u:a@t': { '*': 'io' } });
  });

  it('accepts a `rejected` tombstone map (dormant in Phase 0)', () => {
    const acl = AclSchema.parse({
      allowed: { 'u:a@t': { '*': 'io' } },
      rejected: { 'u:b@t': { secret: 'q' } },
    });
    expect(acl.rejected).toEqual({ 'u:b@t': { secret: 'q' } });
  });

  it('still rejects unknown keys (strict)', () => {
    expect(() => AclSchema.parse({ peerz: {} })).toThrow();
  });
});

describe('AclSchema — q ⊇ r hierarchy validation', () => {
  it('rejects `r` rejected while `q` granted on the same edge', () => {
    expect(() => AclSchema.parse({
      allowed: { 'u:a@t': { ch: 'q' } },
      rejected: { 'u:a@t': { ch: 'r' } },
    })).toThrow(/query implies request/);
  });

  it('allows `r` rejected when no `q` is granted on that edge', () => {
    const acl = AclSchema.parse({
      allowed: { 'u:a@t': { ch: 'io' } },
      rejected: { 'u:a@t': { ch: 'r' } },
    });
    expect(acl.rejected['u:a@t']).toEqual({ ch: 'r' });
  });

  it('applies the agent-bit restriction to `rejected` entries too', () => {
    expect(() => AclSchema.parse({
      rejected: { 'a:x@t': { ch: 'io' } }, // agents restricted to q/r/a
    })).toThrow(/cannot hold bits/);
  });
});
