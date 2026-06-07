/**
 * tRPC initialization — router factory, context, and auth middleware.
 *
 * Context carries the session state and shared dependencies.
 * Two procedure types: publicProcedure (no auth) and adminProcedure (session required).
 *
 * Auth uses Bearer tokens in the Authorization header (not cookies).
 * Tokens are persisted to `CONFIG_DIR/admin-sessions.json` so they survive
 * server restart. The admin server binds to 127.0.0.1 only — on localhost a
 * malicious process can read process memory or this file equally, so a TTL
 * adds friction without security.
 */
import fs from 'fs';
import path from 'path';

import { initTRPC, TRPCError } from '@trpc/server';
import type { CreateExpressContextOptions } from '@trpc/server/adapters/express';
import { z } from 'zod';

import type { AgentManager } from '../agent/agent-manager.js';
import type { AuthResolution } from '../auth/auth.js';
import type { AgentVerifyResult, IdentityProvider } from '../auth/identity.js';
import { CONFIG_DIR } from '../config.js';
import type { Bus } from '../gateway/bus.js';
import type { MessageGateway } from '../gateway/message-gateway.js';
import type { FileWatcher } from '../lib/file-watcher.js';
import type { HostActivityLog } from '../server/host-activity-log.js';
import { writeAtomic } from '../lib/utils.js';
import { logger } from '../logger.js';
import type { ConsoleTransport } from '../transports/console.js';
import type { Transport } from '../transports/schema.js';

// ---------------------------------------------------------------------------
// Alias resolution — single shared boundary for admin routers
// ---------------------------------------------------------------------------

/**
 * Resolve a human-facing alias (manifest.name) to the agent's filesystem folder
 * via bus metadata. Throws NOT_FOUND if the alias is not currently registered.
 *
 * This is *the* boundary at which the admin API accepts aliases and the server
 * switches to folder-indexed filesystem reads. Never use `entity.label` as a
 * path argument — it's the alias, not the folder.
 */
export function aliasToFolder(deps: Pick<AdminDeps, 'bus'>, alias: string): string {
  const key = deps.bus.resolveByLabel(alias);
  const folder = key ? deps.bus.getMetadata(key)?.folderPath : undefined;
  if (!folder) throw new TRPCError({ code: 'NOT_FOUND', message: `Agent "${alias}" not found` });
  return folder;
}

/** Mask a secret for display — show only last 4 characters. */
export function maskSecret(value: string): string {
  if (value.length <= 8) return '••••';
  return '••••' + value.slice(-4);
}

// ---------------------------------------------------------------------------
// Dependencies — passed from the main entry point
// ---------------------------------------------------------------------------

export type DiscoverAgentResult =
  | { ok: true; name: string; description?: string; agentAuth: AgentVerifyResult }
  | { ok: false; reason: string };

export interface AdminDeps {
  bus: Bus;
  idp: IdentityProvider;
  gateway: MessageGateway;
  consoleTransport: ConsoleTransport;
  getManager: (folder: string) => AgentManager | undefined;
  listFolders: () => string[];
  getAuth: () => AuthResolution | null;
  getTransports: () => Transport[];
  watcher: FileWatcher;
  /** Pick up a newly-written agent folder without waiting for the watcher. Idempotent. */
  discoverAndRegisterAgent: (folder: string) => Promise<DiscoverAgentResult>;
  /**
   * Shut down and unregister an agent. Stops runners/service, removes the
   * bus handler, removes the manager from the registry. Caller handles
   * on-disk cleanup (zip + folder removal). Idempotent — no-op when the
   * manager is already gone.
   */
  unregisterAgent: (folder: string) => Promise<void>;
  /** Host-tier structured event log. Surfaced via the `host.activityLog` tRPC procedure. */
  hostActivityLog: HostActivityLog;
  /** Apply a credentials change at runtime: update the auth singleton and push
   *  the new secrets to every active agent container via the `{type:'secrets'}`
   *  stdin protocol. Called by `updateCredentials` after verify succeeds so the
   *  change takes effect without restarting the server. Accepts null to enter
   *  the "Claude not configured" state (containers will reject new spawns). */
  applyAuthChange: (auth: AuthResolution | null) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Session — Bearer token validated against persisted file + in-memory Set
// ---------------------------------------------------------------------------

const SessionRecordSchema = z.object({
  token: z.string(),
  createdAt: z.string(),
  label: z.string().optional(),
});
type SessionRecord = z.infer<typeof SessionRecordSchema>;

const SessionsFileSchema = z.object({
  sessions: z.array(SessionRecordSchema),
});

const sessionsFilePath = (): string => path.join(CONFIG_DIR, 'admin-sessions.json');

// Authoritative records (for write-back) and a derived O(1) token set for validation.
// Both are kept in sync; hydration is lazy so tests that import this module without
// a CONFIG_DIR populated don't pay an fs.readFileSync at import time.
let records: SessionRecord[] | null = null;
let tokenSet: Set<string> | null = null;

function hydrate(): void {
  if (records !== null) return;
  const filePath = sessionsFilePath();
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = SessionsFileSchema.parse(JSON.parse(raw));
    records = parsed.sessions;
    tokenSet = new Set(parsed.sessions.map((s) => s.token));
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      logger.warn(
        { filePath, err: err instanceof Error ? err.message : String(err) },
        'Failed to load admin sessions — starting with empty set',
      );
    }
    records = [];
    tokenSet = new Set();
  }
}

function persist(): void {
  const filePath = sessionsFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeAtomic(filePath, JSON.stringify({ sessions: records ?? [] }, null, 2));
}

export function createSession(label?: string): string {
  hydrate();
  const token = crypto.randomUUID();
  const record: SessionRecord = { token, createdAt: new Date().toISOString() };
  if (label !== undefined) record.label = label;
  records!.push(record);
  tokenSet!.add(token);
  persist();
  return token;
}

export function deleteSession(token: string): void {
  hydrate();
  if (!tokenSet!.delete(token)) return;
  records = records!.filter((s) => s.token !== token);
  persist();
}

export function isValidSession(token: string | undefined): boolean {
  if (!token) return false;
  hydrate();
  return tokenSet!.has(token);
}

/** Extract Bearer token from Authorization header. */
export function extractToken(authHeader: string | undefined): string | undefined {
  if (!authHeader?.startsWith('Bearer ')) return undefined;
  return authHeader.slice(7);
}

// ---------------------------------------------------------------------------
// tRPC context
// ---------------------------------------------------------------------------

/** Shared deps are set once at startup via setDeps(). */
let deps: AdminDeps | null = null;

export function setDeps(d: AdminDeps): void {
  deps = d;
}

export function createContext({ req, res }: CreateExpressContextOptions) {
  const token = extractToken(req.headers.authorization);
  if (!deps) throw new Error('Admin deps not initialized — setDeps() must be called before accepting requests');
  return {
    session: isValidSession(token) ? { token: token! } : null, // token is non-null when isValidSession returns true
    deps,
    // Express response — for the rare procedure that sets a cookie (e.g.
    // service.adminPageUrl's path-scoped page session).
    res,
  };
}

export type Context = ReturnType<typeof createContext>;

// ---------------------------------------------------------------------------
// tRPC instance
// ---------------------------------------------------------------------------

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

export const adminProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.session) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Admin session required' });
  }
  return next({ ctx: { ...ctx, session: ctx.session } });
});
