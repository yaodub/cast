/**
 * AgentService — per-agent service process lifecycle.
 *
 * Manages a child process that runs the agent's service (cron jobs, MCP tools,
 * etc.). Owns the state machine (idle → running → restarting → stopped),
 * IPC message handling, and exponential backoff on crash.
 *
 * Extracted from AgentManager to separate the service process concern from
 * conversation routing and runner lifecycle.
 */
import { spawn, type ChildProcess } from 'child_process';
import { randomInt } from 'crypto';
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { ADMIN_SOCKET_NAME, CAST_PORT, agentPath } from '../config.js';
import { logger } from '../logger.js';
import type { RouteResult } from '../types.js';
import type { LogEventFn } from './agent-db.js';
import { RestartBreaker } from './restart-breaker.js';

// --- Schemas ---

const ServiceManifestSchema = z.object({
  entry: z.string().optional(),
}).passthrough();

const ServiceIpcMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('route-message'), id: z.string(), channel: z.string(), text: z.string(), target: z.string().optional() }),
  z.object({
    type: z.literal('request-approval'), id: z.string(), tool: z.string(), args: z.string(),
    summary: z.string(), details: z.string().optional(), participant: z.string(),
    channel: z.string().optional(), conversationKey: z.string().optional(), expiresIn: z.number().optional(),
  }),
  z.object({
    type: z.literal('approval-tool-result'), id: z.string(), result: z.string(), isError: z.boolean().optional(),
  }),
]);

// --- Constants ---

const MIN_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;
const SHUTDOWN_TIMEOUT = 5_000;
const STABLE_UPTIME = 30_000;

/** RestartBreaker thresholds. Five crashes in five minutes is unambiguously
 *  broken — the agent's service binary isn't going to fix itself by trying
 *  again. The breaker holds the service in `failed` until operator action
 *  (CLI/admin-UI restart) or a stable run resets it. */
const MAX_RESTARTS_IN_WINDOW = 5;
const RESTART_WINDOW_MS = 5 * 60_000;

// --- State ---

/**
 * Lifecycle phases:
 *   idle       — fresh or post-crash (with restart timer cleared); start() spawns
 *   starting   — child spawned, waiting for IPC `ready`; resolveReady fires the start() promise
 *   running    — child has signalled ready; fully operational
 *   restarting — between runs after a crash; timer triggers next start()
 *   stopped    — explicit stop() called; do not auto-restart
 *   failed     — RestartBreaker tripped; will not auto-restart until reset
 *                via operator-triggered `restart()`
 */
type ServiceState =
  | { status: 'idle' }
  | {
      status: 'starting';
      process: ChildProcess;
      startedAt: number;
      resolveReady: () => void;
      rejectReady: (err: Error) => void;
    }
  | { status: 'running'; process: ChildProcess; startedAt: number }
  | { status: 'restarting'; timer: ReturnType<typeof setTimeout> }
  | { status: 'stopped' }
  | { status: 'failed'; reason: string; failedAt: number };

// --- Service class ---

interface AgentServiceOpts {
  folder: string;
  onRouteMessage: (channel: string, text: string, target?: string) => Promise<RouteResult>;
  onRequestApproval?: (data: {
    tool: string; args: Record<string, unknown>; summary: string; details?: string;
    participant: string; channel?: string; conversationKey?: string; expiresIn?: number;
  }) => string;
  onApprovalToolResult?: (id: string, result: string, isError?: boolean) => void;
  onLogEvent?: LogEventFn;
}

export class AgentService {
  private folder: string;
  private onRouteMessage: AgentServiceOpts['onRouteMessage'];
  private onRequestApproval: AgentServiceOpts['onRequestApproval'];
  private onApprovalToolResult: AgentServiceOpts['onApprovalToolResult'];
  private logEvent: LogEventFn;
  private state: ServiceState = { status: 'idle' };
  private backoff = MIN_BACKOFF;
  private restartBreaker = new RestartBreaker(MAX_RESTARTS_IN_WINDOW, RESTART_WINDOW_MS);

  constructor(opts: AgentServiceOpts) {
    this.folder = opts.folder;
    this.onRouteMessage = opts.onRouteMessage;
    this.onRequestApproval = opts.onRequestApproval;
    this.onApprovalToolResult = opts.onApprovalToolResult;
    this.logEvent = opts.onLogEvent ?? (() => {});
  }

  /** Send an execute-approved-tool IPC message to the service process.
   *  Returns false if the service isn't accepting IPC right now (not
   *  started, mid-restart, terminated). J.6c — first production consumer
   *  of `isReady()`: named check beats relying on `process.send` to fail
   *  for not-started services. */
  executeApprovedTool(id: string, tool: string, args: Record<string, unknown>): boolean {
    if (!this.isReady()) return false;
    const proc = this.process;
    if (!proc) return false;
    try { proc.send({ type: 'execute-approved-tool', id, tool, args: JSON.stringify(args) }); return true; } catch { return false; }
  }

  /**
   * The active service process. Available during `starting` and `running`.
   *
   * Snapshot-only — exposed for IPC writes that the service owns (stdin
   * pipes for OAuth-secret refresh in `refreshSecretsForAgents`) and for
   * tests. Production code MUST NOT derive aliveness from
   * `.exitCode`/`.signalCode` here; ask `isReady()` instead.
   */
  get process(): ChildProcess | null {
    return this.state.status === 'starting' || this.state.status === 'running'
      ? this.state.process : null;
  }

  /**
   * Current lifecycle status, for human-visible snapshots (the Design /
   * Configure console summaries surface this raw enum to the operator).
   *
   * Production branching should consume `isReady()` — the raw enum is for
   * display + diagnostics, not for "should I forward work to the service."
   */
  get status(): ServiceState['status'] {
    return this.state.status;
  }

  /**
   * True iff the service is in a state where IPC writes will land in a
   * running process (`running`). `starting` returns false because the
   * service hasn't signalled `ready` yet — IPC sends would race the spawn.
   *
   * The primary production predicate. `status` and `process` are diagnostic
   * surfaces; reach for those only when you specifically need the snapshot
   * value or the raw handle.
   */
  isReady(): boolean {
    return this.state.status === 'running';
  }

  start(): Promise<void> {
    if (
      this.state.status === 'starting'
      || this.state.status === 'running'
      || this.state.status === 'restarting'
    ) {
      logger.debug({ agentFolder: this.folder, status: this.state.status }, 'Service already running or restarting');
      return Promise.resolve();
    }

    // Circuit-broken services do not auto-start. Operator must call restart()
    // (CLI or admin UI), which clears the breaker before re-entering start().
    if (this.state.status === 'failed') {
      logger.debug({ agentFolder: this.folder, reason: this.state.reason }, 'Service in failed state — start() refused');
      return Promise.resolve();
    }

    // Resolve service entrypoint from blueprint/service/manifest.json.
    // If manifest declares "entry", use that (relative to blueprint/service/).
    // Otherwise fall back to blueprint/service/index.js (stamped bundle).
    const blueprintServiceDir = agentPath(this.folder, 'blueprint', 'service');
    const serviceManifestPath = path.join(blueprintServiceDir, 'manifest.json');
    if (!fs.existsSync(serviceManifestPath)) return Promise.resolve();

    let entrypoint: string;
    let runner: string;

    try {
      const manifest = ServiceManifestSchema.parse(JSON.parse(fs.readFileSync(serviceManifestPath, 'utf-8')));
      const entry = manifest.entry;

      if (entry) {
        entrypoint = path.resolve(blueprintServiceDir, entry);
        if (!fs.existsSync(entrypoint)) {
          logger.warn({ agentFolder: this.folder, entry }, 'Service manifest entry not found, skipping');
          this.logEvent('warn', 'service', 'manifest_missing', `Service manifest entry not found: ${entry}`, { context: { entry } });
          return Promise.resolve();
        }
        if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
          runner = 'tsx';
        } else {
          // Absolute path of the node running the server, not bare 'node' — the
          // server's PATH (e.g. when launched under pm2) may not include node's dir.
          runner = process.execPath;
        }
      } else {
        // Default: stamped bundle
        const bundledEntry = path.join(blueprintServiceDir, 'index.js');
        if (!fs.existsSync(bundledEntry)) return Promise.resolve();
        entrypoint = bundledEntry;
        // Absolute path of the node running the server, not bare 'node' — the
        // server's PATH (e.g. when launched under pm2) may not include node's dir.
        runner = process.execPath;
      }
    } catch {
      return Promise.resolve();
    }

    const serviceDir = agentPath(this.folder, 'ext', 'service');
    const sharedDir = agentPath(this.folder, 'shared', 'ext', 'service');
    const agentDir = agentPath(this.folder);

    // Ensure the service's runtime dirs exist before spawning. serviceDir is the
    // child's cwd. A missing cwd makes spawn() throw ENOENT against the *binary*
    // path, which misreads as "node not found". sharedDir is where the service
    // writes agent-visible output. Normally seeded by `agent init`, but the server
    // must not assume it (restored/hand-built/migrated folders), the same way it
    // creates state/ on demand.
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.mkdirSync(sharedDir, { recursive: true });

    // Clean stale agent.sock — the service recreates it if it registers tools.
    // A leftover socket from a prior run causes a 60s timeout in the container.
    const agentSockPath = path.join(agentDir, 'mcp', 'agent.sock');
    try { fs.unlinkSync(agentSockPath); } catch { /* doesn't exist */ }

    const serviceConfig = {
      agentDir,
      agentFolder: this.folder,
      serviceDir,
      sharedDir,
      webBaseUrl: process.env.CAST_WEB_BASE_URL || `http://localhost:${CAST_PORT}`,
      adminSocketPath: path.join(agentDir, ADMIN_SOCKET_NAME),
      mcpSocketPath: path.join(agentDir, 'mcp', 'agent.sock'),
      serviceContextPath: path.join(sharedDir, 'agent-context.md'),
    };

    const proc = spawn(runner, [entrypoint], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      cwd: serviceDir,
      env: { ...process.env, CAST_SERVICE_CONFIG: JSON.stringify(serviceConfig) },
    });

    proc.stdin?.end();

    proc.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trimEnd();
      if (text) logger.info({ agentFolder: this.folder, source: 'service' }, text);
    });
    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString().trimEnd();
      if (text) logger.debug({ agentFolder: this.folder, source: 'service-stdout' }, text);
    });
    proc.on('message', (raw: unknown) => this.handleIpcMessage(proc, raw));
    proc.on('close', (code, signal) => this.handleProcessClose(code, signal));
    proc.on('error', (err) => this.handleProcessError(err));

    return new Promise<void>((resolve, reject) => {
      this.state = {
        status: 'starting',
        process: proc,
        startedAt: Date.now(),
        resolveReady: resolve,
        rejectReady: reject,
      };
    });
  }

  /** Manual restart — bypasses crash-recovery backoff and resets the
   *  RestartBreaker. The single re-entry path out of `failed`. */
  async restart(): Promise<void> {
    await this.stop();
    this.backoff = MIN_BACKOFF;
    this.restartBreaker.reset();
    this.state = { status: 'idle' };
    await this.start();
  }

  stop(): Promise<void> {
    const prev = this.state;

    if (prev.status === 'restarting') {
      clearTimeout(prev.timer);
      this.state = { status: 'stopped' };
      return Promise.resolve();
    }

    // Stopping mid-startup: reject the pending start() promise, then kill the
    // child the same way as a 'running' stop. handleProcessClose will see
    // status === 'stopped' and skip the auto-restart path.
    if (prev.status === 'starting') {
      prev.rejectReady(new Error(`Service for ${this.folder} stopped during startup`));
    }

    if (prev.status !== 'starting' && prev.status !== 'running') {
      this.state = { status: 'stopped' };
      return Promise.resolve();
    }

    const proc = prev.process;
    this.state = { status: 'stopped' };
    try { proc.send({ type: 'shutdown' }); } catch { /* already dead */ }

    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        logger.warn({ agentFolder: this.folder }, 'Agent service did not exit in time, killing');
        this.logEvent('warn', 'service', 'shutdown_timeout', 'Agent service did not exit in time, killing');
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
        resolve();
      }, SHUTDOWN_TIMEOUT);

      proc.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // =========================================================================
  // Event handlers
  // =========================================================================

  private handleIpcMessage(proc: ChildProcess, raw: unknown): void {
    const parsed = ServiceIpcMessageSchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn({ agentFolder: this.folder, raw }, 'Invalid IPC message from service');
      this.logEvent('warn', 'service', 'ipc_message_invalid', 'Received unparseable IPC message from service');
      return;
    }
    const msg = parsed.data;

    switch (msg.type) {
      case 'ready':
        if (this.state.status === 'starting') {
          const { resolveReady, process: spawned, startedAt } = this.state;
          this.state = { status: 'running', process: spawned, startedAt };
          logger.info({ agentFolder: this.folder }, 'Agent service ready');
          this.logEvent('info', 'service', 'started', 'Agent service ready');
          resolveReady();
        }
        break;

      case 'route-message': {
        this.onRouteMessage(msg.channel, msg.text, msg.target)
          .then((res) => {
            // Translate host-side RouteResult union into the IPC schema
            // exposed by agent-service-base (still { result, error } shape).
            const result = res.ok ? res.result : null;
            const error = res.ok ? null : res.error;
            try { proc.send({ type: 'route-result', id: msg.id, result, error }); } catch { logger.debug({ agentFolder: this.folder }, 'IPC send failed (process dead)'); }
          })
          .catch((err) => {
            logger.error({ agentFolder: this.folder, msgId: msg.id, err }, 'route-message failed');
            this.logEvent('error', 'service', 'route_message_failed', `Service route-message handler threw: ${String(err)}`, { context: { msgId: msg.id } });
            try { proc.send({ type: 'route-result', id: msg.id, result: null, error: String(err) }); } catch { logger.debug({ agentFolder: this.folder }, 'IPC send failed (process dead)'); }
          });
        break;
      }

      case 'request-approval': {
        if (this.onRequestApproval) {
          const approvalId = this.onRequestApproval({
            tool: msg.tool,
            args: JSON.parse(msg.args),
            summary: msg.summary,
            details: msg.details,
            participant: msg.participant,
            channel: msg.channel,
            conversationKey: msg.conversationKey,
            expiresIn: msg.expiresIn,
          });
          logger.info({ agentFolder: this.folder, approvalId, tool: msg.tool }, 'Service requested approval');
        }
        break;
      }

      case 'approval-tool-result': {
        if (this.onApprovalToolResult) {
          this.onApprovalToolResult(msg.id, msg.result, msg.isError);
        }
        break;
      }
    }
  }

  private handleProcessClose(code: number | null, signal: string | null): void {
    // Stable-uptime reset: a service that ran ≥ STABLE_UPTIME before crashing
    // counts as healthy enough to reset both the backoff and the breaker.
    // Without this, a chronically flaky service that recovers for a while in
    // between bursts would still trip on the cumulative count.
    if (this.state.status === 'running' || this.state.status === 'starting') {
      const uptime = Date.now() - this.state.startedAt;
      if (uptime >= STABLE_UPTIME) {
        this.backoff = MIN_BACKOFF;
        this.restartBreaker.reset();
      }
    }

    if (this.state.status === 'starting') {
      const { rejectReady } = this.state;
      this.state = { status: 'idle' };
      rejectReady(new Error(`Service for ${this.folder} exited before ready (code=${code}, signal=${signal})`));
      return;
    }

    if (this.state.status === 'stopped') return;

    // Circuit-breaker check. Record this crash; if the breaker trips, halt
    // the auto-restart chain and transition to `failed` for operator action.
    const now = Date.now();
    const breakerState = this.restartBreaker.record(now);
    if (breakerState.kind === 'tripped') {
      logger.error(
        { agentFolder: this.folder, code, signal, reason: breakerState.reason },
        'Agent service circuit broken — manual restart required',
      );
      this.logEvent(
        'error', 'service', 'circuit_broken',
        `Service circuit broken: ${breakerState.reason}; not auto-restarting`,
        { context: { code, signal, reason: breakerState.reason } },
      );
      this.backoff = MIN_BACKOFF;
      this.state = { status: 'failed', reason: breakerState.reason, failedAt: now };
      return;
    }

    // Jittered backoff (10%) prevents thundering-herd restart when N agents crash simultaneously.
    const backoff = this.backoff;
    const jitteredBackoff = Math.round(backoff * (1 + randomInt(0, 100) / 1000));
    logger.warn(
      { agentFolder: this.folder, code, signal, backoffMs: jitteredBackoff },
      'Agent service exited, scheduling restart',
    );
    this.logEvent('warn', 'service', 'crashed', `Agent service exited (code=${code}, signal=${signal}); restart in ${jitteredBackoff}ms`, {
      context: { code, signal, backoffMs: jitteredBackoff },
    });

    const timer = setTimeout(() => {
      this.state = { status: 'idle' };
      this.logEvent('info', 'service', 'restarted', 'Agent service auto-restarting after crash');
      this.start().catch((err) => {
        logger.error({ agentFolder: this.folder, err }, 'Agent service restart failed');
        this.logEvent('error', 'service', 'restart_failed', `Service restart failed: ${String(err)}`);
      });
    }, jitteredBackoff);

    this.backoff = Math.min(backoff * 2, MAX_BACKOFF);
    this.state = { status: 'restarting', timer };
  }

  private handleProcessError(err: Error): void {
    logger.error({ agentFolder: this.folder, err }, 'Agent service spawn error');
    if (this.state.status === 'starting') {
      const { rejectReady } = this.state;
      this.state = { status: 'idle' };
      rejectReady(err);
    }
  }
}
