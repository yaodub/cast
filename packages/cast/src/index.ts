import { execSync, execFileSync } from 'child_process';
import type { ChildProcess } from 'child_process';
import fs from 'fs';
import { z } from 'zod';
import { AgentManifestSchema, isCompatible } from '@getcast/agent-schema/v1';

import { getPeerChannels } from './auth/acl.js';
import { loadChannelsConfig } from './conversations/channel-config.js';
import { AgentManager } from './agent/agent-manager.js';
import { slotPool } from './lib/gates.js';
import { Bus } from './gateway/bus.js';
import path from 'path';

import {
  AGENTS_DIR,
  CONTAINER_IMAGE,
  CONTAINER_NAME_PREFIX,
  CONTAINER_RUNTIME,
  RUNTIME_BINARY,
  RUNTIME_VERSION,
  RUNTIME_SUPPORTS_CAP_ADD,
  binaryExists,
  agentPath,
  listSubdirectories,
  resolveCapabilities,
  readServerConfig,
  CONFIG_DIR,
  CAST_PORT,
  CAST_WEB_PORT,
} from './config.js';
import { registerExtension, getRegisteredExtensions, startExtensions, stopExtensions } from './extensions/registry.js';
import { timed, errorMessage } from './lib/utils.js';
import { closeAllAdminEventsStreams } from './admin/events-stream.js';
import { closeAllAdminEventsWebSockets, setupAdminEventsWss } from './admin/ws-events.js';
import { agentNameSchema } from './admin/schemas.js';
import { email } from '@getcast/ext-email';
import { webFetch } from '@getcast/ext-web-fetch';
import { calendar } from '@getcast/ext-calendar';
import { whatsapp } from '@getcast/ext-whatsapp';

registerExtension(email);
registerExtension(webFetch);
registerExtension(calendar);
registerExtension(whatsapp);

// Aggregate per-extension manuals into packages/cast/manuals/extensions/<name>/
// so every console container sees them at /ref/manuals/extensions/<name>/ via
// the existing /ref/manuals/ mount. Refresh on each server start — idempotent.
import { aggregateExtensionManuals } from './console/shared/extension-manuals.js';
import { aggregateTransportManuals } from './console/shared/transport-manuals.js';
// Pass the runtime registry so aggregation flags drift between the manual
// tree and what's actually registered — keeps the DM/CM/SM "Extensions
// registered on this server" catalog from advertising an extension the
// server can't honor (mirrors the transport aggregation below).
const AGGREGATED_EXTENSIONS = aggregateExtensionManuals({
  registeredNames: new Set(getRegisteredExtensions().keys()),
});
import { WebSocketServer } from 'ws';
// DISCONNECTED: email transport temporarily disabled. Re-enable by restoring
// this import together with the registerTransport(emailTransport) call below
// and moving packages/cast/manuals/_disabled-transports/email back under
// packages/cast/manuals/transports/.
// import { email as emailTransport } from './transports/email.js';
import { slack as slackTransport } from './transports/slack.js';
import { telegram as telegramTransport } from './transports/telegram.js';
import {
  registerTransport,
  getRegisteredTransports,
  getRegisteredAddressPrefixes,
  loadRoutedTransports,
  reconcileRoutedTransports,
} from './transports/registry.js';
import { loadRoutes, type Routes } from './gateway/routes.js';

registerTransport(telegramTransport);
// DISCONNECTED: email transport — see import block above.
// registerTransport(emailTransport);
registerTransport(slackTransport);

// Aggregate per-transport manuals after registration so the consistency check
// can compare the manuals tree against the unified runtime registry (routed
// transports from `getRegisteredTransports()` plus the always-constructed
// bespoke set below). Bespoke transports — `web` (createWebTransport),
// `local` (createLocalTransport), `console` (new ConsoleTransport) — are
// constructed unconditionally later in this file and never go through
// registerTransport(), so they're listed here explicitly.
const BESPOKE_TRANSPORT_NAMES: ReadonlySet<string> = new Set(['web', 'local', 'console']);
aggregateTransportManuals({
  registeredNames: new Set([
    ...Array.from(getRegisteredTransports().keys()),
    ...BESPOKE_TRANSPORT_NAMES,
  ]),
});

/**
 * Address-prefix list the gateway claims as its routing surface.
 *
 * `u` is the system bus prefix: resolved user identities (`u:guid/handle`)
 * route to the gateway by it. `cli`, `admin`, and `web` are owned by the
 * always-instantiated bespoke `LocalTransport` / `ConsoleTransport` /
 * `WebTransport`. Routed-transport prefixes (`tg`, `email`, future) come from
 * the registry — adding a new routed transport requires no edit here.
 *
 * `admin` routes here so an agent's reply to the operator (a bare `admin:local`
 * participant) can prefix-route to the gateway, which fans it out to the
 * `ConsoleTransport` via `ownsParticipant`. Admin *inbound* is unaffected: it
 * enters by a direct `ingestInbound('admin:local', …)`, never the bus.
 *
 * (The `local` prefix retired with the `local` identity — the operator is
 * `cli:`/`admin:` now, so nothing addresses `local/…`. Don't re-add it.)
 */
function busPrefixesForRouting(): string[] {
  return ['u', 'cli', 'admin', 'web', ...getRegisteredAddressPrefixes()];
}

/**
 * Generic check: any registered route entry whose `address` field equals
 * the just-registered alias should trigger a reconcile. Each routed
 * transport's entries follow the `{ address, ... }` convention; this lets
 * us peek without parsing per-transport schemas at the lifecycle hook.
 */
function isAliasReferencedByAnyRoute(routes: Routes, alias: string): boolean {
  for (const value of Object.values(routes)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (entry && typeof entry === 'object' && (entry as Record<string, unknown>).address === alias) {
        return true;
      }
    }
  }
  return false;
}
import { FileWatcher } from './lib/file-watcher.js';
import { setWatcher } from './lib/config-reader.js';
import { validateFirewallAtStartup } from './gateway/firewall.js';
import { createDebounced } from './lib/debounce.js';
import { createLocalTransport } from './transports/local.js';
import { createWebTransport } from './transports/web.js';
import { ConsoleTransport } from './transports/console.js';
import { LocalIdentityProvider } from './auth/identity.js';
import { MessageGateway } from './gateway/message-gateway.js';
import { attachWsRoutes } from './gateway/ws-server.js';
import { initGatewayDb, closeGatewayDb } from './gateway/gateway-db.js';
import { HostActivityLog, initHostActivityLog } from './server/host-activity-log.js';
import { resolveAuth, logAuthResolution, type AuthResolution } from './auth/auth.js';
import { env, secrets } from './env.js';
import {
  refreshSecretsForAgents,
  setAuth,
  setHostLogger,
} from './container/container-runner.js';
import { mcpTransport, resolveMcpTransport } from './container/mcp-transport.js';
import type { McpServerDeps } from './agent/mcp-server.js';
import { SystemCommandDispatcher } from './commands/index.js';
import type { Transport } from './transports/schema.js';
import { logger } from './logger.js';
import { pollUpdates } from './lib/cast-services.js';
import { startAdminServer } from './admin/index.js';
import type { AgentVerifyResult } from './auth/identity.js';
import { ConfigManagerConsole } from './console/config-manager/config-manager-console.js';
import { ConsoleDb } from './console/console-db.js';
import { DesignManagerConsole } from './console/design-manager/design-manager-console.js';
import { SECURITY_MANAGER_DESCRIPTOR } from './console/security-manager/descriptor.js';
import { SecurityManagerConsole } from './console/security-manager/security-manager-console.js';
import { buildReviewRequestMessage } from './console/shared/lifecycle.js';

// SIDE EFFECT: Module-level singletons, initialized once at startup.
// Required because transports/bus/gateway must be shared across main() and shutdown handler.
const transports: Transport[] = [];
const idp = new LocalIdentityProvider(path.join(CONFIG_DIR, 'identities.db'));
const bus = new Bus();
// Initialized in main() after CONFIG_DIR is ready; threaded into bus,
// gateway, container-runner, and lifecycle hooks below.
let hostActivityLog: HostActivityLog;
const systemCommands = new SystemCommandDispatcher(idp);
const managersByFolder = new Map<string, AgentManager>();
const gateway = new MessageGateway({
  bus,
  transports: () => transports,
  identityProvider: idp,
  systemCommands,
  resolveTimezone: (addr) => {
    const key = bus.resolveAddress(addr);
    if (!key) return undefined;
    const folder = bus.getMetadata(key)?.folderPath;
    return folder ? managersByFolder.get(folder)?.timezone : undefined;
  },
  // Bound at first call — hostActivityLog isn't constructed until main() runs.
  logHostEvent: (level, component, eventName, message, opts) =>
    hostActivityLog?.logEvent(level, component, eventName, message, opts),
});

// ---------------------------------------------------------------------------
// Agent discovery — shared logic for boot and rescan
// ---------------------------------------------------------------------------

type DiscoverResult =
  | { ok: true; name: string; description?: string; agentAuth: AgentVerifyResult }
  | { ok: false; reason: string };

/** Validate an agent folder and verify its keypair. Used by both boot and rescan. */
function discoverAgent(folder: string): DiscoverResult {
  // Non-blocking sanity checks. The folder shape rules and the
  // folder/manifest.name invariant are enforced at create time; warn here so
  // hand-edited or legacy folders are surfaced without bricking the agent.
  const folderCheck = agentNameSchema.safeParse(folder);
  if (!folderCheck.success) {
    logger.warn(
      { folder, issues: folderCheck.error.issues.map((i) => i.message) },
      'Agent folder name does not match the create-time validator; registering anyway',
    );
  }

  const manifestPath = agentPath(folder, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    return { ok: false, reason: 'missing manifest.json' };
  }

  let name: string;
  let description: string | undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const manifest = AgentManifestSchema.safeParse(raw);
    if (!manifest.success) {
      return { ok: false, reason: 'invalid manifest.json' };
    }
    if (!isCompatible(manifest.data.spec)) {
      return { ok: false, reason: `spec ${manifest.data.spec} not supported` };
    }
    name = manifest.data.name;
    description = manifest.data.description;
  } catch {
    return { ok: false, reason: 'unreadable manifest.json' };
  }

  if (name !== folder) {
    logger.warn(
      { folder, manifestName: name },
      'Agent folder name and manifest.name diverge; filesystem uses folder, routing uses manifest.name',
    );
  }

  const keyPath = agentPath(folder, 'secrets', 'agent.key');
  if (!fs.existsSync(keyPath)) {
    return { ok: false, reason: 'missing secrets/agent.key' };
  }

  const keyPem = fs.readFileSync(keyPath, 'utf-8');
  const agentAuth = idp.verifyAgent(name, keyPem);
  if (!agentAuth.verified) {
    return { ok: false, reason: 'pubkey mismatch with IdP registration' };
  }

  return { ok: true, name, description, agentAuth };
}

/** Create and register an AgentManager for a discovered agent. */
function registerAgent(
  folder: string,
  alias: string,
  agentAuth: AgentVerifyResult,
  mcpDeps: McpServerDeps,
  fileWatcher: FileWatcher,
  description?: string,
): AgentManager {
  const effectiveId = agentAuth.address;
  const mgr = new AgentManager({
    host: { name: alias, folder },
    bus,
    mcpDeps,
    identityProvider: idp,
    agentId: effectiveId,
    watcher: fileWatcher,
    listSiblingAgents: () => {
      const myChannelConfig = loadChannelsConfig(folder);
      return bus
        .listEntities({ type: 'agent' })
        .filter((a) => a.id !== effectiveId)
        .map((a) => {
          const channels = getPeerChannels(bus, folder, a.id) ?? [];
          const peerFolder = bus.getMetadata(a.id)?.folderPath;
          const peerChannelConfig = peerFolder ? loadChannelsConfig(peerFolder) : undefined;
          // ACL channel-namespace duality: in a peer entry, outbound bits
          // (`q`/`r`) name the PEER's channels while inbound bits (`i`/`a`/`h`)
          // name MY channels — so the sharded affordance must be resolved
          // against the config that owns the row's namespace. A mixed-bits row
          // is ambiguous (one name, two namespaces); skip the flag rather than
          // guess.
          const shardedFor = (ch: { name: string; bits: string }): boolean => {
            const outbound = [...ch.bits].some((b) => 'qr'.includes(b));
            const inbound = [...ch.bits].some((b) => 'iah'.includes(b));
            if (outbound === inbound) return false;
            const config = outbound ? peerChannelConfig : myChannelConfig;
            return config?.[ch.name]?.use_sharding === true;
          };
          return {
            canonical: a.id,
            alias: a.label,
            description: a.description,
            channels: channels.map((ch) => ({
              ...ch,
              ...(shardedFor(ch) ? { sharded: true } : {}),
            })),
          };
        });
    },
    containerSweep: sweepContainersForFolder,
  });
  bus.register(effectiveId, mgr, 'exact', {
    label: alias,
    type: 'agent',
    description,
    folderPath: folder,
    agentAuth,
  });
  managersByFolder.set(folder, mgr);
  return mgr;
}

// ---------------------------------------------------------------------------
// Startup preflight — validate prerequisites before accepting messages
// ---------------------------------------------------------------------------

function preflight(): void {
  // Node.js version
  const nodeVersion = parseInt(process.versions.node, 10);
  if (nodeVersion < 20) {
    console.error(`\nFATAL: Node.js 20+ required (found ${process.versions.node})\n`);
    process.exit(1);
  }

  // AGENTS_DIR writable
  try {
    fs.accessSync(AGENTS_DIR, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    console.error(`\nFATAL: AGENTS_DIR is not accessible: ${AGENTS_DIR}\n`);
    process.exit(1);
  }

  // CONFIG_DIR writable
  try {
    fs.accessSync(CONFIG_DIR, fs.constants.R_OK | fs.constants.W_OK);
  } catch {
    console.error(`\nFATAL: CONFIG_DIR is not accessible: ${CONFIG_DIR}\n`);
    process.exit(1);
  }

  // Container runtime binary (the resolved runtime's CLI)
  if (!binaryExists(RUNTIME_BINARY)) {
    console.error(`\nFATAL: \`${RUNTIME_BINARY}\` binary not found on PATH.`);
    console.error(
      CONTAINER_RUNTIME === 'apple-container'
        ? 'Install Apple Container: https://github.com/apple/container/releases\n'
        : 'Install Docker: https://docs.docker.com/engine/install/  (on Windows, run Cast inside WSL2)\n',
    );
    process.exit(1);
  }

  // Container image — runtime-agnostic existence check
  try {
    execFileSync(RUNTIME_BINARY, ['image', 'inspect', CONTAINER_IMAGE], { stdio: 'pipe' });
  } catch {
    logger.warn({ image: CONTAINER_IMAGE }, 'Container image not found — agents will fail to spawn. Run: pnpm build:image');
  }
}

async function ensureContainerRuntimeReady(): Promise<void> {
  if (CONTAINER_RUNTIME === 'apple-container') {
    try {
      execSync('container system status', { stdio: 'pipe' });
      logger.debug('Apple Container system already running');
    } catch {
      logger.info('Starting Apple Container system...');
      try {
        execSync('container system start', { stdio: 'pipe', timeout: 30000 });
        logger.info('Apple Container system started');
      } catch (err) {
        logger.error({ err }, 'Failed to start Apple Container system');
        throw new Error('Apple Container system is required but failed to start');
      }
    }
  } else {
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 10000 });
      logger.debug('Docker daemon is running');
    } catch {
      throw new Error(
        'Docker daemon is not running. Start Docker Desktop (macOS) or run: sudo systemctl start docker (Linux)',
      );
    }
  }

  // Probe how this host can expose MCP to containers (socket vs TCP + bind
  // address) now that the runtime is confirmed up, before any agent spawns.
  await resolveMcpTransport();

  logger.info({ runtime: CONTAINER_RUNTIME, runtimeVersion: RUNTIME_VERSION, capAdd: RUNTIME_SUPPORTS_CAP_ADD, mcpTransport: mcpTransport() }, 'Container runtime ready');

  // Kill orphaned Cast containers from previous runs
  cleanupOrphanedContainers();
}

/**
 * Stop any running containers tagged with a specific agent folder. Called
 * after a per-agent unregister so removal isn't racing the container runtime.
 * Mirrors cleanupOrphanedContainers' shape but scoped to one folder. Best-
 * effort: failures are logged at debug, not surfaced.
 */
function sweepContainersForFolder(folder: string): void {
  if (CONTAINER_RUNTIME !== 'apple-container') return;
  try {
    const output = execSync('container ls --format json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 10_000,
    });
    const ContainerEntrySchema = z.object({
      status: z.string(),
      configuration: z.object({
        id: z.string(),
        labels: z.record(z.string(), z.string()).optional(),
      }),
    });
    const containers = z
      .array(ContainerEntrySchema)
      .parse(JSON.parse(output || '[]'));
    // Match by label `cast.folder=<folder>` set in buildContainerArgs.
    // Scope to this instance via the name prefix so concurrent Cast servers
    // sharing the daemon don't trample each other.
    const targets = containers
      .filter((c) =>
        c.status === 'running' &&
        c.configuration.id.startsWith(CONTAINER_NAME_PREFIX) &&
        c.configuration.labels?.['cast.folder'] === folder,
      )
      .map((c) => c.configuration.id);
    for (const name of targets) {
      try {
        execSync(`container stop ${name}`, { stdio: 'pipe', timeout: 10_000 });
      } catch { /* already stopped — non-fatal */ }
    }
    if (targets.length > 0) {
      logger.info({ folder, count: targets.length, names: targets }, 'Swept containers for removed agent');
    }
  } catch (err) {
    logger.debug({ folder, err }, 'Container sweep on unregister failed (non-fatal)');
  }
}

function cleanupOrphanedContainers(): void {
  try {
    if (CONTAINER_RUNTIME === 'apple-container') {
      const output = execSync('container ls --format json', {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: 10_000,
      });
      const ContainerEntrySchema = z.object({
        status: z.string(),
        configuration: z.object({ id: z.string() }),
      });
      const containers = z
        .array(ContainerEntrySchema)
        .parse(JSON.parse(output || '[]'));
      const orphans = containers
        .filter(
          (c) => c.status === 'running' && c.configuration.id.startsWith(CONTAINER_NAME_PREFIX),
        )
        .map((c) => c.configuration.id);
      for (const name of orphans) {
        try {
          execSync(`container stop ${name}`, { stdio: 'pipe', timeout: 10_000 });
        } catch { /* already stopped or timed out — non-fatal */ }
      }
      if (orphans.length > 0) {
        logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
      }
    } else {
      const output = execSync(`docker ps --filter name=${CONTAINER_NAME_PREFIX} --format {{.Names}}`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
        timeout: 10_000,
      });
      const orphans = output.trim().split('\n').filter(Boolean);
      for (const name of orphans) {
        try {
          execSync(`docker stop ${name}`, { stdio: 'pipe', timeout: 10_000 });
        } catch { /* already stopped or timed out — non-fatal */ }
      }
      if (orphans.length > 0) {
        logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

async function main(): Promise<void> {
  preflight();
  await ensureContainerRuntimeReady();

  initGatewayDb();
  hostActivityLog = initHostActivityLog();
  setHostLogger((level, component, eventName, message, opts) =>
    hostActivityLog.logEvent(level, component, eventName, message, opts));
  bus.setUnhandledLogger((from, to, payload) => {
    // Bus drops a packet when no handler is registered for `to`. Log a
    // structured row so the operator can see stranded traffic in the admin
    // UI (Activity tab). Pino mirror handled inside logEvent.
    const payloadType = (payload && typeof payload === 'object' && 'type' in payload)
      ? String((payload as { type?: unknown }).type)
      : 'unknown';
    hostActivityLog.logEvent('warn', 'bus', 'unrouted_packet', `No handler for ${to}`, {
      fromAddr: from,
      toAddr: to,
      context: { payload_type: payloadType },
    });
  });
  logger.info('Database initialized');

  // --- File watcher (infrastructure — before anything reads config) ---
  const watcher = new FileWatcher();
  await watcher.start([
    { path: CONFIG_DIR, depth: 0 },
    { path: AGENTS_DIR, depth: 0 },
  ]);
  setWatcher(watcher);

  // --- Firewall validation (boot-time) ---
  // Refuse to start with an unparseable firewall.json. A typo or partial
  // write that produces invalid JSON would otherwise silently degrade to
  // fail-closed (deny-all) at runtime — better to catch the broken config
  // at deploy time than discover it when external traffic stops flowing.
  // Missing file is OK; allow-all is the documented default for that case.
  validateFirewallAtStartup();

  // --- Auth resolution ---
  // resolveAuth() returns null when AUTH_MODE is unset or its required secret
  // is missing (fresh install / partial config) — server still boots, operator
  // finishes setup via Settings > Model Access. Validation errors (malformed
  // values, expired tokens) still throw; we catch and degrade to null so the
  // operator can fix it from the dashboard instead of editing .env and restarting.
  let auth: AuthResolution | null;
  try {
    auth = resolveAuth();
  } catch (err) {
    logger.error({ err: errorMessage(err) }, 'Auth resolution failed — server will run without Claude credentials. Fix via the server dashboard.');
    auth = null;
  }
  logAuthResolution(auth);
  setAuth(auth);

  // --- Extensions ---
  // Failed extensions are surfaced in the startup banner below, not just the log.
  const failedExtensions = await startExtensions();

  // --- Agent discovery + registration ---
  const mcpDeps: McpServerDeps = {
    resolveAgentByLabel: (label) => bus.resolveByLabel(label),
    requestSecurityReview: (folder, changeId) => {
      gateway.ingestInbound(
        'admin:local',
        SECURITY_MANAGER_DESCRIPTOR.address,
        buildReviewRequestMessage(folder, changeId),
        'Operator',
        { channel: 'default' },
      );
    },
  };
  const agentFolders = listSubdirectories(AGENTS_DIR);
  const managers: AgentManager[] = [];

  for (const folder of agentFolders) {
    const result = discoverAgent(folder);
    if (!result.ok) {
      logger.warn({ folder, reason: result.reason }, 'Skipping agent');
      continue;
    }

    const mgr = registerAgent(folder, result.name, result.agentAuth, mcpDeps, watcher, result.description);
    await mgr.init();
    managers.push(mgr);
    hostActivityLog.logEvent('info', 'lifecycle', 'agent_registered', `Agent "${result.name}" registered`, {
      context: { folder, name: result.name, address: mgr.agentId, source: 'boot' },
    });
  }

  logger.info({ agentCount: managers.length }, 'Agents registered');

  if (managers.length === 0) {
    logger.warn('No agents loaded — server is running but has nothing to do. Check CAST_AGENTS_DIR and agent manifests.');
  }

  // --- Discover + register helper — used by admin create and the rescan watcher.
  //     Always re-runs discoverAgent() (which re-verifies the agent's key against the IdP);
  //     verifyAgent is idempotent on matching fingerprint and returns the same canonical
  //     address, so calling it again for an already-registered agent is a no-op at the
  //     identity layer. Registration is skipped if the manager already exists.
  const discoverAndRegisterAgent = async (folder: string): Promise<DiscoverResult> => {
    const result = discoverAgent(folder);
    if (!result.ok) return result;
    if (!managersByFolder.has(folder)) {
      const mgr = registerAgent(folder, result.name, result.agentAuth, mcpDeps, watcher, result.description);
      await mgr.init();
      managers.push(mgr);
      hostActivityLog.logEvent('info', 'lifecycle', 'agent_registered', `Agent "${result.name}" registered`, {
        context: { folder, name: result.name, address: mgr.agentId, source: 'runtime' },
      });
    }
    return result;
  };

  // Forward-declared so both the admin server's unregisterAgent option AND the
  // AGENTS_DIR reconciler below can invoke the same teardown logic.
  // knownFolders is created later in the function and captured by closure.
  let unregisterAgent: (folder: string) => Promise<void>;

  // --- Console transport — owns `local`. Pre-created so the admin server's
  // chat routes can subscribe to it; registered in the transports[] array
  // below alongside web/cli so gateway outbound routing finds it.
  const consoleTransport = new ConsoleTransport();

  // Server-level toggle "Show steps in manager consoles" feeds all three
  // server-scope consoles (DM/CM/SM). Read at session-open time (not cached)
  // so operator edits via /admin/settings take effect on the next session
  // without a restart, matching how other server-config reads work.
  const getShowManagerSteps = (): boolean | undefined =>
    readServerConfig().showManagerSteps;

  // --- Server-scope console database — shared by DM/CM/SM (discriminated
  //     by `channel` on the row). One file at <CONFIG_DIR>/server-console.db,
  //     alongside gateway.db. Physical separation from agent.db is the
  //     load-bearing guarantee — console planning content never co-mingles
  //     with user-channel agent reasoning.
  const serverConsoleDb = new ConsoleDb(path.join(CONFIG_DIR, 'server-console.db'));

  // --- Config Manager — code-declared virtual agent at console:config-manager ---
  const configManagerConsole = new ConfigManagerConsole({ bus, mcpDeps, consoleDb: serverConsoleDb, fileWatcher: watcher, getShowManagerSteps });
  configManagerConsole.register();

  // --- Design Manager — code-declared virtual service at console:design-manager ---
  const designManagerConsole = new DesignManagerConsole({ bus, mcpDeps, consoleDb: serverConsoleDb, discoverAndRegisterAgent, fileWatcher: watcher, getShowManagerSteps });
  designManagerConsole.register();

  // --- Security Manager — code-declared virtual service at console:security-manager ---
  const securityManagerConsole = new SecurityManagerConsole({ bus, mcpDeps, consoleDb: serverConsoleDb, fileWatcher: watcher, getShowManagerSteps });
  securityManagerConsole.register();

  // --- Admin server ---
  const adminServer = await startAdminServer(CAST_PORT, {
    bus,
    idp,
    gateway,
    consoleTransport,
    getManager: (folder) => managersByFolder.get(folder),
    listFolders: () => [...managersByFolder.keys()],
    getAuth: () => auth,
    getTransports: () => transports,
    watcher,
    discoverAndRegisterAgent,
    unregisterAgent: (folder) => unregisterAgent(folder),
    hostActivityLog,
    applyAuthChange: async (next) => {
      auth = next;
      setAuth(next);
      if (next === null) return;
      // Push fresh secrets to every active container so already-running
      // conversations pick them up without waiting for the next spawn.
      const procs: ChildProcess[] = [];
      for (const mgr of managers) procs.push(...mgr.getActiveProcesses());
      await refreshSecretsForAgents(procs);
    },
  });

  // Register gateway for participant prefixes (resolved + raw handles).
  // The system prefix (`u`) and bespoke-transport prefixes (`cli`, `admin`, `web`)
  // are static; routed-transport prefixes (`tg`, `email`, future) come from
  // the registry so adding a new transport doesn't require editing this list.
  for (const prefix of busPrefixesForRouting()) {
    bus.register(prefix, gateway, 'prefix');
  }

  // Attach WebSocket routes to the admin HTTP server (single port for everything)
  const router = attachWsRoutes(adminServer);

  // Graceful shutdown handlers (signal registration deferred until all subsystems are ready).
  //
  // Layered design:
  //   1. Backstop timer — unconditional force-exit if any await hangs. Default
  //      60s for the graceful path; shrunk to 2s on the second signal.
  //   2. Progress logging — every 5s while shutdown is in flight, prints
  //      `currentStep` so operators watching the supervisor's logs can see
  //      what's slow.
  //   3. Two-signal escalation — Ctrl-C twice = fast, three times = exit(2).
  //   4. Phased teardown — Phase A stops new intake (bus prefixes, transports,
  //      WebSocket close frames, SSE shutdown event). Phase B drains agents
  //      (which internally mark approvals/requests interrupted + sweep
  //      containers). Phase C closes server-level handles.
  let signalCount = 0;
  let backstopTimer: ReturnType<typeof setTimeout> | null = null;
  let currentStep = 'starting';

  const armBackstop = (ms: number, reason: string): void => {
    if (backstopTimer) clearTimeout(backstopTimer);
    backstopTimer = setTimeout(() => {
      logger.error(
        { reason, ms, currentStep },
        `Shutdown backstop fired after ${ms}ms — force exit (stuck at ${currentStep})`,
      );
      process.exit(1);
    }, ms);
    backstopTimer.unref();
  };

  const shutdown = async (signal: string) => {
    signalCount += 1;
    if (signalCount === 2) {
      logger.warn({ signal }, 'Second signal received during shutdown — escalating: 2s backstop');
      armBackstop(2_000, 'fast escalation after 2nd signal');
      return;
    }
    if (signalCount >= 3) {
      logger.error({ signal }, 'Third signal received — immediate exit(2)');
      process.exit(2);
    }

    const startedAt = Date.now();
    armBackstop(60_000, 'graceful shutdown timeout');

    const progressInterval = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      logger.info(
        { elapsedMs, currentStep },
        `Shutdown in progress (${(elapsedMs / 1000).toFixed(0)}s at "${currentStep}") — Ctrl-C again to escalate`,
      );
    }, 5_000);
    progressInterval.unref();

    const logStep = (info: { step: string; elapsedMs: number; ok: boolean }): void => {
      logger.info(info, `Shutdown step ${info.ok ? 'done' : 'FAILED'}: ${info.step} (${info.elapsedMs}ms)`);
    };
    const trackStep = (label: string): void => { currentStep = label; };

    logger.info({ signal }, 'Shutdown signal received — graceful drain start');

    // ---- Phase A: stop intake (no new traffic lands on draining agents) ----
    // Tells the admin UI a final 'shutdown' frame before closing both the SSE
    // response stream and the WebSocket — clients see a clean signal, not a
    // TCP RST. Both transports run in parallel during the SharedWorker migration.
    await timed('close_admin_streams', async () => {
      closeAllAdminEventsStreams('server-shutdown');
      closeAllAdminEventsWebSockets('server-shutdown');
    }, logStep, trackStep);

    // Drop gateway prefix routes so transport callbacks that race the
    // disconnect can't queue more packets onto agents that are about to drain.
    await timed('unregister_bus_prefixes', async () => {
      for (const prefix of busPrefixesForRouting()) {
        try { bus.unregister(prefix); } catch (err) {
          logger.warn({ err, prefix }, 'bus.unregister threw during shutdown');
        }
      }
    }, logStep, trackStep);

    // Stop the outbound delivery worker before transports go away — retries
    // against disconnecting transports would only log no-wire noise.
    await timed('stop_delivery_worker', async () => {
      gateway.stopDeliveryWorker();
    }, logStep, trackStep);

    // Each transport closes its WebSocket clients with code 1001 / its IMAP
    // IDLE / its Telegram poll loop. Moved up from the original Phase C
    // position so intake is fully off before agent drains start.
    await timed('disconnect_transports', async () => {
      await Promise.allSettled(transports.map((t) => t.disconnect()));
    }, logStep, trackStep);

    // adminServer.close() stops accepting new HTTP/WS upgrades but lets
    // in-flight responses finish. Safe to run after the SSE close above
    // because closeAllAdminEventsStreams already ended those responses.
    await timed('close_admin_http', async () => {
      adminServer.close();
    }, logStep, trackStep);

    // ---- Phase B: drain agents + stop scheduled work ----
    await timed('stop_extensions', () => stopExtensions(), logStep, trackStep);

    await timed('shutdown_consoles', async () => {
      await Promise.allSettled([
        configManagerConsole.shutdown(),
        designManagerConsole.shutdown(),
        securityManagerConsole.shutdown(),
      ]);
      serverConsoleDb.close();
    }, logStep, trackStep);

    // AgentManager.shutdown() internally: marks pending approvals/in-flight
    // requests 'interrupted' (so post-restart audit is clean), drains active
    // runners (5s graceful + SIGKILL), then sweeps stragglers tagged for the
    // folder. allSettled so one bad agent doesn't strand the rest.
    await timed('shutdown_managers', async () => {
      await Promise.allSettled(managers.map((m) => m.shutdown()));
    }, logStep, trackStep);

    // Slot pool after agents — symmetric with composition order.
    await timed('shutdown_slot_pool', async () => {
      slotPool.shutdown();
    }, logStep, trackStep);

    await timed('shutdown_watcher', () => watcher.shutdown(), logStep, trackStep);

    // ---- Phase C: close server-level handles ----
    await timed('close_db_handles', async () => {
      idp.close();
      closeGatewayDb();
      hostActivityLog.close();
    }, logStep, trackStep);

    if (backstopTimer) clearTimeout(backstopTimer);
    clearInterval(progressInterval);
    logger.info({ totalMs: Date.now() - startedAt }, 'Shutdown complete');
    process.exit(0);
  };

  // Local transport (CLI WebSocket) — /cli path
  const cliWss = new WebSocketServer({ noServer: true });
  router.addPath('/cli', cliWss);
  const { transport: localTransport } = createLocalTransport({
    gateway,
    bus,
    wss: cliWss,
    idp,
  });
  transports.push(localTransport);

  // Web transport — /web path
  const webWss = new WebSocketServer({ noServer: true });
  router.addPath('/web', webWss);
  const webTransport = createWebTransport({ gateway, bus, idp, wss: webWss });
  transports.push(webTransport);

  // Admin events — /api/admin/events path. Same path the SSE handler is
  // mounted on; HTTP-Upgrade vs HTTP-GET differentiates which handler runs.
  // Both coexist during the web-ui SharedWorker migration.
  const adminEventsWss = new WebSocketServer({ noServer: true });
  router.addPath('/api/admin/events', adminEventsWss);
  setupAdminEventsWss(adminEventsWss, { bus, consoleTransport });

  // Console transport — created above the admin server so `/api/admin/.../chat`
  // can subscribe on connect. SSE-fed; no connect/disconnect work.
  transports.push(consoleTransport);

  // Routed transports (registered above) — loaded from routes.json, hot-reloaded
  // on file change and on agent-register events. Wiring lives in
  // `transports/registry.ts`; this block just supplies the deps.
  const routedDeps = { gateway, bus, systemCommands };

  const initial = await loadRoutedTransports(routedDeps);
  for (const t of initial) transports.push(t);
  logger.info(
    Object.fromEntries([...getRegisteredTransports().keys()].map((name) => [name, initial.some((t) => t.name === name)])),
    'Routed transports loaded',
  );

  // --- Watcher subscription: routes.json changes (replaces 60s poll) ---
  let routesReconciling = false;
  let routesDirty = false;

  function onRoutesChanged(filePath: string): void {
    if (!filePath.endsWith('routes.json')) return;
    routesDirty = true;
    if (routesReconciling) return;
    void runRoutesReconcile();
  }

  async function runRoutesReconcile(): Promise<void> {
    routesReconciling = true;
    while (routesDirty) {
      routesDirty = false;
      await reconcileRoutedTransports(routedDeps, transports).catch((err) => {
        logger.warn({ err }, 'Routes reconciliation failed');
      });
    }
    routesReconciling = false;
  }

  watcher.onChange(CONFIG_DIR, onRoutesChanged);

  // --- Bus subscription: agent registration → routed-transport reconcile ---
  // Routes reference agents by alias; resolution happens at transport factory
  // time. If an agent registers after initial route load (fs-watcher discovery,
  // admin create, or operator dropping a folder), any route targeting its alias
  // would sit unbound until the next routes.json edit. Coalesce into the same
  // dirty-flag loop the file watcher uses so bursts of registrations collapse
  // to a single reconcile.
  bus.onLifecycle((event) => {
    if (event.type !== 'registered') return;
    const alias = bus.getMetadata(event.address)?.label;
    if (!alias) return;
    if (!isAliasReferencedByAnyRoute(loadRoutes(), alias)) return;
    routesDirty = true;
    if (routesReconciling) return;
    void runRoutesReconcile();
  });

  // --- AGENTS_DIR snapshot reconciler (live add/remove of agent folders) ---
  // Drives both directions from chokidar's addDir / unlinkDir events on the
  // AGENTS_DIR root. The previous wiring subscribed to onChange (file events)
  // at depth 0, which observed nothing useful — new agent folders fire dir
  // events, not file events, so add-discovery only worked by accident when
  // unrelated files churned at root.
  //
  // Why snapshot-reconcile instead of handling individual events: rename
  // (`mv folder newname`) appears as `unlinkDir → addDir`; ordering and exact
  // event count vary across macOS FSEvents replays and atomic-replace
  // patterns. A 250 ms debounce + listSubdirectories diff is robust to all
  // of these — we trust disk state, ignore event payloads beyond "something
  // happened".
  const knownFolders = new Set(agentFolders);

  // Body of the forward-declared unregisterAgent. Single source of teardown
  // for both admin button and reconciler-driven removals.
  unregisterAgent = async (folder) => {
    const mgr = managersByFolder.get(folder);
    if (!mgr) return;
    const agentId = mgr.agentId;
    // Drop from routing tables BEFORE awaiting shutdown so new traffic stops
    // arriving at a half-shut manager. Bus.routeMessage silently drops to
    // unregistered addresses (gateway/bus.ts:146-149) — that's the right
    // behavior for in-flight messages destined for a removed agent.
    bus.unregister(agentId);
    managersByFolder.delete(folder);
    knownFolders.delete(folder);
    await mgr.shutdown();
    hostActivityLog.logEvent('info', 'lifecycle', 'agent_unregistered', `Agent at "${folder}" unregistered`, {
      context: { folder, address: agentId },
    });
    // Container sweep now runs inside `AgentManager.shutdown()` so the same
    // cleanup happens for both unregister and full-server-shutdown paths.
  };

  const reconcileAgentsDir = (): void => {
    let current: string[];
    try {
      current = listSubdirectories(AGENTS_DIR);
    } catch (err) {
      logger.warn({ err }, 'AGENTS_DIR snapshot reconcile: listSubdirectories failed');
      return;
    }
    const currentSet = new Set(current);

    // Removals first — anything we knew about that's no longer on disk.
    for (const folder of [...knownFolders]) {
      if (currentSet.has(folder)) continue;
      logger.info({ folder }, 'Agent folder removed from disk — unregistering');
      // unregisterAgent already drops bus + map + knownFolders, then awaits
      // shutdown, in that order. The bus.unregister inside fires
      // a `deregistered` lifecycle event — server-scope consoles pick it
      // up. Fire-and-forget — reconcile is non-blocking; subsequent
      // reconciles are idempotent.
      void unregisterAgent(folder).catch((err) => {
        logger.error({ folder, err }, 'Failed to unregister removed agent folder');
      });
    }

    // Rapid-churn rebuild check — folder still present, manager still in
    // map, but secrets/agent.key changed within the 250ms debounce window.
    // The snapshot diff alone would miss this since both sets contain the
    // folder. Force a full re-register cycle so the new identity binds correctly.
    for (const folder of currentSet) {
      const mgr = managersByFolder.get(folder);
      if (!mgr) continue;
      const currentFp = AgentManager.computeKeyFingerprint(folder);
      if (currentFp === '' || currentFp === mgr.keyFingerprint) continue;
      logger.info(
        { folder, oldFingerprint: mgr.keyFingerprint.slice(0, 8), newFingerprint: currentFp.slice(0, 8) },
        'Agent key rotated on disk — re-registering',
      );
      // discoverAndRegisterAgent calls bus.register, which fires the
      // `registered` lifecycle event consumed by server-scope consoles.
      void unregisterAgent(folder)
        .then(() => discoverAndRegisterAgent(folder))
        .catch((err) => {
          logger.error({ folder, err }, 'Failed to re-register agent after key rotation');
        });
    }

    // Additions — anything new on disk we don't yet have a manager for.
    for (const folder of current) {
      if (knownFolders.has(folder)) continue;
      knownFolders.add(folder);
      void discoverAndRegisterAgent(folder)
        .then((result) => {
          if (!result.ok) {
            logger.warn({ folder, reason: result.reason }, 'Skipping discovered agent');
            // Drop from knownFolders so a subsequent re-mkdir gets retried.
            knownFolders.delete(folder);
            return;
          }
          logger.info({ folder, agentId: result.agentAuth.address }, 'Discovered new agent');
          // bus.register inside discoverAndRegisterAgent already fired the
          // `registered` lifecycle event picked up by server-scope consoles.
        })
        .catch((err) => {
          knownFolders.delete(folder);
          logger.error({ folder, err }, 'Failed to init discovered agent');
        });
    }
  };

  // 250 ms — long enough to absorb `unlinkDir → addDir` chains from `mv` /
  // Finder atomic-replace, short enough that operators don't notice the lag.
  const reconcileDebounced = createDebounced(reconcileAgentsDir, 250);
  watcher.onDirChange(AGENTS_DIR, () => reconcileDebounced.schedule());

  // Inbound crash recovery (idempotent). Outbound retry/expiry lives in the
  // delivery worker — boot recovery is just its first tick.
  gateway.recoverPending();
  gateway.startDeliveryWorker();

  // cast-services update check (startup + every 24h). Best-effort; the fetcher
  // falls back to the embedded snapshot on failure, so this never throws.
  // When an upgrade is available, write a boxed yellow notice to stdout so
  // terminal operators can't miss it (the structured log still records it
  // for headless setups).
  pollUpdates()
    .then((s) => {
      logger.info({ current: s.current, latest: s.latest, available: s.available }, 'Update check');
      if (s.available) {
        // ANSI styling — yellow box, bold/dim emphasis. Interior width is 44
        // cells; each content line is constructed to be exactly 44 cells of
        // visible width between the ║ borders. Use ASCII-safe glyphs (↑, ASCII
        // box-drawing) to avoid wide-char surprises that break alignment.
        const Y = '\x1b[33m';
        const B = '\x1b[1m';
        const D = '\x1b[2m';
        const R = '\x1b[0m';
        const W = 44;
        const pad = (visible: string, styled: string): string => styled + ' '.repeat(W - visible.length);
        const rows = [
          '',
          `   ${Y}╔${'═'.repeat(W)}╗${R}`,
          `   ${Y}║${' '.repeat(W)}║${R}`,
          `   ${Y}║${pad('   ↑  CAST UPDATE AVAILABLE', `   ${B}${Y}↑  CAST UPDATE AVAILABLE${R}`)}${Y}║${R}`,
          `   ${Y}║${' '.repeat(W)}║${R}`,
          `   ${Y}║${pad(`      Latest:   ${s.latest}`, `      Latest:   ${B}${s.latest}${R}`)}${Y}║${R}`,
          `   ${Y}║${pad(`      Running:  ${s.current}`, `      Running:  ${D}${s.current}${R}`)}${Y}║${R}`,
          `   ${Y}║${' '.repeat(W)}║${R}`,
          `   ${Y}║${pad('   → git pull && pnpm start', `   ${D}→ git pull && pnpm start${R}`)}${Y}║${R}`,
          `   ${Y}║${' '.repeat(W)}║${R}`,
          `   ${Y}╚${'═'.repeat(W)}╝${R}`,
          '',
          '',
        ];
        process.stdout.write(rows.join('\n'));
      }
    })
    .catch((err) => logger.warn({ err }, 'Initial update check failed'));
  setInterval(() => {
    pollUpdates().catch((err) => logger.warn({ err }, 'Periodic update check failed'));
  }, 24 * 60 * 60 * 1000).unref();

  // Register signal handlers after all subsystems are ready
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('Cast running');

  // Human-readable startup banner. The structured log above is the
  // machine-readable readiness signal; this banner is for operators in
  // `pnpm dev` so the dashboard URL is easy to spot and clickable in most
  // terminals. Headless operators rely on this banner as the only signal
  // of which surface lives where — keep both URLs explicit and call out
  // the not-configured state when relevant.
  const addr = adminServer.address();
  const apiPort = addr && typeof addr === 'object' ? addr.port : CAST_PORT;
  // Advertise the port operators actually open. In the two-process layout the
  // web UI proxies to this API server on its own port (CAST_WEB_PORT); only it
  // is user-facing. Fall back to our own port when run standalone.
  const port = CAST_WEB_PORT ?? apiPort;
  const base = `http://localhost:${port}`;
  const lines = [
    '',
    `  Cast ${env.version} ready`,
    `    Dashboard: ${base}/admin/`,
    `    Chat:      ${base}/chat/`,
  ];
  if (auth === null) {
    lines.push('    ⚠ Claude not configured — visit Dashboard to set up');
  }
  // Extension startup failures get a loud, ruled red block — a failed
  // server-scoped extension means its tools are gone for every agent, and that
  // must not blend into the rest of the banner. Color only on a TTY so piped
  // logs (production, CI) stay free of escape codes.
  if (failedExtensions.length > 0) {
    const tty = process.stdout.isTTY;
    const boldRed = (s: string) => (tty ? `\x1b[1;31m${s}\x1b[0m` : s);
    const red = (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
    const rule = '━'.repeat(58);
    lines.push('');
    lines.push(boldRed(`  ${rule}`));
    lines.push(boldRed(`  ⚠  EXTENSION STARTUP FAILED — tools unavailable to all agents`));
    lines.push(boldRed(`  ${rule}`));
    for (const { name, reason } of failedExtensions) {
      lines.push(red(`    ✗ ${name} — ${reason}`));
    }
    lines.push(red(`    See the log above for the full error.`));
    lines.push(boldRed(`  ${rule}`));
  }
  lines.push('', '');
  process.stdout.write(lines.join('\n'));
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start Cast');
  process.exit(1);
});
