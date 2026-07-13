/**
 * Smoke test for `buildConsoleMounts` against a real tmp agent folder.
 * Other tests mock the builder to return `[]`; this one exercises the real
 * implementation and asserts the critical container-path entries are present.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// `vi.mock` is hoisted above top-level declarations, so anything the mock
// factory references must be created inside `vi.hoisted`.
const { TMP_ROOT } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsH = require('fs') as typeof import('fs');
  const osH = require('os') as typeof import('os');
  const pathH = require('path') as typeof import('path');
  return { TMP_ROOT: fsH.mkdtempSync(pathH.join(osH.tmpdir(), 'cast-mounts-test-')) };
});

// Override the config constants at import time — AGENTS_DIR resolves at
// module load, so `process.env` tricks after the fact don't help.
vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    AGENTS_DIR: TMP_ROOT,
    agentPath: (folder: string, ...segments: string[]) =>
      path.join(TMP_ROOT, folder, ...segments),
    sessionClaudePath: (folder: string, _k: string) =>
      path.join(TMP_ROOT, folder, 'sessions', 'testhash', '.claude'),
    sessionCastSocketPath: (folder: string, _k: string) =>
      path.join(TMP_ROOT, folder, 'mcp', 'socket', 'testhash.sock'),
  };
});

import { buildConsoleMounts } from './console/mounts.js';

describe('buildConsoleMounts', () => {
  beforeEach(() => {
    // Clean slate for each test — blueprint/.design/ side effect persists
    // across buildConsoleMounts calls and we want deterministic creation
    // assertions.
    for (const entry of fs.readdirSync(TMP_ROOT)) {
      fs.rmSync(path.join(TMP_ROOT, entry), { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Full cleanup happens once at process exit via the OS tmp-dir reaper;
    // per-test cleanup is handled in beforeEach.
  });

  it('Design mounts the four critical container paths', () => {
    const host = { name: 'new-test', folder: 'new-test' };
    const conversationKey = 'test|conv|key';

    const mounts = buildConsoleMounts(host, 'design', conversationKey);

    const containerPaths = mounts.map((m) => m.containerPath);

    // The mounts a Design container cannot function without:
    //
    //   /agent/blueprint     — where the agent writes
    //   /home/node/.claude   — SDK session state
    //
    // /mcp/cast.sock is appended at the spawn chokepoint (container-runner) from
    // the runner's nonce'd socket path, not by buildConsoleMounts — see Fix 1.
    // /ref/snapshot and /ref/manuals are nice-to-haves, not asserted here.
    expect(containerPaths).toContain('/agent/blueprint');
    expect(containerPaths).toContain('/home/node/.claude');
    expect(containerPaths).not.toContain('/mcp/cast.sock');
  });

  it('Design mount for /agent/blueprint is writable', () => {
    const host = { name: 'new-test', folder: 'new-test' };
    const conversationKey = 'test|conv|key';

    const mounts = buildConsoleMounts(host, 'design', conversationKey);
    const blueprint = mounts.find((m) => m.containerPath === '/agent/blueprint');

    expect(blueprint).toBeDefined();
    expect(blueprint!.readonly).toBe(false);
  });

  it('creates blueprint/.design/ as a side effect', () => {
    const host = { name: 'new-test', folder: 'new-test' };
    const conversationKey = 'test|conv|key';

    buildConsoleMounts(host, 'design', conversationKey);

    const designDir = path.join(TMP_ROOT, 'new-test', 'blueprint', '.design');
    expect(fs.existsSync(designDir)).toBe(true);
    expect(fs.statSync(designDir).isDirectory()).toBe(true);
  });

  it('Configure mounts config/ rw plus blueprint/state/logs ro — never ext/', () => {
    const host = { name: 'cfg-test', folder: 'cfg-test' };
    const conversationKey = 'test|cfg|key';

    const mounts = buildConsoleMounts(host, 'configure', conversationKey);
    const containerPaths = mounts.map((m) => m.containerPath);

    // Configure additions — the four paths a Configure container needs to
    // see. `/agent/config/` is the whole config directory (Apple Container
    // requires directory-level binds); per-extension config + secrets live
    // at `config/ext/<N>/{config.json,secrets.json}` so they are reached
    // through the same single `config/` mount. `agent.key` lives at
    // `secrets/agent.key` and is never mounted.
    expect(containerPaths).toContain('/agent/config');
    expect(containerPaths).toContain('/agent/blueprint');
    expect(containerPaths).toContain('/agent/state');
    expect(containerPaths).toContain('/agent/logs');

    // Configure does not mount the extension private runtime tree. Its rw
    // reach is `config/` only.
    expect(containerPaths).not.toContain('/agent/ext');

    // Base mounts still present. The MCP socket (without which the session has
    // zero tools) is appended at spawn (container-runner), not here — see Fix 1.
    expect(containerPaths).toContain('/home/node/.claude');
    expect(containerPaths).not.toContain('/mcp/cast.sock');

    // manifest.json is deliberately NOT mounted — single-file binds fail
    // on Apple Container. Its fields reach the prompt via ConsoleContext.
    expect(containerPaths).not.toContain('/agent/manifest.json');
  });

  it('Configure /agent/config is writable; blueprint/state/logs are readonly', () => {
    const host = { name: 'cfg-test', folder: 'cfg-test' };
    const conversationKey = 'test|cfg|key';

    const mounts = buildConsoleMounts(host, 'configure', conversationKey);

    const config = mounts.find((m) => m.containerPath === '/agent/config');
    expect(config, 'missing mount for /agent/config').toBeDefined();
    expect(config!.readonly, '/agent/config should be writable').toBe(false);

    for (const readonlyPath of ['/agent/blueprint', '/agent/state', '/agent/logs']) {
      const mount = mounts.find((m) => m.containerPath === readonlyPath);
      expect(mount, `missing mount for ${readonlyPath}`).toBeDefined();
      expect(mount!.readonly, `${readonlyPath} should be readonly`).toBe(true);
    }
  });

  it('Configure does not mount secrets/ or expose agent.key', () => {
    const host = { name: 'cfg-test', folder: 'cfg-test' };
    const conversationKey = 'test|cfg|key';

    const mounts = buildConsoleMounts(host, 'configure', conversationKey);
    const hostPaths = mounts.map((m) => m.hostPath);
    const containerPaths = mounts.map((m) => m.containerPath);

    // agent.key lives at secrets/agent.key on the host. No Configure mount
    // may reference it, directly or via a parent path.
    for (const p of hostPaths) {
      expect(p.endsWith('/secrets'), `mount ${p} references secrets/`).toBe(false);
      expect(p.endsWith('/agent.key'), `mount ${p} is the private key`).toBe(false);
    }
    expect(containerPaths).not.toContain('/secrets');
    expect(containerPaths).not.toContain('/agent/secrets');
  });

  // ---------------------------------------------------------------------------
  // Layer 1 of the console security policy — service/ must never appear in
  // any console mount table. These tests are the lock. Regressions here mean
  // the primary sandbox-to-host escape vector just opened.
  // ---------------------------------------------------------------------------

  it('Design does not mount service/ at any permission', () => {
    // Simulate a hand-assembled agent folder that already has service/ on
    // disk. Design's mount builder must still ignore it.
    const host = { name: 'svc-design', folder: 'svc-design' };
    const conversationKey = 'test|design|svc';
    fs.mkdirSync(path.join(TMP_ROOT, host.folder, 'service'), { recursive: true });

    const mounts = buildConsoleMounts(host, 'design', conversationKey);

    for (const m of mounts) {
      expect(m.hostPath.endsWith('/service'), `mount ${m.hostPath} references service/`).toBe(false);
      expect(m.containerPath).not.toMatch(/\/service(\/|$)/);
    }
  });

  it('Configure does not mount service/ at any permission', () => {
    const host = { name: 'svc-cfg', folder: 'svc-cfg' };
    const conversationKey = 'test|configure|svc';
    fs.mkdirSync(path.join(TMP_ROOT, host.folder, 'service'), { recursive: true });

    const mounts = buildConsoleMounts(host, 'configure', conversationKey);

    for (const m of mounts) {
      expect(m.hostPath.endsWith('/service'), `mount ${m.hostPath} references service/`).toBe(false);
      expect(m.containerPath).not.toMatch(/\/service(\/|$)/);
    }
  });

  it('Design Manager mounts a single /ref/agents view dir + its own /home/agent rw home', () => {
    // DM bind-mounts `mnt/agents/.design-manager/view/` → `/ref/agents` ro;
    // shared manager-tools.ts keeps that dir populated with
    // `<folder>.blueprint.md` summary files. No per-agent fanout — keeps
    // the mount count flat as the agent set grows.
    const dmHost = { name: 'design-manager', folder: '.design-manager' };
    const mounts = buildConsoleMounts(dmHost, 'design-manager', 'test|dm|key');
    const containerPaths = mounts.map((m) => m.containerPath);

    // Exactly one /ref/agents mount — the summary view dir.
    const refAgents = mounts.filter((m) => m.containerPath === '/ref/agents');
    expect(refAgents).toHaveLength(1);
    expect(refAgents[0].readonly).toBe(true);
    expect(refAgents[0].hostPath.endsWith(path.join('.design-manager', 'view'))).toBe(true);

    // No per-agent subdir mounts.
    for (const p of containerPaths) {
      expect(p).not.toMatch(/^\/ref\/agents\/[^/]+\/(blueprint|config|state|service|secrets)(\/|$)/);
    }

    // DM's persistent home — rw, sourced from mnt/agents/.design-manager/home.
    const home = mounts.find((m) => m.containerPath === '/home/agent');
    expect(home, 'missing /home/agent mount').toBeDefined();
    expect(home!.readonly).toBe(false);
    expect(home!.hostPath.endsWith(path.join('.design-manager', 'home'))).toBe(true);

    // config/ / state/ / service/ / secrets/ never reach DM at any permission.
    for (const m of mounts) {
      expect(m.hostPath.endsWith('/service'), `mount ${m.hostPath} references service/`).toBe(false);
      expect(m.containerPath).not.toMatch(/\/service(\/|$)/);
      expect(m.hostPath.endsWith('/state'), `mount ${m.hostPath} references state/`).toBe(false);
      expect(m.hostPath.endsWith('/secrets'), `mount ${m.hostPath} references secrets/`).toBe(false);
    }

    // Base mounts still present. The MCP socket is appended at spawn
    // (container-runner), not by buildConsoleMounts — see Fix 1.
    expect(containerPaths).toContain('/home/node/.claude');
    expect(containerPaths).not.toContain('/mcp/cast.sock');
  });

  it('Security Manager mounts a single /ref/agents view dir + its own /home/agent rw home', () => {
    // SM bind-mounts `mnt/agents/.security-manager/view/` → `/ref/agents`
    // ro; manager-tools keeps that dir populated with
    // `<folder>.{blueprint,config}.md` summaries. No per-agent fanout.
    const smHost = { name: 'security-manager', folder: '.security-manager' };
    const mounts = buildConsoleMounts(smHost, 'security-manager', 'test|sm|key');
    const containerPaths = mounts.map((m) => m.containerPath);

    // Exactly one /ref/agents mount.
    const refAgents = mounts.filter((m) => m.containerPath === '/ref/agents');
    expect(refAgents).toHaveLength(1);
    expect(refAgents[0].readonly).toBe(true);
    expect(refAgents[0].hostPath.endsWith(path.join('.security-manager', 'view'))).toBe(true);

    // No per-agent subdir mounts linger from the old fanout shape.
    for (const p of containerPaths) {
      expect(p).not.toMatch(/^\/ref\/agents\/[^/]+\/(blueprint|config|state|service|secrets|ext)(\/|$)/);
    }

    // SM's persistent home — rw, sourced from mnt/agents/.security-manager/home.
    const home = mounts.find((m) => m.containerPath === '/home/agent');
    expect(home, 'missing /home/agent mount').toBeDefined();
    expect(home!.readonly).toBe(false);
    expect(home!.hostPath.endsWith(path.join('.security-manager', 'home'))).toBe(true);

    // Everything sensitive stays unmounted at any permission.
    for (const m of mounts) {
      expect(m.hostPath.endsWith('/service'), `mount ${m.hostPath} references service/`).toBe(false);
      expect(m.containerPath).not.toMatch(/\/service(\/|$)/);
      expect(m.hostPath.endsWith('/state'), `mount ${m.hostPath} references state/`).toBe(false);
      expect(m.hostPath.endsWith('/secrets'), `mount ${m.hostPath} references secrets/`).toBe(false);
      expect(m.hostPath.endsWith('/ext'), `mount ${m.hostPath} references ext/`).toBe(false);
    }

    // Base mounts still present. The MCP socket is appended at spawn
    // (container-runner), not by buildConsoleMounts — see Fix 1.
    expect(containerPaths).toContain('/home/node/.claude');
    expect(containerPaths).not.toContain('/mcp/cast.sock');
  });

  it('server-scope mount count stays flat as agent count scales past the 22-mount VirtIO-FS ceiling', () => {
    // Load-bearing invariant: DM/CM/SM mount tables must not grow with
    // agent count. Every server-scope console is base + 2 (home + single
    // view dir). Apple Container's VirtIO-FS bind-mount ceiling is ~22; if
    // per-agent fanout ever creeps back in, mount count would scale as
    // 1 + 2N and breach the ceiling around 10 agents. 25 agents here is
    // well past that threshold.
    for (let i = 0; i < 25; i++) {
      const base = path.join(TMP_ROOT, `agent-${i}`);
      fs.mkdirSync(path.join(base, 'blueprint'), { recursive: true });
      fs.mkdirSync(path.join(base, 'config'), { recursive: true });
    }

    for (const [name, host] of [
      ['design-manager', { name: 'design-manager', folder: '.design-manager' }],
      ['config-manager', { name: 'config-manager', folder: '.config-manager' }],
      ['security-manager', { name: 'security-manager', folder: '.security-manager' }],
    ] as const) {
      const mounts = buildConsoleMounts(host, name, `test|${name}|scale`);
      const refAgents = mounts.filter((m) => m.containerPath === '/ref/agents');
      expect(refAgents, `${name}: expected exactly one /ref/agents mount`).toHaveLength(1);

      // No per-agent subdir mounts.
      for (const m of mounts) {
        expect(m.containerPath).not.toMatch(/^\/ref\/agents\/[^/]+\/(blueprint|config)(\/|$)/);
      }

      // Total mount count is bounded by base mounts + 2 (home + view). Apple
      // Container's 22-device ceiling is comfortably clear — this asserts the
      // count doesn't grow with agent count, not a specific number (base
      // mounts evolve over time).
      expect(mounts.length, `${name}: mount count ${mounts.length} should be well below 22`).toBeLessThan(10);
    }
  });

  it('Config Manager mounts a single /ref/agents view dir + its own /home/agent rw home', () => {
    // CM bind-mounts `mnt/agents/.config-manager/view/` → `/ref/agents`
    // ro; manager-tools keeps that dir populated with
    // `<folder>.{blueprint,config}.md` summaries. No per-agent fanout —
    // keeps the mount count flat as the agent set grows past the
    // VirtIO-FS bind-mount ceiling.
    const cmHost = { name: 'config-manager', folder: '.config-manager' };
    const mounts = buildConsoleMounts(cmHost, 'config-manager', 'test|config-manager|key');
    const containerPaths = mounts.map((m) => m.containerPath);

    // Exactly one /ref/agents mount.
    const refAgents = mounts.filter((m) => m.containerPath === '/ref/agents');
    expect(refAgents).toHaveLength(1);
    expect(refAgents[0].readonly).toBe(true);
    expect(refAgents[0].hostPath.endsWith(path.join('.config-manager', 'view'))).toBe(true);

    // No per-agent subdir mounts.
    for (const p of containerPaths) {
      expect(p).not.toMatch(/^\/ref\/agents\/[^/]+\/(blueprint|config|state|service|secrets)(\/|$)/);
    }

    for (const m of mounts) {
      expect(m.hostPath.endsWith('/service'), `mount ${m.hostPath} references service/`).toBe(false);
      expect(m.containerPath).not.toMatch(/\/service(\/|$)/);
      expect(m.hostPath.endsWith('/state'), `mount ${m.hostPath} references state/`).toBe(false);
      expect(m.hostPath.endsWith('/secrets'), `mount ${m.hostPath} references secrets/`).toBe(false);
    }

    // CM's persistent home — rw, sourced from mnt/agents/.config-manager/home.
    const home = mounts.find((m) => m.containerPath === '/home/agent');
    expect(home, 'missing /home/agent mount').toBeDefined();
    expect(home!.readonly).toBe(false);
    expect(home!.hostPath.endsWith(path.join('.config-manager', 'home'))).toBe(true);
  });

  // ---------------------------------------------------------------------
  // Drift-protection
  //
  // INSTANCE_LAYERS is the schema-level enumeration of agent-instance
  // layers (config/state/home/memory/ext). When a new layer is added
  // there, at least one per-agent console SHOULD reach it (or it
  // should be on the documented exception list below). Without this
  // test a new layer can land in the schema and silently miss every
  // console's mount table.
  // ---------------------------------------------------------------------
  it('every writable INSTANCE_LAYER is reachable from a per-agent console', async () => {
    // Loaded inline so the test stays robust to future schema additions.
    const { INSTANCE_LAYERS } = await import('@getcast/agent-schema/v1');
    const PER_AGENT_CONSOLES = ['design', 'configure'] as const;

    // Documented exceptions — layers we intentionally do NOT mount on any
    // per-agent console. If you're adding to this list, document why.
    //
    //   home   — agent runtime home dir. Per-agent consoles author the
    //            blueprint that DEFINES home contents; they don't read or
    //            write the live home dir. Operator inspection of home
    //            content would be a separate "console.log" feature.
    //   memory — agent runtime memory tree. Same rationale: authored
    //            indirectly via blueprint, not mounted into consoles.
    //   ext    — per-extension config + secrets live at `config/ext/<n>/`
    //            and are reached through the existing `/agent/config`
    //            mount. The dedicated `ext/` layer is agent-runtime-only.
    const EXCLUDED: ReadonlySet<string> = new Set(['home', 'memory', 'ext']);

    const host = { name: 'drift-test', folder: 'drift-test' };
    const conversationKey = 'test|drift|key';

    const mountedLayers = new Set<string>();
    for (const consoleName of PER_AGENT_CONSOLES) {
      const mounts = buildConsoleMounts(host, consoleName, conversationKey);
      for (const m of mounts) {
        // Map containerPath like `/agent/<layer>` back to layer name.
        const match = m.containerPath.match(/^\/agent\/([^/]+)$/);
        if (match && (INSTANCE_LAYERS as readonly string[]).includes(match[1])) {
          mountedLayers.add(match[1]);
        }
      }
    }

    for (const layer of INSTANCE_LAYERS) {
      if (EXCLUDED.has(layer)) continue;
      expect(mountedLayers.has(layer), `INSTANCE_LAYERS includes "${layer}" but no per-agent console mounts it. Update Configure/Design or add to EXCLUDED with rationale.`).toBe(true);
    }
  });

  it('full-net consoles never see sdk-only home dirs (and vice versa)', () => {
    // Surface partition (two surfaces):
    //   sdk-only consoles: configure, config-manager, security-manager
    //   full-net consoles: design, design-manager
    // sdk-only consoles' persistent home dirs (`.config-manager/home`,
    // `.security-manager/home`) must never be mounted by a full-net
    // console, and vice versa for `.design-manager/home`.

    const SDK_ONLY_HOMES = ['.config-manager', '.security-manager'];
    const FULL_NET_HOMES = ['.design-manager'];

    const fullNetConsoles: Array<{ name: 'design' | 'design-manager'; folder: string }> = [
      { name: 'design', folder: 'partition-test' },
      { name: 'design-manager', folder: '.design-manager' },
    ];
    const sdkOnlyConsoles: Array<{ name: 'configure' | 'config-manager' | 'security-manager'; folder: string }> = [
      { name: 'configure', folder: 'partition-test' },
      { name: 'config-manager', folder: '.config-manager' },
      { name: 'security-manager', folder: '.security-manager' },
    ];
    const conversationKey = 'test|partition|key';

    for (const { name, folder } of fullNetConsoles) {
      const mounts = buildConsoleMounts({ name: folder, folder }, name, conversationKey);
      for (const m of mounts) {
        for (const sdkHome of SDK_ONLY_HOMES) {
          expect(
            m.hostPath.includes(`/${sdkHome}/home`),
            `full-net console ${name} mounts sdk-only home ${sdkHome} (${m.hostPath})`,
          ).toBe(false);
        }
      }
    }

    for (const { name, folder } of sdkOnlyConsoles) {
      const mounts = buildConsoleMounts({ name: folder, folder }, name, conversationKey);
      for (const m of mounts) {
        for (const fullNetHome of FULL_NET_HOMES) {
          expect(
            m.hostPath.includes(`/${fullNetHome}/home`),
            `sdk-only console ${name} mounts full-net home ${fullNetHome} (${m.hostPath})`,
          ).toBe(false);
        }
      }
    }
  });
});
