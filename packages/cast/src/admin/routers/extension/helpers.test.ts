/**
 * Regression tests for writeExtensionConfig — the single chokepoint that
 * persists operator extension-config overrides.
 *
 * Locked fields are the blueprint author's domain; the runtime merge
 * (mergeExtensionConfig) always resolves a locked field to the author value
 * regardless of the override file. A per-extension `setConfig` input schema
 * built with `.partial()` over a config schema that has `.default()` fields
 * re-materializes omitted (locked) keys, so a locked key arrives in `updates`
 * even when the operator changed nothing. writeExtensionConfig must persist
 * only the unlocked subset rather than reject the whole save — the original bug
 * turned every save into a spurious "Field X is locked" error the moment any
 * field was locked, and it was latent in every extension.
 *
 * Uses the real config/agentPath against vitest's `CAST_AGENTS_DIR` tmpdir; only
 * the config-reader watcher is stubbed (it reads straight from disk).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';

import { agentPath } from '../../../config.js';
import { _setMockWatcher } from '../../../lib/config-reader.js';
import { readExtensionConfig, writeExtensionConfig } from './helpers.js';

const EXT = 'testext';
const FOLDER = 'write-ext-config-test';

/** Watcher stub: read straight from disk (no mtime cache) so writes are visible. */
class FsWatcher {
  get(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }
  }
}

/** `policy` is locked (bare value); `limit` is unlocked ({ unlocked, value }). */
const CAPS = { policy: 'author-pinned', limit: { unlocked: true, value: 10 } };

function writeCapabilities(extConfig: Record<string, unknown>): void {
  fs.mkdirSync(agentPath(FOLDER, 'blueprint', 'props'), { recursive: true });
  fs.writeFileSync(
    agentPath(FOLDER, 'blueprint', 'props', 'capabilities.json'),
    JSON.stringify({ extensions: { [EXT]: { enabled: true, ...extConfig } } }),
  );
}

function readOverride(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(agentPath(FOLDER, 'config', 'ext', EXT, 'config.json'), 'utf-8'));
}

beforeEach(() => {
  fs.rmSync(agentPath(FOLDER), { recursive: true, force: true });
  _setMockWatcher(new FsWatcher());
});

describe('writeExtensionConfig', () => {
  it('persists unlocked fields', () => {
    writeCapabilities(CAPS);
    writeExtensionConfig(FOLDER, EXT, { limit: 25 });
    expect(readOverride()).toEqual({ limit: 25 });
  });

  it('drops a locked field instead of rejecting the save (regression)', () => {
    writeCapabilities(CAPS);
    // Simulates a partial-update schema re-injecting the locked `policy` at its
    // default alongside a genuine unlocked edit. Must not throw, and the locked
    // key must not reach the override file.
    expect(() => writeExtensionConfig(FOLDER, EXT, { policy: 'schema-default', limit: 25 })).not.toThrow();
    expect(readOverride()).toEqual({ limit: 25 });
  });

  it('treats a save touching only a locked field as a no-op, not an error', () => {
    writeCapabilities(CAPS);
    expect(() => writeExtensionConfig(FOLDER, EXT, { policy: 'whatever' })).not.toThrow();
    expect(readOverride()).toEqual({});
  });

  it('merges into an existing override without wiping untouched unlocked keys', () => {
    writeCapabilities(CAPS);
    writeExtensionConfig(FOLDER, EXT, { limit: 5 });
    writeExtensionConfig(FOLDER, EXT, { limit: 7 });
    expect(readOverride()).toEqual({ limit: 7 });
  });

  it('readExtensionConfig reflects lock state and the operator override', () => {
    writeCapabilities(CAPS);
    writeExtensionConfig(FOLDER, EXT, { limit: 42 });
    const fields = readExtensionConfig(FOLDER, EXT);
    expect(fields['policy']).toEqual({ value: 'author-pinned', locked: true });
    expect(fields['limit']).toEqual({ value: 42, locked: false });
  });
});
