import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Mock secrets (mutable object — tests assign properties before calling resolveAuth)
const { mockSecrets } = vi.hoisted(() => {
  const mockSecrets: Record<string, string | undefined> = {};
  return { mockSecrets };
});
vi.mock('./env.js', () => ({ secrets: mockSecrets }));

// Mock claude-credentials
const mockCredentialsMeta = vi.fn<() => { expiresAt: number; hasRefreshToken: boolean } | null>(() => null);
const mockCredentialsToken = vi.fn<() => string | null>(() => null);

vi.mock('./lib/claude-credentials.js', () => ({
  readCredentialsMeta: () => mockCredentialsMeta(),
  readCredentialsToken: () => mockCredentialsToken(),
  readCredentials: () => {
    const meta = mockCredentialsMeta();
    const token = mockCredentialsToken();
    if (!meta || !token) return null;
    return { token, expiresAt: meta.expiresAt, hasRefreshToken: meta.hasRefreshToken };
  },
}));

import { resolveAuth, refreshSecrets } from './auth/auth.js';
import type { AuthResolution } from './auth/auth.js';

beforeEach(() => {
  vi.resetAllMocks();
  // Reset mutable mock state
  for (const key of Object.keys(mockSecrets)) delete mockSecrets[key];
  mockCredentialsMeta.mockReturnValue(null);
  mockCredentialsToken.mockReturnValue(null);
});

// --- Explicit api-key ---

describe('explicit api-key', () => {
  it('resolves with valid API key', () => {
    Object.assign(mockSecrets,{ AUTH_MODE: 'api-key', ANTHROPIC_API_KEY: 'sk-ant-api03-test' });
    const auth = resolveAuth();
    expect(auth?.mode).toBe('api-key');
    expect(auth?.secrets).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-api03-test' });
  });

  it('returns null when ANTHROPIC_API_KEY is missing', () => {
    Object.assign(mockSecrets,{ AUTH_MODE: 'api-key' });
    expect(resolveAuth()).toBeNull();
  });

  it('throws when key has OAuth prefix', () => {
    Object.assign(mockSecrets,{ AUTH_MODE: 'api-key', ANTHROPIC_API_KEY: 'sk-ant-oat01-abc' });
    expect(() => resolveAuth()).toThrow('looks like an OAuth token');
  });
});

// --- Explicit setup-token ---

describe('explicit setup-token', () => {
  it('resolves from .env token', () => {
    Object.assign(mockSecrets,{ AUTH_MODE: 'setup-token', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-env' });
    const auth = resolveAuth();
    expect(auth?.mode).toBe('setup-token');
    expect(auth?.secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-env' });
    expect(auth?.meta.source).toBe('.env');
  });

  it('resolves from credentials file', () => {
    Object.assign(mockSecrets,{ AUTH_MODE: 'setup-token' });
    mockCredentialsMeta.mockReturnValue({ expiresAt: Date.now() + 200 * 86_400_000, hasRefreshToken: true });
    mockCredentialsToken.mockReturnValue('sk-ant-oat01-creds');
    const auth = resolveAuth();
    expect(auth?.mode).toBe('setup-token');
    expect(auth?.meta.source).toBe('credentials-file');
  });

  it('returns null when no token in .env and no credentials file', () => {
    Object.assign(mockSecrets,{ AUTH_MODE: 'setup-token' });
    expect(resolveAuth()).toBeNull();
  });

  it('warns when token expires within 30 days', async () => {
    const { logger } = await import('./logger.js');
    Object.assign(mockSecrets,{ AUTH_MODE: 'setup-token' });
    mockCredentialsMeta.mockReturnValue({ expiresAt: Date.now() + 20 * 86_400_000, hasRefreshToken: true });
    mockCredentialsToken.mockReturnValue('sk-ant-oat01-expiring');
    resolveAuth();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ expiresIn: expect.stringContaining('d') }),
      expect.stringContaining('expires soon'),
    );
  });

  it('throws when token expires within 7 days', () => {
    Object.assign(mockSecrets,{ AUTH_MODE: 'setup-token' });
    mockCredentialsMeta.mockReturnValue({ expiresAt: Date.now() + 3 * 86_400_000, hasRefreshToken: true });
    mockCredentialsToken.mockReturnValue('sk-ant-oat01-dying');
    expect(() => resolveAuth()).toThrow('expires in');
  });
});

// --- Missing AUTH_MODE ---

describe('missing AUTH_MODE', () => {
  it('returns null when AUTH_MODE is not set', () => {
    Object.assign(mockSecrets, {});
    expect(resolveAuth()).toBeNull();
  });
});

// --- refreshSecrets ---

describe('refreshSecrets', () => {
  it('returns stored secrets for api-key mode', async () => {
    const auth: AuthResolution = {
      mode: 'api-key',
      secrets: { ANTHROPIC_API_KEY: 'sk-ant-api03-test' },
      meta: { source: '.env' },
    };
    const secrets = await refreshSecrets(auth);
    expect(secrets).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-api03-test' });
  });

  it('returns stored secrets for setup-token mode', async () => {
    const auth: AuthResolution = {
      mode: 'setup-token',
      secrets: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' },
      meta: { source: '.env' },
    };
    const secrets = await refreshSecrets(auth);
    expect(secrets).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' });
  });
});

// --- Invalid config ---

describe('invalid config', () => {
  it('throws on bad AUTH_MODE value', () => {
    Object.assign(mockSecrets,{ AUTH_MODE: 'magic' });
    expect(() => resolveAuth()).toThrow('Invalid AUTH_MODE="magic"');
  });
});
