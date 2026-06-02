import { execSync } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import {
  CapabilitiesSchema,
  McpServerSecretsSchema,
  ProvisionsSchema,
  isUnlocked,
  unlockableValue,
} from '@getcast/agent-schema/v1';
import type { Capabilities, McpServerDeclaration, McpServerSecrets, Provisions } from '@getcast/agent-schema/v1';

import { env } from './env.js';
import { readParsed } from './lib/config-reader.js';
import { writeAtomic, conversationKeyToPath } from './lib/utils.js';

export const SCHEDULER_POLL_INTERVAL = 60000;

// sdk-only egress pin refresh: re-resolve each agent's allowlist on this cadence
// and reconcile the container's CAST_EGRESS chain + /etc/hosts pins (see
// egress-controller.ts). Fixed interval; a no-op when resolution is unchanged.
export const EGRESS_REFRESH_MS = 5 * 60 * 1000;
// Grace window for a pinned IP that rotated away: keep allowing it this long after
// it stops resolving, so a connection that resolved just before the rotation isn't
// cut. (Resolution *failure* keeps last-known-good indefinitely; this is for
// successful re-resolution that returned different IPs.)
export const EGRESS_GRACE_MS = 10 * 60 * 1000;

// Runtime data directories — both required via env vars, no fallbacks.
export const AGENTS_DIR = path.resolve(env.CAST_AGENTS_DIR);
export const CONFIG_DIR = path.resolve(env.CAST_CONFIG_DIR);

// Per-instance discriminator for container names. Multiple cast servers on one
// host share the same Apple Container daemon, so the startup orphan sweep must
// scope to *this* instance's containers — otherwise dev restarts kill prod's
// live containers (SIGTERM 143, classified as `external_kill`).
export const INSTANCE_ID = createHash('sha1').update(CONFIG_DIR).digest('hex').slice(0, 6);
export const CONTAINER_NAME_PREFIX = `cast-${INSTANCE_ID}-`;

// ---------------------------------------------------------------------------
// Container runtime resolution
// ---------------------------------------------------------------------------

export type ContainerRuntime = 'docker' | 'apple-container';

/**
 * Cross-platform PATH lookup. Returns the absolute path to an executable named
 * `name` on PATH, or null. On Windows, tries each PATHEXT extension. Replaces
 * shelling out to `which`, which does not exist on Windows.
 */
export function findBinary(name: string): string | null {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* not here — try next */
      }
    }
  }
  return null;
}

export function binaryExists(name: string): boolean {
  return findBinary(name) !== null;
}

function resolveRuntime(setting: string): ContainerRuntime {
  if (setting === 'docker') return 'docker';
  if (setting === 'apple-container') return 'apple-container';

  // auto: prefer Apple Container on macOS, Docker everywhere else
  if (process.platform === 'darwin' && binaryExists('container')) return 'apple-container';
  if (binaryExists('docker')) return 'docker';

  const platform = process.platform === 'darwin' ? 'macOS' : 'Linux';
  const hint = process.platform === 'darwin'
    ? 'Install Apple Container (macOS 26+) or Docker Desktop: https://docker.com/products/docker-desktop'
    : 'Install Docker: https://docs.docker.com/engine/install/';
  throw new Error(`No container runtime found on ${platform}. ${hint}`);
}

export const CONTAINER_RUNTIME = resolveRuntime(env.CAST_RUNTIME);

/** The container CLI binary for the resolved runtime. */
export const RUNTIME_BINARY = CONTAINER_RUNTIME === 'docker' ? 'docker' : 'container';

/**
 * Whether the resolved runtime's `run` accepts `--cap-add`. Probed from the
 * CLI's own `--help` rather than inferred from a version number, so it tracks
 * the actual flag surface across runtimes and releases:
 *   - Docker: yes (its default cap set omits NET_ADMIN).
 *   - Apple Container >=0.12: yes — 0.12 reduced default caps to the OCI
 *     baseline (no NET_ADMIN) and introduced the flag.
 *   - Apple Container 0.11: no — it left container-root caps unrestricted and
 *     rejects the flag ("Unknown option '--cap-add'").
 * "Flag present" lines up exactly with "caps were dropped, so re-add them":
 * where caps are already unrestricted the flag is absent (and must not be
 * passed); where caps are dropped the flag exists. entrypoint.sh's iptables
 * (sdk-only / none egress) needs NET_ADMIN, so container-runner passes
 * --cap-add wherever this is true. RUNTIME_BINARY is a fixed 'docker'|'container'
 * literal — the shelled-out probe carries no injection surface.
 */
export const RUNTIME_SUPPORTS_CAP_ADD: boolean = (() => {
  try {
    const help = execSync(`${RUNTIME_BINARY} run --help 2>&1`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return help.includes('--cap-add');
  } catch {
    return false;
  }
})();

/**
 * Resolved runtime CLI version (e.g. "0.12.3"), or 'unknown' if the probe
 * fails. Diagnostic only — stamped onto container-spawn failure logs and the
 * startup env summary so a runtime-version-induced break self-identifies (the
 * 0.11 → 0.12 capability change is the cautionary tale). Not used for gating;
 * behavior keys off RUNTIME_SUPPORTS_CAP_ADD, which probes the actual flag.
 */
export const RUNTIME_VERSION: string = (() => {
  try {
    const out = execSync(`${RUNTIME_BINARY} --version 2>&1`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.match(/\d+\.\d+\.\d+/)?.[0] ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

// MCP transport (socket vs TCP, and the TCP bind address) is probed at startup
// and lives in container/mcp-transport.ts — see resolveMcpTransport().

export const CONTAINER_IMAGE = env.CONTAINER_IMAGE;
export const CONTAINER_TIMEOUT = env.CONTAINER_TIMEOUT;
export const CONTAINER_MAX_OUTPUT_SIZE = env.CONTAINER_MAX_OUTPUT_SIZE;
export const IDLE_TIMEOUT = env.IDLE_TIMEOUT;
export const MAX_CONCURRENT_CONTAINERS = env.MAX_CONCURRENT_CONTAINERS;

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Max attachment size in bytes. */
export const MAX_ATTACHMENT_BYTES = env.MAX_ATTACHMENT_MB * 1_048_576;

export const CAST_PORT = env.CAST_PORT;

/** Public web UI port (proxies to CAST_PORT). Undefined when run standalone. */
export const CAST_WEB_PORT = env.CAST_WEB_PORT;

/** CLI/TUI typing-indicator auto-clear after this many ms of silence. */
export const TYPING_TIMEOUT_MS = 5000;

/** CLI/TUI WebSocket reconnect delay. */
export const RECONNECT_DELAY_MS = 3000;

/**
 * Output validation — consecutive final-output validation failures before the
 * runner closes the conversation with a user-facing "agent stuck" message.
 * Counter resets on a successful final delivery; intermediate failures don't count.
 */
export const MAX_VALIDATION_FAILURES = 3;

/**
 * Default cap on user-visible bytes of a single agent output (post-strip of
 * `<cast:internal>` blocks). Per-agent override via `agent.json::maxOutputBytes`.
 * Cap intentionally on user-visible bytes — verbose private reasoning shouldn't trip it.
 */
export const MAX_OUTPUT_BYTES_DEFAULT = 32_768;

/**
 * Quiet window before the debounced config-reload handlers fire. Tuned for
 * LLM-led blueprint/config edit cycles (5–30s round-trips). Sub-second is too
 * aggressive for typing patterns; 60s+ feels broken when iterating "save then
 * test." Document any change in `manuals/console/configure.md` so operators
 * know how long to wait after an edit.
 */
export const CONFIG_RELOAD_DEBOUNCE_MS = 15_000;

/** Socket filename for the service admin HTTP server. */
export const ADMIN_SOCKET_NAME = 'admin.sock';

/**
 * Lifetime of an `outbound_pushes` row before TTL purge. Pushes have no
 * `'fulfilled'` terminal — accepted pushes never produce a positive ack
 * back to the sender — so rows accumulate until either a `<cast:rejection>`
 * marks them `'rejected'` or this TTL elapses. Five minutes is generous
 * enough to cover slow receiver gating + queue drain on a busy host.
 */
export const PUSH_ROW_TTL_MS = 5 * 60 * 1000;

/** Sweep cadence for `outbound_pushes` TTL purge. Loose — once per minute is fine. */
export const PUSH_ROW_SWEEP_MS = 60 * 1000;

/** Resolve a path under an agent's directory tree. */
export function agentPath(agentFolder: string, ...segments: string[]): string {
  return path.join(AGENTS_DIR, agentFolder, ...segments);
}

/** Per-session .claude/ directory path. */
export function sessionClaudePath(agentFolder: string, conversationKey: string): string {
  return agentPath(agentFolder, 'sessions', conversationKeyToPath(conversationKey), '.claude');
}

/** MCP socket directory — all .sock files for an agent instance live here. */
export function mcpDir(agentFolder: string): string {
  return agentPath(agentFolder, 'mcp');
}

/** Cast server's MCP socket path for an agent. */
export function castSocketPath(agentFolder: string): string {
  return path.join(mcpDir(agentFolder), 'cast.sock');
}

/** Per-conversation cast MCP socket path. */
export function sessionCastSocketPath(agentFolder: string, conversationKey: string): string {
  const hash = createHash('sha256').update(conversationKey).digest('hex').slice(0, 12);
  return path.join(agentPath(agentFolder, 'mcp', 'socket'), `${hash}.sock`);
}

/** List immediate subdirectory names under a given directory. */
export function listSubdirectories(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

const EMPTY_CAPS: Capabilities = {
  disabled_tools: [],
  additional_disabled_tools: [],
  resources: {},
  extensions: {},
  mcp_servers: {},
};

/** Read and validate capabilities.json for an agent. Cached by FileWatcher. */
export function readCapabilities(folder: string): Capabilities {
  return readParsed(agentPath(folder, 'blueprint', 'props', 'capabilities.json'), CapabilitiesSchema, EMPTY_CAPS);
}

const EMPTY_PROVISIONS: Provisions = { resources: {}, additional_disabled_tools: [] };

/** Read and validate provisions.json for an agent. Cached by FileWatcher. */
export function readProvisions(folder: string): Provisions {
  return readParsed(agentPath(folder, 'config', 'provisions.json'), ProvisionsSchema, EMPTY_PROVISIONS);
}

// ---------------------------------------------------------------------------
// Server config (server.json — hot-reloadable)
// ---------------------------------------------------------------------------

/**
 * Console isolation — gates inter-console push paths.
 *
 *   strict — historical isolation. DM reaches only `__design`; CM reaches only
 *            `__configure`; same-agent `__design` ↔ `__configure` is blocked.
 *            Confused-deputy mitigation against an LLM-driven exfil carrier
 *            between Configure's PII read and Design's network egress.
 *   normal — opens the asymmetric set safe for solo-operator authoring:
 *            DM → CM, DM → any agent's `__configure`, and same-agent
 *            `__design` → `__configure`. Configure → Design stays blocked
 *            in either mode (the exfil-carrier direction).
 *
 * Hot-reload: consumers read this at decision time, not module load. Tool
 * rejection messages and the tool description name the live mode so a
 * long-running console session can pick up a flip without restart.
 */
export const ConsoleIsolationSchema = z.enum(['normal', 'strict']);
export type ConsoleIsolation = z.infer<typeof ConsoleIsolationSchema>;

export const ServerConfigSchema = z.object({
  consoleModel: z.string().default('claude-opus-4-7'),
  // Optional so unset stays distinct from explicit false. Server-scope
  // consoles fall back to per-console strategy defaults when undefined;
  // an explicit true/false from the operator overrides those defaults.
  // Mirrors the per-agent `showConsoleSteps` shape in agent.json.
  showManagerSteps: z.boolean().optional(),
  consoleIsolation: ConsoleIsolationSchema.default('normal'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

const EMPTY_SERVER_CONFIG: ServerConfig = {
  consoleModel: 'claude-opus-4-7',
  consoleIsolation: 'normal',
};

const serverConfigPath = () => path.join(CONFIG_DIR, 'server.json');

/** Read and validate server.json. Cached by FileWatcher. */
export function readServerConfig(): ServerConfig {
  return readParsed(serverConfigPath(), ServerConfigSchema, EMPTY_SERVER_CONFIG);
}

/** Write validated server config to disk. */
export function writeServerConfig(config: ServerConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  writeAtomic(serverConfigPath(), JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// Resolved capabilities (capabilities + provisions merge)
// ---------------------------------------------------------------------------

/** Fully merged capabilities — ready for consumption by container runner, MCP, prompt assembly. */
export interface ResolvedCapabilities {
  disabledTools: string[];
  pip?: { allowed_packages: string[] };
  resources: Record<string, {
    description?: string;
    access: 'ro' | 'rw';
    required: boolean;
    path?: string;
  }>;
  /** Names of `required: true` resource slots that have no provisioned host path.
   *  Advisory — the runtime warn-and-skips a missing mount; this is what the
   *  admin UI, configure__validate, and the Configure dynamic snapshot surface
   *  so the operator can't miss the gap. */
  missingRequired: string[];
}

/** Merge capabilities.json + provisions.json into a resolved config. */
export function resolveCapabilities(folder: string): ResolvedCapabilities {
  const caps = readCapabilities(folder);
  const provisions = readProvisions(folder);

  // --- Merge disabled tools ---
  const disabledTools = [...caps.disabled_tools];
  const additionalBase = unlockableValue(caps.additional_disabled_tools);
  disabledTools.push(...additionalBase);
  if (isUnlocked(caps.additional_disabled_tools)) {
    disabledTools.push(...provisions.additional_disabled_tools);
  }

  // --- Merge pip ---
  let pip: { allowed_packages: string[] } | undefined;
  if (caps.pip) {
    const packages = [...caps.pip.allowed_packages];
    const extraBase = unlockableValue(caps.pip.extra_packages);
    packages.push(...extraBase);
    if (isUnlocked(caps.pip.extra_packages) && provisions.pip?.extra_packages) {
      const validExtras = provisions.pip.extra_packages.filter((p) => !p.includes('*'));
      packages.push(...validExtras);
    }
    pip = { allowed_packages: [...new Set(packages)] };
  }

  // --- Merge resources ---
  const resources: ResolvedCapabilities['resources'] = {};
  for (const [name, slot] of Object.entries(caps.resources)) {
    const provision = provisions.resources[name];
    let resourcePath: string | undefined;
    let access = slot.access;
    if (provision) {
      resourcePath = typeof provision === 'string' ? provision : provision.path;
      const provAccess = typeof provision === 'string' ? undefined : provision.access;
      if (provAccess) {
        // Can narrow (rw→ro) but not escalate (ro→rw)
        if (slot.access === 'ro' && provAccess === 'rw') {
          // Escalation attempt — ignore, keep slot access
        } else {
          access = provAccess;
        }
      }
    }
    resources[name] = { description: slot.description, access, required: slot.required, path: resourcePath };
  }

  const missingRequired = Object.entries(resources)
    .filter(([, r]) => r.required && !r.path)
    .map(([name]) => name);

  return {
    disabledTools: [...new Set(disabledTools)],
    pip,
    resources,
    missingRequired,
  };
}

// ---------------------------------------------------------------------------
// MCP server resolution
// ---------------------------------------------------------------------------

/** Read operator-provisioned MCP server env values from config/mcp-servers.json. */
export function readMcpServerSecrets(folder: string): McpServerSecrets {
  return readParsed(agentPath(folder, 'config', 'mcp-servers.json'), McpServerSecretsSchema, {});
}

/** Resolved MCP server config — transport + final env map ready for spawning/connecting. */
export interface ResolvedMcpServer {
  name: string;
  transport: McpServerDeclaration['transport'];
  command?: string;
  args?: string[];
  url?: string;
  env: Record<string, string>;
}

/**
 * Merge MCP server declarations (capabilities.json) with operator env (config/mcp-servers.json).
 * Locked env values pass through from the blueprint. Unlocked slots are filled from operator secrets.
 */
export function resolveMcpServers(folder: string): ResolvedMcpServer[] {
  const caps = readCapabilities(folder);
  const secrets = readMcpServerSecrets(folder);
  const resolved: ResolvedMcpServer[] = [];

  for (const [name, decl] of Object.entries(caps.mcp_servers)) {
    const operatorEnv = secrets[name] ?? {};
    const env: Record<string, string> = {};

    for (const [key, slot] of Object.entries(decl.env)) {
      if (typeof slot === 'string') {
        // Locked — vendor-hardcoded value
        env[key] = slot;
      } else if (slot.unlocked) {
        // Unlocked — operator fills, fall back to blueprint default
        const operatorVal = operatorEnv[key];
        if (operatorVal) {
          env[key] = operatorVal;
        } else if (slot.value) {
          env[key] = slot.value;
        }
        // If required and missing, agent-check will warn — we don't fail here
      }
    }

    resolved.push({
      name,
      transport: decl.transport,
      command: decl.command,
      args: decl.args,
      url: decl.url,
      env,
    });
  }

  return resolved;
}
