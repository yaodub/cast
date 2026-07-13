import { describe, it, expect, beforeEach } from 'vitest';

import { LocalIdentityProvider } from '../auth/identity.js';
import { SystemCommandDispatcher } from './index.js';
import type { SystemCommandContext } from './types.js';

describe('SystemCommandDispatcher', () => {
  let idp: LocalIdentityProvider;
  let dispatcher: SystemCommandDispatcher;

  beforeEach(() => {
    idp = LocalIdentityProvider._createTest();
    dispatcher = new SystemCommandDispatcher(idp);
  });

  function ctx(identity: string | null, handle = 'tg:12345'): SystemCommandContext {
    return { identity, handle };
  }

  describe('dispatch', () => {
    it('returns null for non-command text and unknown commands', () => {
      expect(dispatcher.dispatch(ctx('local'), 'hello world')).toBeNull();
      expect(dispatcher.dispatch(ctx('local'), '/unknown')).toBeNull();
    });
  });

  describe('/name', () => {
    it('requires identity', () => {
      const result = dispatcher.dispatch(ctx(null), '/name Alice');
      expect(result).not.toBeNull();
      expect(result!.text).toContain('No identity');
    });

    it('returns current name when no argument', () => {
      const reg = idp.register('tg:12345', 'Alice');
      const result = dispatcher.dispatch(ctx(reg.id), '/name');
      expect(result!.text).toBe('Alice');
    });

    it.each([
      { label: 'over 64 chars', input: `/name ${'a'.repeat(65)}`, expected: '64 characters' },
      { label: 'control characters', input: '/name hello\x00world', expected: 'control characters' },
    ])('rejects names with $label', ({ input, expected }) => {
      const result = dispatcher.dispatch(ctx('local'), input);
      expect(result!.text).toContain(expected);
    });

    it('updates declared name', () => {
      const reg = idp.register('tg:12345', 'OldName');
      const result = dispatcher.dispatch(ctx(reg.id), '/name NewName');
      expect(result!.text).toContain('NewName');

      const resolved = idp.resolve('tg:12345');
      expect(resolved!.declaredName).toBe('NewName');
    });
  });

  describe('/whoami', () => {
    it('shows unpaired state', () => {
      const result = dispatcher.dispatch(ctx(null, 'tg:99999'), '/whoami');
      expect(result!.text).toContain('tg:99999');
      expect(result!.text).toContain('No identity');
    });

    it('shows identity details', () => {
      const reg = idp.register('tg:12345', 'Alice');
      const result = dispatcher.dispatch(ctx(reg.id, 'tg:12345'), '/whoami');
      expect(result!.text).toContain(reg.id);
      expect(result!.text).toContain('Alice');
      expect(result!.text).toContain('tg:12345');
    });
  });

  describe('/help', () => {
    it('lists commands', () => {
      const result = dispatcher.dispatch(ctx('local'), '/help');
      expect(result!.text).toContain('/name');
      expect(result!.text).toContain('/whoami');
      expect(result!.text).toContain('/help');
    });
  });

  describe('custom commands', () => {
    it('supports registering new commands', () => {
      dispatcher.register({
        command: '/ping',
        description: '/ping — test connectivity',
        handler: () => ({ text: 'pong' }),
      });
      const result = dispatcher.dispatch(ctx('local'), '/ping');
      expect(result!.text).toBe('pong');
    });
  });
});
