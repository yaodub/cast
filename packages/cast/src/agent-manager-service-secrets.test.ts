/**
 * Watcher-driven service restart on config/ext/service/secrets.json changes —
 * the freshness mechanism for service secrets (svc.secrets is a startup
 * snapshot; the restart re-reads it).
 *
 * Prototype-harness AgentManager via `Object.create` (same rationale as
 * `agent-manager-project-event.test.ts` — a real constructor needs a
 * half-dozen collaborators unrelated to the drain loop under test).
 *
 * Both-branches discipline: restart fires (valid change, wipe) AND is
 * withheld (invalid JSON mid-edit, unrelated extension paths), plus the
 * restart-failure logging path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { AgentManager } from './agent/agent-manager.js';
import { agentPath } from './config.js';
import { _setMockWatcher } from './lib/config-reader.js';

const FOLDER = 'svc-secrets-test-agent';
const SECRETS_PATH = agentPath(FOLDER, 'config', 'ext', 'service', 'secrets.json');
const SETTINGS_PATH = agentPath(FOLDER, 'config', 'ext', 'service', 'config.json');
const EXT_SECRETS_PATH = agentPath(FOLDER, 'config', 'ext', 'email', 'secrets.json');

const watcherFiles = new Map<string, string>();

interface Harness {
  mgr: { runConfigReload(): Promise<void> };
  pending: Set<string>;
  restart: ReturnType<typeof vi.fn>;
  onConfigChanged: ReturnType<typeof vi.fn>;
  logEvent: ReturnType<typeof vi.fn>;
}

function makeManager(): Harness {
  const restart = vi.fn().mockResolvedValue(undefined);
  const onConfigChanged = vi.fn();
  const logEvent = vi.fn();
  const pending = new Set<string>();

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const mgr = Object.create(AgentManager.prototype) as any;
  mgr.folder = FOLDER;
  mgr.pendingExtConfigPaths = pending;
  mgr.extensions = { onConfigChanged };
  mgr.service = { restart };
  mgr.agentDb = { logEvent };
  // agentScope is a prototype getter derived from `folder` — no stub needed.
  // Unrelated runConfigReload tail — instance stubs shadow the prototype.
  mgr.maybeRestartBackupTimer = vi.fn();
  mgr.applyMcpDelta = vi.fn().mockResolvedValue(undefined);
  mgr.reconcileEgress = vi.fn().mockResolvedValue(undefined);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return { mgr, pending, restart, onConfigChanged, logEvent };
}

beforeEach(() => {
  watcherFiles.clear();
  _setMockWatcher({ get: (p) => watcherFiles.get(p) ?? null });
});

describe('service secrets change — restart branch', () => {
  it('restarts the service once on a valid secrets.json change and logs the event', async () => {
    const h = makeManager();
    watcherFiles.set(SECRETS_PATH, JSON.stringify({ HN_USERNAME: 'alice' }));
    h.pending.add(SECRETS_PATH);

    await h.mgr.runConfigReload();

    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(h.onConfigChanged).not.toHaveBeenCalled();
    expect(h.logEvent).toHaveBeenCalledWith('info', 'service', 'restarted', expect.stringContaining('restarting service'));
  });

  it('restarts on a missing file — a wipe is a legitimate secrets change', async () => {
    const h = makeManager();
    h.pending.add(SECRETS_PATH); // watcher has no content for the path

    await h.mgr.runConfigReload();

    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it('restarts on a config.json (settings) change', async () => {
    const h = makeManager();
    watcherFiles.set(SETTINGS_PATH, JSON.stringify({ INTERVAL: 45 }));
    h.pending.add(SETTINGS_PATH);

    await h.mgr.runConfigReload();

    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(h.onConfigChanged).not.toHaveBeenCalled();
  });

  it('restarts once when both service files changed in the same window', async () => {
    const h = makeManager();
    watcherFiles.set(SECRETS_PATH, '{}');
    watcherFiles.set(SETTINGS_PATH, '{}');
    h.pending.add(SECRETS_PATH);
    h.pending.add(SETTINGS_PATH);

    await h.mgr.runConfigReload();

    expect(h.restart).toHaveBeenCalledTimes(1);
  });

  it('logs restart_failed when the restart rejects', async () => {
    const h = makeManager();
    h.restart.mockRejectedValue(new Error('spawn failed'));
    watcherFiles.set(SECRETS_PATH, '{}');
    h.pending.add(SECRETS_PATH);

    await h.mgr.runConfigReload();
    await new Promise((r) => setImmediate(r)); // drain the fire-and-forget .catch

    expect(h.logEvent).toHaveBeenCalledWith('error', 'service', 'restart_failed', expect.stringContaining('spawn failed'));
  });
});

describe('service secrets change — withhold branch', () => {
  it('skips the restart on invalid JSON (mid-edit save) and does not log restarted', async () => {
    const h = makeManager();
    watcherFiles.set(SECRETS_PATH, '{ "HN_USERNAME": "ali');
    h.pending.add(SECRETS_PATH);

    await h.mgr.runConfigReload();

    expect(h.restart).not.toHaveBeenCalled();
    expect(h.logEvent).not.toHaveBeenCalledWith('info', 'service', 'restarted', expect.anything());
  });

  it('skips the restart when ANY changed service file is invalid — no restart into a half-broken snapshot', async () => {
    const h = makeManager();
    watcherFiles.set(SECRETS_PATH, '{}'); // valid
    watcherFiles.set(SETTINGS_PATH, '{ broken'); // mid-edit
    h.pending.add(SECRETS_PATH);
    h.pending.add(SETTINGS_PATH);

    await h.mgr.runConfigReload();

    expect(h.restart).not.toHaveBeenCalled();
  });

  it('routes extension config paths to the registry, not the service', async () => {
    const h = makeManager();
    watcherFiles.set(EXT_SECRETS_PATH, '{}');
    h.pending.add(EXT_SECRETS_PATH);

    await h.mgr.runConfigReload();

    expect(h.onConfigChanged).toHaveBeenCalledWith(EXT_SECRETS_PATH);
    expect(h.restart).not.toHaveBeenCalled();
  });

  it('splits a mixed batch — service path restarts, extension path dispatches', async () => {
    const h = makeManager();
    watcherFiles.set(SECRETS_PATH, '{}');
    watcherFiles.set(EXT_SECRETS_PATH, '{}');
    h.pending.add(SECRETS_PATH);
    h.pending.add(EXT_SECRETS_PATH);

    await h.mgr.runConfigReload();

    expect(h.restart).toHaveBeenCalledTimes(1);
    expect(h.onConfigChanged).toHaveBeenCalledTimes(1);
    expect(h.onConfigChanged).toHaveBeenCalledWith(EXT_SECRETS_PATH);
  });
});
