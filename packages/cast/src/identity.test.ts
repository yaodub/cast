import { generateKeyPairSync } from 'crypto';
import { describe, it, expect, beforeEach } from 'vitest';

import { LocalIdentityProvider } from './auth/identity.js';
import type { IdentityProvider } from './auth/identity.js';

describe('LocalIdentityProvider', () => {
  let idp: IdentityProvider & { close(): void };

  beforeEach(() => {
    idp = LocalIdentityProvider._createTest();
  });

  describe('idpIdentifier', () => {
    it('generates a stable server ID', () => {
      const provider = idp as LocalIdentityProvider;
      expect(provider.idpIdentifier).toMatch(/^[a-z0-9]+$/);
      expect(provider.idpIdentifier.length).toBe(6);
    });

    it('identity IDs include the server ID', () => {
      const provider = idp as LocalIdentityProvider;
      const result = idp.register('tg:111', 'Test');
      expect(result.id).toContain(`@${provider.idpIdentifier}`);
    });
  });

  describe('resolve', () => {
    it('operator handles resolve to themselves (the handle IS the identity)', () => {
      expect(idp.resolve('cli:alice')).toEqual({ id: 'cli:alice', declaredName: 'alice', handle: 'cli:alice' });
      expect(idp.resolve('admin:local')).toEqual({ id: 'admin:local', declaredName: 'local', handle: 'admin:local' });
    });

    it('returns null for unknown handles', () => {
      expect(idp.resolve('tg:12345')).toBeNull();
    });

    it('resolves registered handles', () => {
      const reg = idp.register('tg:12345', 'Alice');
      const result = idp.resolve('tg:12345');
      expect(result).not.toBeNull();
      expect(result!.id).toBe(reg.id);
      expect(result!.declaredName).toBe('Alice');
      expect(result!.handle).toBe('tg:12345');
    });
  });

  describe('register', () => {
    it('creates identity with u: prefix and @issuer', () => {
      const result = idp.register('tg:99999', 'Bob');
      expect(result.id).toMatch(/^u:[a-z0-9]+@[a-z0-9]+$/);
      expect(result.declaredName).toBe('Bob');
      expect(result.handle).toBe('tg:99999');
    });

    it('stores pairedVia when provided', () => {
      const result = idp.register('tg:99999', 'Bob', 'main');
      const record = idp.getIdentity(result.id);
      expect(record).not.toBeNull();
      expect(record!.pairedVia).toBe('main');
    });
  });

  describe('updateDeclaredName', () => {
    it('updates the declared name', () => {
      const reg = idp.register('tg:12345', 'Alice');
      idp.updateDeclaredName(reg.id, 'Alicia');
      const resolved = idp.resolve('tg:12345');
      expect(resolved!.declaredName).toBe('Alicia');
    });
  });

  describe('getIdentity', () => {
    it('returns a synthetic record for operator handles (virtual, not in DB)', () => {
      const record = idp.getIdentity('admin:local');
      expect(record).not.toBeNull();
      expect(record!.id).toBe('admin:local');
      expect(record!.handles).toEqual([]);
    });

    it('returns null for unknown identity', () => {
      expect(idp.getIdentity('u:nonexistent')).toBeNull();
    });

    it('returns full record with handles', () => {
      const reg = idp.register('tg:12345', 'Alice');
      idp.linkHandle(reg.id, 'tg:67890');

      const record = idp.getIdentity(reg.id);
      expect(record).not.toBeNull();
      expect(record!.declaredName).toBe('Alice');
      expect(record!.handles).toContain('tg:12345');
      expect(record!.handles).toContain('tg:67890');
      expect(record!.handles).toHaveLength(2);
    });
  });

  describe('linkHandle', () => {
    it('links additional handle to existing identity', () => {
      const reg = idp.register('tg:12345', 'Alice');
      idp.linkHandle(reg.id, 'tg:67890');

      const resolved = idp.resolve('tg:67890');
      expect(resolved).not.toBeNull();
      expect(resolved!.id).toBe(reg.id);
      expect(resolved!.declaredName).toBe('Alice');
    });

    it('re-linking same handle is idempotent', () => {
      const reg = idp.register('tg:12345', 'Alice');
      idp.linkHandle(reg.id, 'tg:12345');
      const record = idp.getIdentity(reg.id);
      expect(record!.handles).toHaveLength(1);
    });
  });

  describe('getHandlesForIdentity', () => {
    it('returns the empty list for operator handles (no IdP-backed handle map)', () => {
      // Operator handles are their own wire — they bypass the IdP, so there is
      // no handle mapping to return (Stage D: identity === handle).
      expect(idp.getHandlesForIdentity('admin:local')).toEqual([]);
      expect(idp.getHandlesForIdentity('cli:alice')).toEqual([]);
    });

    it('returns the owned handles for a registered identity', () => {
      const reg = idp.register('tg:12345', 'Alice');
      idp.linkHandle(reg.id, 'tg:67890');
      expect(idp.getHandlesForIdentity(reg.id).sort()).toEqual(['tg:12345', 'tg:67890']);
    });
  });

  describe('verifyAgent', () => {
    function generateTestKey(): string {
      const { privateKey } = generateKeyPairSync('ed25519');
      return privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    }

    it('registers on first sign-on and returns verified', () => {
      const key = generateTestKey();
      const result = idp.verifyAgent('my-agent', key);
      expect(result.verified).toBe(true);
      expect(result.address).toMatch(/^a:[a-f0-9]{10}@[a-z0-9]+$/);
      expect(result.guid).toMatch(/^[a-f0-9]{10}$/);
    });

    it('verifies on subsequent sign-on with same key', () => {
      const key = generateTestKey();
      const r1 = idp.verifyAgent('sales', key);
      expect(r1.verified).toBe(true);
      const r2 = idp.verifyAgent('sales', key);
      expect(r2.verified).toBe(true);
      expect(r2.address).toBe(r1.address);
    });

    it('rejects a different key claiming an already-registered alias (alias collision)', () => {
      const key1 = generateTestKey();
      const key2 = generateTestKey();
      const r1 = idp.verifyAgent('my-agent', key1);
      expect(r1.verified).toBe(true);
      const r2 = idp.verifyAgent('my-agent', key2);
      expect(r2.verified).toBe(false);
    });

    it('different agents can register independently', () => {
      const key1 = generateTestKey();
      const key2 = generateTestKey();
      expect(idp.verifyAgent('agent-a', key1).verified).toBe(true);
      expect(idp.verifyAgent('agent-b', key2).verified).toBe(true);
      // Verify no cross-contamination
      expect(idp.verifyAgent('agent-a', key1).verified).toBe(true);
      expect(idp.verifyAgent('agent-b', key2).verified).toBe(true);
    });

    it('same key under a different alias is a rename — same GUID, updated name', () => {
      const key = generateTestKey();
      const r1 = idp.verifyAgent('original-name', key);
      expect(r1.verified).toBe(true);
      const r2 = idp.verifyAgent('new-name', key);
      expect(r2.verified).toBe(true);
      expect(r2.guid).toBe(r1.guid);
      expect(r2.address).toBe(r1.address);
    });

    it('rejects rename into an alias held by another key', () => {
      const keyA = generateTestKey();
      const keyB = generateTestKey();
      expect(idp.verifyAgent('alpha', keyA).verified).toBe(true);
      expect(idp.verifyAgent('beta', keyB).verified).toBe(true);
      // keyA now tries to rename 'alpha' → 'beta' — must be rejected
      const rename = idp.verifyAgent('beta', keyA);
      expect(rename.verified).toBe(false);
      // keyA still has alpha
      expect(idp.verifyAgent('alpha', keyA).verified).toBe(true);
    });

    it('rename is non-destructive across the identities DB', () => {
      const key = generateTestKey();
      const r1 = idp.verifyAgent('old-alias', key);
      const r2 = idp.verifyAgent('new-alias', key);
      expect(r2.guid).toBe(r1.guid);
      // Subsequent lookups with the new alias still succeed with the same identity
      const r3 = idp.verifyAgent('new-alias', key);
      expect(r3.guid).toBe(r1.guid);
    });
  });
});
