import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import path from 'path';

import { logger } from '../logger.js';
import { CONFIG_DIR } from '../config.js';
import { _setMockWatcher, type WatcherLike } from '../lib/config-reader.js';
import {
  loadFirewall,
  validateFirewallAtStartup,
  isExternallyReachable,
  _resetFirewallStateForTest,
} from './firewall.js';

/** Test watcher that returns whatever we set per path. */
class TestWatcher implements WatcherLike {
  private contents: Record<string, string | null> = {};
  set(path: string, content: string | null): void {
    this.contents[path] = content;
  }
  get(path: string): string | null {
    // contents map may have undefined for never-set paths — return null
    // to match the "missing file" behavior of FileWatcher.
    return this.contents[path] ?? null;
  }
}

let mockWatcher: TestWatcher;

const FW_PATH = path.join(CONFIG_DIR, 'firewall.json');

beforeEach(() => {
  mockWatcher = new TestWatcher();
  _setMockWatcher(mockWatcher);
  _resetFirewallStateForTest();
  vi.mocked(logger.error).mockClear();
  vi.mocked(logger.info).mockClear();
});

describe('firewall — loadFirewall', () => {
  it('returns allow-all when file is missing', () => {
    const fw = loadFirewall();
    expect(fw).toEqual({ mode: 'allow-all', except: [] });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('returns parsed firewall when file is valid', () => {
    mockWatcher.set(FW_PATH, JSON.stringify({ mode: 'deny-all', except: ['admin-agent'] }));
    const fw = loadFirewall();
    expect(fw).toEqual({ mode: 'deny-all', except: ['admin-agent'] });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('returns deny-all when file is invalid JSON', () => {
    mockWatcher.set(FW_PATH, 'not-json-at-all');
    const fw = loadFirewall();
    expect(fw).toEqual({ mode: 'deny-all', except: [] });
    expect(logger.error).toHaveBeenCalledOnce();
    expect(vi.mocked(logger.error).mock.calls[0]?.[1]).toMatch(/unparseable/);
  });

  it('returns deny-all when JSON parses but fails the schema', () => {
    mockWatcher.set(FW_PATH, JSON.stringify({ mode: 'unknown-mode', except: [] }));
    const fw = loadFirewall();
    expect(fw).toEqual({ mode: 'deny-all', except: [] });
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('logs only on transition into invalid, not on every call', () => {
    mockWatcher.set(FW_PATH, 'bad-json');
    loadFirewall();
    loadFirewall();
    loadFirewall();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('logs recovery on transition out of invalid', () => {
    mockWatcher.set(FW_PATH, 'bad-json');
    loadFirewall();
    expect(logger.error).toHaveBeenCalledOnce();
    mockWatcher.set(FW_PATH, JSON.stringify({ mode: 'allow-all', except: [] }));
    loadFirewall();
    expect(logger.info).toHaveBeenCalled();
    const infoCall = vi.mocked(logger.info).mock.calls.find((c) =>
      String(c[1]).includes('restored from deny-all'),
    );
    expect(infoCall).toBeDefined();
  });

  it('does not log recovery when never previously invalid', () => {
    loadFirewall(); // missing
    mockWatcher.set(FW_PATH, JSON.stringify({ mode: 'allow-all', except: [] }));
    loadFirewall(); // parsed
    const restoredCalls = vi.mocked(logger.info).mock.calls.filter((c) =>
      String(c[1]).includes('restored from deny-all'),
    );
    expect(restoredCalls).toHaveLength(0);
  });
});

describe('firewall — validateFirewallAtStartup', () => {
  it('does not throw when file is missing', () => {
    expect(() => validateFirewallAtStartup()).not.toThrow();
  });

  it('does not throw when file is valid', () => {
    mockWatcher.set(FW_PATH, JSON.stringify({ mode: 'allow-all', except: [] }));
    expect(() => validateFirewallAtStartup()).not.toThrow();
  });

  it('throws when file is invalid JSON', () => {
    mockWatcher.set(FW_PATH, 'not-json');
    expect(() => validateFirewallAtStartup()).toThrow(/unparseable/);
  });

  it('throws when file fails the schema', () => {
    mockWatcher.set(FW_PATH, JSON.stringify({ mode: 'bogus' }));
    expect(() => validateFirewallAtStartup()).toThrow(/unparseable/);
  });

  it('seeds lastSource so first runtime call does not log spuriously', () => {
    mockWatcher.set(FW_PATH, JSON.stringify({ mode: 'allow-all', except: [] }));
    validateFirewallAtStartup();
    vi.mocked(logger.info).mockClear();
    loadFirewall();
    // No "restored" log — we never transitioned through invalid.
    const restoredCalls = vi.mocked(logger.info).mock.calls.filter((c) =>
      String(c[1]).includes('restored from deny-all'),
    );
    expect(restoredCalls).toHaveLength(0);
  });
});

describe('firewall — isExternallyReachable', () => {
  it('allow-all without exceptions reaches anyone', () => {
    mockWatcher.set(FW_PATH, JSON.stringify({ mode: 'allow-all', except: [] }));
    expect(isExternallyReachable('site-manager')).toBe(true);
  });

  it('allow-all with exceptions excludes the listed agents', () => {
    mockWatcher.set(FW_PATH, JSON.stringify({ mode: 'allow-all', except: ['secret'] }));
    expect(isExternallyReachable('site-manager')).toBe(true);
    expect(isExternallyReachable('secret')).toBe(false);
  });

  it('deny-all with exceptions allows only the listed agents', () => {
    mockWatcher.set(FW_PATH, JSON.stringify({ mode: 'deny-all', except: ['public'] }));
    expect(isExternallyReachable('site-manager')).toBe(false);
    expect(isExternallyReachable('public')).toBe(true);
  });

  it('invalid config rejects everyone (fail-closed)', () => {
    mockWatcher.set(FW_PATH, 'broken');
    expect(isExternallyReachable('any-agent')).toBe(false);
  });
});
