/**
 * FileWatchService — per-agent watch-and-deliver service for feed file watches.
 *
 * Owns:
 * - `state/file-watches.json` registry (per-conv-key entries with cursor + routing).
 * - One chokidar `FSWatcher` per host path (one watcher fans out to N conv-keys).
 * - Subscription to `feedAppendEvents` from `lib/feed-format.ts` for self-write
 *   cursor-advance — synchronous in the same tick as `appendFeedRow`, before
 *   chokidar's stability window completes.
 *
 * Why raw chokidar instead of `lib/file-watcher.ts::FileWatcher`:
 * - FileWatcher's `mkdirSync` doesn't apply to file paths.
 * - FileWatcher caches content for config hot-reload; feeds grow fast and would
 *   balloon the cache.
 * - FileWatcher dedups by content equality; we want every append to fire.
 *
 * Delivery: each fire calls the injected `route(agentId, agentId, body, routing,
 * ..., 'watch', attrs)`. The watch service does NOT touch runners directly —
 * it goes through the same chokepoint scheduler / lifecycle / service IPC use,
 * which exercises Phase 0's `<cast:watch ...>` wrapping in `runner.deliver()`.
 */
import fs from 'fs';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';
import { z } from 'zod';

import type { ResourceEntry } from '@getcast/agent-schema/v1';

import { agentPath, resolveCapabilities } from '../config.js';
import { createPathResolver } from '../lib/agent-paths.js';
import { escapeXml } from '../lib/format.js';
import {
  feedAppendEvents,
  readFeedRows,
  validateFeedIntegrity,
  type FeedAppendEvent,
  type FeedRow,
} from '../lib/feed-format.js';
import { writeAtomic } from '../lib/utils.js';
import { logger } from '../logger.js';
import type { Host, RouteResult } from '../types.js';
import { readAgentConfig } from '../container/container-runner.js';

import type { Routing } from './agent-bus-payload.js';
import type { LogEventFn } from './agent-db.js';
import type { DeliverKind } from './conversation-runner.js';

const DEFAULT_MAX_PREVIEW_TOKENS = 1000;

// ---------------------------------------------------------------------------
// Persisted shape
// ---------------------------------------------------------------------------

const WatchEntrySchema = z.object({
  /** Container-side path the agent registered (e.g. `/memory/letter.jsonl`). */
  path: z.string(),
  /** Last id this conv-key has observed (0 = nothing seen yet; first fire delivers all current rows). */
  lastSeenId: z.number().int().min(0),
  /** Routing — captured at registration so delivery doesn't parse the convKey. */
  channel: z.string(),
  participant: z.string(),
  qualifier: z.string().optional(),
  /** ISO timestamp of registration. */
  registered: z.string(),
  /** Optional ISO expiry — Phase 5 prunes; Phase 3 stores forward-compat. */
  expiresAt: z.string().optional(),
});
type PersistedWatchEntry = z.infer<typeof WatchEntrySchema>;

const RegistrySchema = z.record(z.string(), z.array(WatchEntrySchema));
type PersistedRegistry = z.infer<typeof RegistrySchema>;

/** In-memory entry — adds resolved hostPath (NOT serialized; re-derived at boot). */
export interface WatchEntry extends PersistedWatchEntry {
  hostPath: string;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RegisterResult =
  | { ok: true; entry: WatchEntry }
  | { ok: false; reason: string };

/** The route() callback shape — matches AgentManager.route. */
export type RouteFn = (
  address: string,
  senderId: string,
  text: string,
  routing?: Routing,
  rawText?: string,
  declaredName?: string,
  attachments?: undefined,
  kind?: DeliverKind,
  attrs?: Record<string, string>,
) => Promise<RouteResult>;

export interface FileWatchServiceOpts {
  folder: string;
  host: Host;
  agentId: string;
  route: RouteFn;
  onLogEvent?: LogEventFn;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class FileWatchService {
  private readonly folder: string;
  private readonly host: Host;
  private readonly agentId: string;
  private readonly route: RouteFn;
  private readonly logEvent: LogEventFn;
  private readonly registryPath: string;

  /** Per-conv-key entries — serialized to disk. */
  private byConvKey = new Map<string, WatchEntry[]>();
  /** Derived index: which conv-keys subscribe to a given host path. Rebuilt at boot. */
  private byHostPath = new Map<string, Set<string>>();
  /** One chokidar instance per host path. */
  private chokidarPerPath = new Map<string, FSWatcher>();

  private appendListener: ((evt: FeedAppendEvent) => void) | null = null;
  private started = false;

  constructor(opts: FileWatchServiceOpts) {
    this.folder = opts.folder;
    this.host = opts.host;
    this.agentId = opts.agentId;
    this.route = opts.route;
    this.logEvent = opts.onLogEvent ?? (() => {});
    this.registryPath = agentPath(opts.folder, 'state', 'file-watches.json');
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.load();

    // Subscribe BEFORE arming chokidar so a same-tick append after start()
    // gets cursor-advanced before the chokidar fire arrives.
    this.appendListener = (evt) => this.onAppend(evt);
    feedAppendEvents.on('append', this.appendListener);

    await Promise.all([...this.byHostPath.keys()].map((p) => this.armChokidar(p)));

    const totalEntries = [...this.byConvKey.values()].reduce((acc, arr) => acc + arr.length, 0);
    if (totalEntries > 0) {
      logger.info(
        { agentFolder: this.folder, watches: totalEntries, paths: this.byHostPath.size },
        'FileWatchService re-armed',
      );
      this.logEvent('info', 'file-watch', 'rearmed', `Re-armed ${totalEntries} watches across ${this.byHostPath.size} paths`, {
        context: { watches: totalEntries, paths: this.byHostPath.size },
      });
    }
  }

  async shutdown(): Promise<void> {
    if (!this.started) return;
    this.started = false;

    if (this.appendListener) {
      feedAppendEvents.off('append', this.appendListener);
      this.appendListener = null;
    }

    const closers = [...this.chokidarPerPath.values()].map((w) =>
      w.close().catch((err) => logger.warn({ err }, 'FileWatchService: error closing chokidar')),
    );
    await Promise.all(closers);
    this.chokidarPerPath.clear();
    this.byHostPath.clear();
    this.byConvKey.clear();
  }

  // -------------------------------------------------------------------------
  // Registration API (Phase 4 wires MCP tools to these; Phase 3 tests use directly)
  // -------------------------------------------------------------------------

  /**
   * Register a watch. Resolves the path via the Phase 1 resolver; rejects
   * ENOENT/symlink/traversal/no-mount per the path-must-exist contract.
   *
   * Async: when arming a fresh host path, awaits chokidar's `ready` event so
   * subsequent file changes are guaranteed observable. Same-path re-registration
   * (no new chokidar arm) returns immediately.
   */
  async register(
    convKey: string,
    args: {
      path: string;
      channel: string;
      participant: string;
      qualifier?: string;
      expiresAt?: string;
    },
  ): Promise<RegisterResult> {
    const resolver = this.buildResolver(convKey);
    const resolved = resolver.resolveReadable(args.path);
    if (!resolved.ok) {
      switch (resolved.kind) {
        case 'invalid-path':
          return { ok: false, reason: `Invalid path: ${resolved.message}` };
        case 'no-mount':
          return { ok: false, reason: `No watchable mount matches ${resolved.containerPath}.` };
        case 'enoent':
          return { ok: false, reason: `Path does not exist; create it first via \`file__append_feed\`.` };
        case 'symlink':
          return { ok: false, reason: `Path is a symlink (rejected for security): ${resolved.hostPath}.` };
        case 'traversal':
          return { ok: false, reason: `Path escapes the mount root (rejected for security).` };
        case 'wrong-mode':
          return { ok: false, reason: `Internal error: read resolver returned wrong-mode.` };
      }
    }

    const existing = this.byConvKey.get(convKey) ?? [];
    if (existing.some((e) => e.path === args.path)) {
      return { ok: false, reason: `Watch already exists for path ${args.path}.` };
    }

    // Anchor lastSeenId to the file's current end so registration doesn't
    // flood the agent with all historical rows on first fire.
    const integrity = validateFeedIntegrity(resolved.hostPath);
    const lastSeenId = integrity.ok ? integrity.lastId : 0;

    const entry: WatchEntry = {
      path: args.path,
      hostPath: resolved.hostPath,
      lastSeenId,
      channel: args.channel,
      participant: args.participant,
      qualifier: args.qualifier,
      registered: new Date().toISOString(),
      expiresAt: args.expiresAt,
    };

    existing.push(entry);
    this.byConvKey.set(convKey, existing);

    let convKeysForPath = this.byHostPath.get(resolved.hostPath);
    let armPromise: Promise<void> | null = null;
    if (!convKeysForPath) {
      convKeysForPath = new Set();
      this.byHostPath.set(resolved.hostPath, convKeysForPath);
      armPromise = this.armChokidar(resolved.hostPath);
    }
    convKeysForPath.add(convKey);

    this.persist();
    if (armPromise) await armPromise;
    return { ok: true, entry };
  }

  /** Unregister the watch on `path` for `convKey`. No-op if not registered. */
  unregister(convKey: string, path: string): void {
    const entries = this.byConvKey.get(convKey);
    if (!entries) return;
    const idx = entries.findIndex((e) => e.path === path);
    if (idx === -1) return;
    const [removed] = entries.splice(idx, 1);
    if (entries.length === 0) this.byConvKey.delete(convKey);

    const subs = this.byHostPath.get(removed!.hostPath);
    if (subs) {
      // Only release the per-path subscription if no other entry under the
      // same convKey still watches the same hostPath.
      const stillSubscribed = (this.byConvKey.get(convKey) ?? []).some((e) => e.hostPath === removed!.hostPath);
      if (!stillSubscribed) subs.delete(convKey);
      if (subs.size === 0) {
        this.byHostPath.delete(removed!.hostPath);
        this.disarmChokidar(removed!.hostPath);
      }
    }
    this.persist();
  }

  /** List watches scoped to a single conv-key (Phase 4 tool consumer). */
  list(convKey: string): WatchEntry[] {
    return [...(this.byConvKey.get(convKey) ?? [])];
  }

  // -------------------------------------------------------------------------
  // Internal — persistence
  // -------------------------------------------------------------------------

  /**
   * Load registry from disk and re-resolve every entry's host path. Drops
   * entries whose path no longer resolves (mount changed, file deleted, etc.).
   */
  private load(): void {
    let raw: string;
    try {
      raw = fs.readFileSync(this.registryPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ err, path: this.registryPath }, 'FileWatchService: read failed, starting empty');
      }
      return;
    }

    let parsed: PersistedRegistry;
    try {
      const json = JSON.parse(raw);
      const result = RegistrySchema.safeParse(json);
      if (!result.success) {
        logger.warn({ error: result.error.message }, 'FileWatchService: registry parse failed, starting empty');
        return;
      }
      parsed = result.data;
    } catch (err) {
      logger.warn({ err }, 'FileWatchService: registry JSON parse failed, starting empty');
      return;
    }

    const nowMs = Date.now();
    let dropped = 0;
    let expired = 0;
    for (const [convKey, entries] of Object.entries(parsed)) {
      const resolver = this.buildResolver(convKey);
      const live: WatchEntry[] = [];
      for (const e of entries) {
        if (e.expiresAt && Date.parse(e.expiresAt) <= nowMs) {
          expired++;
          continue;
        }
        const r = resolver.resolveReadable(e.path);
        if (!r.ok) {
          dropped++;
          logger.warn(
            { agentFolder: this.folder, convKey, path: e.path, kind: r.kind },
            'FileWatchService: dropping dead watch entry',
          );
          continue;
        }
        const entry: WatchEntry = { ...e, hostPath: r.hostPath };
        live.push(entry);
        let subs = this.byHostPath.get(r.hostPath);
        if (!subs) {
          subs = new Set();
          this.byHostPath.set(r.hostPath, subs);
        }
        subs.add(convKey);
      }
      if (live.length > 0) this.byConvKey.set(convKey, live);
    }

    if (dropped > 0) {
      this.logEvent('warn', 'file-watch', 'dead_entries_dropped', `Dropped ${dropped} dead watch entries at boot`, {
        context: { dropped },
      });
    }
    if (expired > 0) {
      this.logEvent('info', 'file-watch', 'expired_entries_pruned', `Pruned ${expired} expired watch entries at boot`, {
        context: { expired },
      });
    }

    if (dropped > 0 || expired > 0 || this.byConvKey.size !== Object.keys(parsed).length) {
      // Re-persist to clean the registry on disk after drops/prunes.
      this.persist();
    }
  }

  private persist(): void {
    const snapshot: PersistedRegistry = {};
    for (const [convKey, entries] of this.byConvKey) {
      // Strip in-memory `hostPath` — it's derived at load time.
      snapshot[convKey] = entries.map((e) => {
        const out: PersistedWatchEntry = {
          path: e.path,
          lastSeenId: e.lastSeenId,
          channel: e.channel,
          participant: e.participant,
          registered: e.registered,
        };
        if (e.qualifier !== undefined) out.qualifier = e.qualifier;
        if (e.expiresAt !== undefined) out.expiresAt = e.expiresAt;
        return out;
      });
    }
    try {
      writeAtomic(this.registryPath, JSON.stringify(snapshot, null, 2));
    } catch (err) {
      logger.error({ err, path: this.registryPath }, 'FileWatchService: persist failed');
      this.logEvent('error', 'file-watch', 'persist_failed', `Failed to persist file-watches.json: ${String(err)}`, {
        context: { error: String(err) },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Internal — events
  // -------------------------------------------------------------------------

  /**
   * Self-write suppression: when the same conv-key that's watching a path
   * appends to it, advance its cursor BEFORE chokidar fires. Other conv-keys
   * watching the same path still have stale cursors and fire normally.
   *
   * Synchronous: `appendFeedRow` emits in the same tick as the OS-level write,
   * and chokidar's `awaitWriteFinish` (~50ms) gives more headroom.
   */
  private onAppend(evt: FeedAppendEvent): void {
    const entries = this.byConvKey.get(evt.convKey);
    if (!entries) return;
    let mutated = false;
    for (const entry of entries) {
      if (entry.hostPath !== evt.hostPath) continue;
      if (evt.id > entry.lastSeenId) {
        entry.lastSeenId = evt.id;
        mutated = true;
      }
    }
    if (mutated) this.persist();
  }

  /**
   * chokidar fired on `hostPath`. Fan out to every conv-key subscribed; for
   * each, run fire-assembly. If `since === through` (writer caught up via
   * cursor-advance — self-write suppression), skip the fire entirely.
   */
  private onChokidarFire(hostPath: string): void {
    const convKeys = this.byHostPath.get(hostPath);
    if (!convKeys || convKeys.size === 0) return;

    for (const convKey of convKeys) {
      const entries = this.byConvKey.get(convKey);
      if (!entries) continue;
      for (const entry of entries) {
        if (entry.hostPath !== hostPath) continue;
        this.deliverFire(convKey, entry).catch((err) => {
          logger.error({ err, convKey, path: entry.path }, 'FileWatchService: deliverFire failed');
          this.logEvent('error', 'file-watch', 'deliver_failed', `Watch fire delivery failed: ${entry.path}`, {
            context: { convKey, path: entry.path, error: String(err) },
          });
        });
      }
    }
  }

  /** Fire-assembly + route. Updates `lastSeenId` on success, persists. */
  private async deliverFire(convKey: string, entry: WatchEntry): Promise<void> {
    // TTL prune at fire-tick: silently unregister and skip the fire. Agent
    // owns expiresIn at registration; no notice surfaced to the runner.
    if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) {
      this.unregister(convKey, entry.path);
      this.logEvent('info', 'file-watch', 'expired', `Watch on ${entry.path} expired and pruned`, {
        context: { convKey, path: entry.path },
      });
      return;
    }

    const rows = readFeedRows(entry.hostPath);
    if (!rows.ok) {
      // Corrupt — emit an error fire with no body. Agent learns of the issue
      // via the same channel as a normal fire.
      const attrs: Record<string, string> = {
        path: entry.path,
        error: `feed-corrupt-at-row-${rows.rowOffset}`,
      };
      await this.routeFire(entry, '', attrs);
      // Don't advance lastSeenId on corruption — the agent can't make progress
      // until the operator repairs the feed.
      return;
    }

    // Restore re-anchor: registry's lastSeenId may exceed the feed's highest id
    // when a live-tar backup captured the registry after subsequent feed
    // truncation/restore. Reset cursor to the feed end and emit a one-time
    // no-body notice so the agent learns of the discontinuity. The condition
    // self-clears (lastSeenId === highestId after reset), so subsequent fires
    // proceed normally.
    const highestId = rows.rows.at(-1)?.id ?? 0;
    if (entry.lastSeenId > highestId) {
      await this.routeFire(entry, '', {
        path: entry.path,
        note: 'cursor-reanchored-after-restore',
      });
      entry.lastSeenId = highestId;
      this.persist();
      return;
    }

    const newRows = rows.rows.filter((r) => r.id > entry.lastSeenId);
    if (newRows.length === 0) {
      // Self-write suppression: cursor already at or past current end.
      return;
    }

    const since = entry.lastSeenId;
    const through = newRows.at(-1)!.id;
    const body = this.assembleBody(newRows);

    const attrs: Record<string, string> = {
      path: entry.path,
      since: String(since),
      through: String(through),
    };

    await this.routeFire(entry, body, attrs);
    entry.lastSeenId = through;
    this.persist();
  }

  /**
   * Build the body of a `<cast:watch>` fire. Each row is XML-escaped JSON,
   * one per line, joined by `\n`. Body is omitted (returns empty string) when
   * its size estimate exceeds `fileWatch.maxPreviewTokens` — agent re-reads
   * on receipt.
   */
  private assembleBody(rows: FeedRow[]): string {
    const lines = rows.map((r) => {
      const obj: Record<string, unknown> = { id: r.id, data: r.data };
      if (r.meta !== undefined) obj.meta = r.meta;
      return JSON.stringify(obj);
    });
    const raw = lines.join('\n');

    // Token estimate: ~4 chars/token (rough industry proxy). Read-through
    // for the threshold so Configure-time edits land without restart.
    const cfg = readAgentConfig(this.folder).fileWatch;
    const maxTokens = cfg?.maxPreviewTokens ?? DEFAULT_MAX_PREVIEW_TOKENS;
    const estimatedTokens = Math.ceil(raw.length / 4);
    if (estimatedTokens > maxTokens) return '';

    return escapeXml(raw);
  }

  private async routeFire(entry: WatchEntry, body: string, attrs: Record<string, string>): Promise<void> {
    const routing: Routing = {
      channel: entry.channel,
      targetParticipant: entry.participant,
      qualifier: entry.qualifier,
    };
    await this.route(
      this.agentId,
      this.agentId,
      body,
      routing,
      undefined,
      undefined,
      undefined,
      'watch',
      attrs,
    );
  }

  // -------------------------------------------------------------------------
  // Internal — chokidar
  // -------------------------------------------------------------------------

  private armChokidar(hostPath: string): Promise<void> {
    if (this.chokidarPerPath.has(hostPath)) return Promise.resolve();
    const watcher = chokidarWatch(hostPath, {
      persistent: true,
      ignoreInitial: true,
      // Polling is more reliable across environments (FSEvents can be flaky in
      // sandboxed test runners). 100ms cadence is plenty for feed-coordination
      // semantics; chokidar's awaitWriteFinish still smooths multi-write bursts.
      usePolling: true,
      interval: 100,
      // Mirror lib/file-watcher.ts's stability window — protects against
      // FSEvents delivering 'change' before the kernel flushes.
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 10 },
    });
    const fire = () => this.onChokidarFire(hostPath);
    watcher.on('add', fire);
    watcher.on('change', fire);
    watcher.on('unlink', fire);
    watcher.on('error', (err) => {
      logger.warn({ err, hostPath }, 'FileWatchService: chokidar error');
    });
    this.chokidarPerPath.set(hostPath, watcher);
    return new Promise<void>((resolve) => {
      watcher.on('ready', () => resolve());
    });
  }

  private disarmChokidar(hostPath: string): void {
    const w = this.chokidarPerPath.get(hostPath);
    if (!w) return;
    w.close().catch((err) => logger.warn({ err, hostPath }, 'FileWatchService: error closing chokidar'));
    this.chokidarPerPath.delete(hostPath);
  }

  // -------------------------------------------------------------------------
  // Internal — resolver factory
  // -------------------------------------------------------------------------

  private buildResolver(convKey: string) {
    const resolved = resolveCapabilities(this.folder);
    const mountResources: Record<string, ResourceEntry> = {};
    for (const [name, res] of Object.entries(resolved.resources)) {
      if (res.path) mountResources[name] = { path: res.path, access: res.access };
    }
    return createPathResolver(this.host, convKey, mountResources);
  }
}
