/**
 * Container Runner for Cast
 * Spawns agent execution in Apple Container or Docker and handles IPC
 */
import type { ChildProcess, ChildProcessByStdio } from 'child_process';
import { execFile, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import type { Readable, Writable } from 'stream';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_NAME_PREFIX,
  CONTAINER_RUNTIME,
  CONTAINER_TIMEOUT,
  RUNTIME_BINARY,
  RUNTIME_SUPPORTS_CAP_ADD,
  RUNTIME_VERSION,
  AGENTS_DIR,
  IDLE_TIMEOUT,
  agentPath,
  resolveCapabilities,
} from '../config.js';
import {
  AgentConfigSchema,
  ContainerOutputSchema,
  type AgentConfig,
  type ContainerInput as SchemaContainerInput,
  type ContainerOutput as SchemaContainerOutput,
  type ResourceEntry,
} from '@getcast/agent-schema/v1';

import type { AuthMode, AuthResolution } from '../auth/auth.js';
import { resolveModel } from '../lib/resolve-model.js';
import { refreshSecrets } from '../auth/auth.js';
import { readParsed } from '../lib/config-reader.js';
import { logger } from '../logger.js';
import type { LogEventFn } from '../agent/agent-db.js';
import type { LogHostEventFn } from '../server/host-activity-log.js';
import type { Host } from '../types.js';
import { errorMessage } from '../lib/utils.js';

import { buildVolumeMounts, withMcpSocketMount, type VolumeMount } from './container-mounts.js';
import { SDK_ENV_FLAGS } from './sdk-surface.js';

// SIDE EFFECT: Module-level auth state, set once at startup via setAuth().
// Required because runContainerAgent needs secrets but shouldn't re-resolve auth each call.
let resolvedAuth: AuthResolution | null = null;

/** Set the resolved auth for use by runContainerAgent. Called at startup and
 *  whenever credentials change at runtime (e.g. via Settings > Model Access).
 *  Null means Claude is not configured — runContainerAgent throws if asked to
 *  spawn in this state, but callers should pre-check and short-circuit with a
 *  typed `not-configured` fallback instead of letting that throw propagate. */
export function setAuth(auth: AuthResolution | null): void {
  resolvedAuth = auth;
}

/** Read the current resolved auth. Returns null when Claude is not configured. */
export function getResolvedAuth(): AuthResolution | null {
  return resolvedAuth;
}

// SIDE EFFECT: Module-level host activity logger, set once at startup via setHostLogger().
// runContainerAgent uses it to record host-tier failures (spawn errors etc.) without
// threading a callback through 3 layers of agent code. Same pattern as resolvedAuth above.
let hostLogger: LogHostEventFn = () => {};

/** Set the host activity logger for use by runContainerAgent. Called once at startup. */
export function setHostLogger(fn: LogHostEventFn): void {
  hostLogger = fn;
}

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---CAST_OUTPUT_START---';
const OUTPUT_END_MARKER = '---CAST_OUTPUT_END---';

/**
 * Host-side ContainerInput extends the wire payload (`SchemaContainerInput`
 * from agent-schema/v1) with spawn-only fields that configure the Apple
 * Container args, never reach the runner via stdin: mcpPorts (port maps),
 * overrideMounts/workdir/containerNetwork (mode/console session config).
 */
interface ContainerInput extends SchemaContainerInput {
  /** MCP TCP port mappings (name→port) for Docker-on-macOS TCP transport. */
  mcpPorts?: Record<string, number>;
  /** Host path of this spawn's per-conversation MCP socket (nonce'd, socket mode
   *  only). Mounted into the container at the fixed `/mcp/cast.sock`. Absent when
   *  no MCP socket applies (TCP mode, or no console/mcpDeps wired). */
  mcpSocketPath?: string;
  /** Override the default mount table. Used by console sessions. */
  overrideMounts?: VolumeMount[];
  /** Override container CWD. Used by console sessions. */
  workdir?: string;
  /** Override container network policy. Used by console sessions. */
  containerNetwork?: string;
  /** Lifecycle phase for `modelOverrides` resolution. Host-only; stripped before stdin. */
  phase?: 'cleanup';
}

// Container→host IPC schema lives in agent-schema/v1/container-io.ts; re-exported
// here for callers that import `ContainerOutput` from this module.
export type ContainerOutput = SchemaContainerOutput;

const DEFAULT_AGENT_CONFIG = AgentConfigSchema.parse({});

/** Read server-only agent config from config/agent.json. Cached by FileWatcher. */
export function readAgentConfig(agentFolder: string): AgentConfig {
  return readParsed(agentPath(agentFolder, 'config', 'agent.json'), AgentConfigSchema, DEFAULT_AGENT_CONFIG);
}

/** Attachment metadata for stdin protocol (container-side paths, no binary). */
interface StdinAttachment {
  path: string;
  filename: string;
  mimeType: string;
  filesize: number;
}

/** Messages the server can send to an agent process via stdin. */
type AgentStdinMessage =
  | { type: 'message'; text: string; attachments?: StdinAttachment[]; kind?: string; model?: string }
  | { type: 'system'; text: string }
  | { type: 'close' }
  | { type: 'secrets'; data: Record<string, string> };

/**
 * Write a stdin protocol message to an agent process.
 * Used for follow-up messages, close signals, and secrets refresh.
 */
export function writeToAgent(proc: ChildProcess, msg: AgentStdinMessage): boolean {
  if (!proc.stdin || proc.stdin.destroyed) return false;
  try {
    proc.stdin.write(JSON.stringify(msg) + '\n');
    return true;
  } catch {
    return false;
  }
}

/**
 * Refresh OAuth token and send to all active agent processes via stdin.
 * Called on a timer by the server to keep long-running agents authenticated.
 * Accepts active child processes directly — no file scanning needed.
 */
export async function refreshSecretsForAgents(activeProcesses: ChildProcess[]): Promise<void> {
  if (!resolvedAuth) return;
  const secrets = await refreshSecrets(resolvedAuth);
  if (Object.keys(secrets).length === 0) return;
  let sent = 0;
  for (const proc of activeProcesses) {
    if (writeToAgent(proc, { type: 'secrets', data: secrets })) {
      sent++;
    }
  }
  logger.debug({ processCount: activeProcesses.length, sent }, 'Refreshed secrets for active agents');
}

function buildContainerArgs(
  mounts: VolumeMount[],
  containerName: string,
  agentFolder: string,
  containerNetwork?: string,
  containerAllowedEndpoints?: string[],
  mcpPorts?: Record<string, number>,
  workdir?: string,
): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Folder lives on a label, not in the name. Keeps the name short enough that
  // Apple Container's /run/container/<name>/sockets/<uuid>.sock never overflows
  // the macOS sockaddr_un.sun_path 104-byte limit; `sweepContainersForFolder`
  // filters by this label instead of pattern-matching the name.
  args.push('--label', `cast.folder=${agentFolder}`);

  if (workdir) {
    args.push('--workdir', workdir);
  }

  // entrypoint.sh's iptables (sdk-only / none egress) needs NET_ADMIN + NET_RAW.
  // Pass them wherever the runtime both drops those caps by default AND accepts
  // the flag: Docker, and Apple Container >=0.12 (which reduced default caps to
  // the OCI baseline and added --cap-add). Apple Container 0.11 left caps
  // unrestricted and rejects the flag, so RUNTIME_SUPPORTS_CAP_ADD is false
  // there and we skip it. "full" mode applies no iptables — needs neither.
  if (RUNTIME_SUPPORTS_CAP_ADD && containerNetwork !== 'full') {
    args.push('--cap-add=NET_ADMIN', '--cap-add=NET_RAW');
  }

  // 'casthost' resolves to the host machine across runtimes. Docker takes
  // --add-host; Apple Container has no equivalent, handled in entrypoint.sh
  // via /etc/hosts injection.
  if (CONTAINER_RUNTIME === 'docker') {
    args.push('--add-host', 'casthost:host-gateway');
  }

  // MCP TCP transport: container connects to host via TCP instead of Unix sockets
  if (mcpPorts && Object.keys(mcpPorts).length > 0) {
    const portsStr = Object.entries(mcpPorts).map(([n, p]) => `${n}=${p}`).join(',');
    args.push('-e', `CAST_MCP_PORTS=${portsStr}`);
    // Ensure host.docker.internal resolves (automatic on Docker Desktop, explicit on Linux Docker)
    args.push('--add-host', 'host.docker.internal:host-gateway');
  }

  // Container network isolation policy (entrypoint.sh applies iptables rules based on this)
  if (containerNetwork) {
    args.push('-e', `CAST_NETWORK=${containerNetwork}`);
  }
  // SDK feature kill-switches — fleet policy on the wire, not baked into the
  // image (see sdk-surface.ts). The runner's sdkEnv spreads process.env, so
  // these reach the SDK with no runner-side handling.
  for (const [key, value] of Object.entries(SDK_ENV_FLAGS)) {
    args.push('-e', `${key}=${value}`);
  }
  // Additional allowed endpoints for sdk-only mode (comma-separated domain:port pairs)
  if (containerAllowedEndpoints && containerAllowedEndpoints.length > 0) {
    args.push('-e', `CAST_ALLOWED_ENDPOINTS=${containerAllowedEndpoints.join(',')}`);
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(
        '--mount',
        `type=bind,source=${mount.hostPath},target=${mount.containerPath},readonly`,
      );
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(CONTAINER_IMAGE);

  return args;
}

type StdioProcess = ChildProcessByStdio<Writable, Readable, Readable>;

function spawnAgent(
  containerArgs: string[],
): StdioProcess {
  return spawn(RUNTIME_BINARY, containerArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Write a container run log file. Handles both timeout and normal exit variants. */
function writeContainerLog(logsDir: string, ctx: {
  agentName: string;
  duration: number;
  code: number | null;
  timeout?: { containerName: string; hadStreamingOutput: boolean };
  run?: {
    stdoutTruncated: boolean; stderrTruncated: boolean;
    input: ContainerInput; containerArgs: string[]; mounts: VolumeMount[];
    stdout: string; stderr: string;
  };
}): void {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logFile = path.join(logsDir, `container-${timestamp}.log`);

  const lines = [
    `=== Container Run Log${ctx.timeout ? ' (TIMEOUT)' : ''} ===`,
    `Timestamp: ${new Date().toISOString()}`,
    `Agent: ${ctx.agentName}`,
    `Duration: ${ctx.duration}ms`,
    `Exit Code: ${ctx.code}`,
  ];

  if (ctx.timeout) {
    lines.push(
      `Container: ${ctx.timeout.containerName}`,
      `Had Streaming Output: ${ctx.timeout.hadStreamingOutput}`,
    );
  }

  if (ctx.run) {
    const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';
    const isError = ctx.code !== 0;
    lines.push(
      `Stdout Truncated: ${ctx.run.stdoutTruncated}`,
      `Stderr Truncated: ${ctx.run.stderrTruncated}`,
      ``,
    );

    if (isVerbose || isError) {
      lines.push(
        `=== Input ===`, JSON.stringify(ctx.run.input, null, 2), ``,
        `=== Container Args ===`, ctx.run.containerArgs.join(' '), ``,
        `=== Mounts ===`,
        ctx.run.mounts.map((m) => `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`).join('\n'), ``,
        `=== Stderr${ctx.run.stderrTruncated ? ' (TRUNCATED)' : ''} ===`, ctx.run.stderr, ``,
        `=== Stdout${ctx.run.stdoutTruncated ? ' (TRUNCATED)' : ''} ===`, ctx.run.stdout,
      );
    } else {
      lines.push(
        `=== Input Summary ===`,
        `Prompt length: ${ctx.run.input.prompt.length} chars`,
        `Session ID: ${ctx.run.input.sessionId || 'new'}`, ``,
        `=== Mounts ===`,
        ctx.run.mounts.map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`).join('\n'), ``,
      );
    }
  }

  // Tolerate missing logs dir (folder deleted mid-conversation) and any other
  // write error — losing a debug log must never crash the host process. ENOENT
  // is the expected case after a hot agent unload; other errors (perms, disk
  // full) keep their WARN level so they don't get lost in steady-state noise.
  try {
    fs.writeFileSync(logFile, lines.join('\n'));
    logger.debug({ logFile }, 'Container log written');
  } catch (err) {
    const isExpectedEnoent =
      err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT';
    const level = isExpectedEnoent ? 'debug' : 'warn';
    logger[level]({ err, agent: ctx.agentName, logFile }, 'Container log write failed');
  }
}

/**
 * Classify and dispatch stderr lines from the agent-runner.
 * - `[sdk-activity]`: activity signal → invoke callback, don't log
 * - `[stream] ...`: token-level streaming → log at trace level
 * - Everything else: normal agent-runner logs → log at debug level
 */
function processStderrLine(line: string, agent: string, onActivity?: () => void): void {
  if (line.includes('[sdk-activity]')) {
    onActivity?.();
    return;
  }
  if (line.includes('[stream]')) {
    logger.trace({ container: agent }, line);
    return;
  }
  logger.debug({ container: agent }, line);
}

/**
 * Parse OUTPUT_START/END marker pairs from a buffer.
 * Returns the remaining (unparsed) buffer for the next chunk.
 */
function parseStreamedOutputMarkers(
  buffer: string,
  agentName: string,
  onParsed: (output: ContainerOutput) => void,
  onParseError?: (err: unknown) => void,
): string {
  let startIdx: number;
  while ((startIdx = buffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
    const endIdx = buffer.indexOf(OUTPUT_END_MARKER, startIdx);
    if (endIdx === -1) break; // Incomplete pair, wait for more data

    const jsonStr = buffer.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim();
    buffer = buffer.slice(endIdx + OUTPUT_END_MARKER.length);

    try {
      const parsed = ContainerOutputSchema.parse(JSON.parse(jsonStr));
      logger.debug(
        { agent: agentName, type: parsed.type },
        'Output marker parsed',
      );
      onParsed(parsed);
    } catch (err) {
      logger.warn({ agent: agentName, error: err }, 'Failed to parse streamed output chunk');
      onParseError?.(err);
    }
  }
  return buffer;
}

/** Create a resettable timeout that calls onTimeout when it fires. */
function createResettableTimeout(ms: number, onTimeout: () => void): { reset: () => void; clear: () => void; timedOut: boolean } {
  const state = { timedOut: false };
  let timer = setTimeout(() => { state.timedOut = true; onTimeout(); }, ms);
  return {
    reset() {
      clearTimeout(timer);
      timer = setTimeout(() => { state.timedOut = true; onTimeout(); }, ms);
    },
    clear() { clearTimeout(timer); },
    get timedOut() { return state.timedOut; },
  };
}

export async function runContainerAgent(
  agent: Host,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  onActivity?: () => void,
  onLogEvent?: LogEventFn,
  // Host-side flag query: returns true if a host caller (runner.destroy /
  // runner.close) initiated this teardown. Used to distinguish our own
  // SIGTERMs from external kills by the container runtime so the close
  // handler can attribute the cause correctly.
  wasStopRequested?: () => boolean,
): Promise<ContainerOutput> {
  const logEvent: LogEventFn = onLogEvent ?? (() => {});
  const conversationKey = input.conversationKey;
  const startTime = Date.now();

  const agentDir = path.join(AGENTS_DIR, agent.folder);
  // Refuse to spawn against a missing folder. Failing closed here prevents
  // a deleted agent from being silently resurrected by a fresh blank-state
  // container on the next inbound message. We check folder existence (not
  // `manifest.json`) because console manager scratch folders
  // (`.config-manager`, `.design-manager`, `.security-manager`) legitimately
  // have no manifest but are real spawn targets.
  if (!fs.existsSync(agentDir)) {
    throw new Error(`Agent folder "${agent.folder}" no longer exists; refusing to spawn container`);
  }

  const agentConfig = readAgentConfig(agent.folder);
  const resolved = resolveCapabilities(agent.folder);
  // Convert resolved resources (with paths) to mount-ready format
  const mountResources: Record<string, ResourceEntry> = {};
  for (const [name, res] of Object.entries(resolved.resources)) {
    if (res.path) mountResources[name] = { path: res.path, access: res.access };
  }
  // Per-conversation MCP socket → fixed `/mcp/cast.sock`, appended here at the
  // spawn chokepoint from this spawn's nonce'd host path (see withMcpSocketMount).
  const mounts = withMcpSocketMount(
    input.overrideMounts ?? buildVolumeMounts(agent, input.conversationKey, mountResources),
    input.mcpSocketPath,
  );
  // Folder is deliberately not in the container name. Apple Container's
  // per-container UDS path `/run/container/<name>/sockets/<uuid>.sock` is
  // bounded by sockaddr_un.sun_path (104 bytes), and embedding folder caused
  // long-named agents to overflow it. Folder is carried as a `cast.folder`
  // label instead — see `buildContainerArgs`. The 6-hex suffix is per-spawn
  // collision avoidance; folder identity comes from the label.
  const containerName = `${CONTAINER_NAME_PREFIX}${randomBytes(3).toString('hex')}`;
  const effectiveNetwork = input.containerNetwork ?? agentConfig.containerNetwork;
  const containerArgs = buildContainerArgs(mounts, containerName, agent.folder, effectiveNetwork, agentConfig.containerAllowedEndpoints, input.mcpPorts, input.workdir);

  logger.debug(
    {
      agent: agent.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      agent: agent.name,
      containerName,
      mountCount: mounts.length,
    },
    'Spawning agent',
  );

  const logsDir = path.join(AGENTS_DIR, agent.folder, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Inject model from server-only config (agent can't see this).
  // Strip host-only `phase` before stdin. channelName now rides the wire (the
  // runner attests it + participant as _meta for approval routing), so it stays
  // in wireInput; it's still read here for modelOverrides resolution.
  const { phase, ...wireInput } = input;
  const model =
    wireInput.model || resolveModel(agentConfig, { channelName: input.channelName, phase });
  // If this spawn includes a bootstrap call, pre-resolve its model separately
  // (phase='bootstrap'). Falls back to the main model in the runner if unset.
  const bootstrapModel =
    wireInput.bootstrap !== undefined
      ? resolveModel(agentConfig, { channelName: input.channelName, phase: 'bootstrap' })
      : undefined;

  // Resolve secrets before spawning. Pre-spawn null check in conversation-runner
  // short-circuits the not-configured case with a typed fallback; if we reach
  // here with null auth, something bypassed that guard — fail loudly.
  if (!resolvedAuth) throw new Error('Auth not initialized — call setAuth() before spawning agents');
  const secrets = await refreshSecrets(resolvedAuth);

  return new Promise((resolve) => {
    const container = spawnAgent(containerArgs);

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    const settle = (output: ContainerOutput) => {
      if (settled) return;
      settled = true;
      resolve(output);
    };

    // Pass init message via stdin as newline-delimited JSON.
    // Stdin stays open for follow-up messages, close, and secrets refresh.
    const initMsg = {
      type: 'init' as const,
      ...wireInput,
      model,
      ...(bootstrapModel ? { bootstrapModel } : {}),
      // Cold-path cleanup: no warm container to pipe into, so the cleanup turn
      // runs as this fresh spawn's init prompt. Tag it so the runner attributes
      // the turn's usage to the `cleanup` phase. (`phase` itself is host-only,
      // stripped above; this boolean is the wire-visible derivative.)
      ...(phase === 'cleanup' ? { isCleanup: true } : {}),
      secrets,
    };
    container.stdin.write(JSON.stringify(initMsg) + '\n');

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { agent: agent.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer = parseStreamedOutputMarkers(
          parseBuffer + chunk,
          agent.name,
          (parsed) => {
            if (parsed.type === 'message' && parsed.newSessionId) newSessionId = parsed.newSessionId;
            if (parsed.type === 'error' && parsed.newSessionId) newSessionId = parsed.newSessionId;
            if (parsed.type !== 'lifecycle') hadStreamingOutput = true;
            resetTimeout();
            outputChain = outputChain.then(() => onOutput(parsed)).catch((err) => {
              logger.error(
                { agent: agent.name, error: errorMessage(err), type: parsed.type },
                'Output callback failed — output dropped',
              );
            });
          },
          (err) => {
            logEvent('warn', 'container', 'output_parse_failed', `Failed to parse streamed output chunk: ${String(err)}`, {
              conversationKey,
              context: { agent: agent.name, error: String(err) },
            });
          },
        );
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) processStderrLine(line, agent.folder, onActivity);
      }
      // Don't reset timeout on stderr — SDK writes debug logs continuously.
      // Timeout only resets on actual output (OUTPUT_MARKER in stdout).
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { agent: agent.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    let hadStreamingOutput = false;
    const configTimeout = CONTAINER_TIMEOUT;
    // Grace period: hard timeout must be at least IDLE_TIMEOUT + 30s so the
    // graceful _close sentinel has time to trigger before the hard kill fires.
    const timeoutMs = Math.max(configTimeout, IDLE_TIMEOUT + 30_000);

    const hardTimeout = createResettableTimeout(timeoutMs, () => {
      logger.error({ agent: agent.name, containerName }, 'Container timeout, stopping gracefully');
      logEvent('error', 'container', 'timeout', `Container ${containerName} exceeded ${timeoutMs}ms, stopping`, {
        conversationKey,
        context: { containerName, timeoutMs },
      });
      execFile(RUNTIME_BINARY, ['stop', containerName], { timeout: 15000 }, (err) => {
        if (err) {
          logger.warn({ agent: agent.name, containerName, err }, 'Graceful stop failed, force killing');
          logEvent('warn', 'container', 'force_kill', `Graceful stop failed for ${containerName}, SIGKILL`, {
            conversationKey,
            context: { containerName, error: String(err) },
          });
          container.kill('SIGKILL');
        }
      });
    });
    const resetTimeout = () => hardTimeout.reset();

    container.on('close', (code) => {
      hardTimeout.clear();
      const duration = Date.now() - startTime;

      if (hardTimeout.timedOut) {
        writeContainerLog(logsDir, {
          agentName: agent.name, duration, code,
          timeout: { containerName, hadStreamingOutput },
        });

        if (hadStreamingOutput) {
          logger.info(
            { agent: agent.name, containerName, duration, code },
            'Container timed out after output (idle cleanup)',
          );
          outputChain
            .catch((err) => logger.error({ agent: agent.name, error: errorMessage(err) }, 'Output chain error at close'))
            .then(() => settle({ type: 'message', result: '', newSessionId }));
          return;
        }

        logger.error({ agent: agent.name, containerName, duration, code }, 'Container timed out with no output');
        settle({ type: 'error', error: `Container timed out after ${configTimeout}ms`, cause: 'timeout' });
        return;
      }

      writeContainerLog(logsDir, {
        agentName: agent.name, duration, code,
        run: { stdoutTruncated, stderrTruncated, input, containerArgs, mounts, stdout, stderr },
      });

      if (code !== 0) {
        // External kill: SIGTERM (143) or SIGKILL (137) that no host caller
        // initiated. Apple Container kills agent containers under host memory
        // pressure with these codes; tagging the cause lets the fallback path
        // surface "retry; resource pressure" copy instead of the generic
        // stopped-no-output message.
        const stopRequested = wasStopRequested?.() ?? false;
        const isSignalExit = code === 143 || code === 137;
        const cause: 'external_kill' | 'agent_error' = (!stopRequested && isSignalExit)
          ? 'external_kill'
          : 'agent_error';
        const eventName = cause === 'external_kill' ? 'external_kill' : 'exit_with_error';
        const signal = code === 143 ? 'SIGTERM' : code === 137 ? 'SIGKILL' : null;
        const eventMessage = cause === 'external_kill'
          ? `Container externally killed (${signal}); likely host resource pressure`
          : `Container exited code=${code}`;
        logger.error({ agent: agent.name, code, duration, cause, runtime: CONTAINER_RUNTIME, runtimeVersion: RUNTIME_VERSION, stderr, stdout }, 'Container exited with error');
        logEvent('error', 'container', eventName, eventMessage, {
          conversationKey,
          context: { code, duration, cause, stderrTail: stderr.slice(-200) },
        });
        settle({ type: 'error', error: `Container exited with code ${code}: ${stderr.slice(-200)}`, cause });
        return;
      }

      outputChain
        .catch((err) => logger.error({ agent: agent.name, error: errorMessage(err) }, 'Output chain error at close'))
        .then(() => {
          logger.info({ agent: agent.name, duration, newSessionId }, 'Container completed');
          settle({ type: 'message', result: '', newSessionId });
        });
    });

    container.on('error', (err) => {
      hardTimeout.clear();
      logger.error({ agent: agent.name, containerName, runtime: CONTAINER_RUNTIME, runtimeVersion: RUNTIME_VERSION, error: err }, 'Container spawn error');
      logEvent('error', 'container', 'spawn_failed', `Container spawn syscall failed: ${err.message}`, {
        conversationKey,
        context: { containerName, error: err.message },
      });
      hostLogger('error', 'container', 'spawn_failed', `Container spawn failed for "${agent.name}": ${err.message}`, {
        context: { agentName: agent.name, agentFolder: agent.folder, containerName, error: err.message },
      });
      settle({
        type: 'error',
        error: `Container spawn error: ${err.message}`,
        cause: 'spawn_failure',
      });
    });
  });
}


