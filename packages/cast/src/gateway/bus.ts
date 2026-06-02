/**
 * Bus — content-agnostic dispatcher with handler registration and address resolution.
 *
 * Handlers register for exact keys (e.g. "agent:alpha") or prefix matches
 * (e.g. "cli" matches "cli:main", "cli:user"). Everything routes through the bus.
 */

import type { BusAddress } from '../auth/address.js';
import { asBusAddress } from '../auth/address.js';
import type { AgentVerifyResult } from '../auth/identity.js';
import { logger } from '../logger.js';
import type { Evt } from '../types.js';

export interface BusHandler {
  handleMessage(from: string, to: string, payload: unknown): Promise<void>;
  handleEvent(evt: Evt): Promise<void>;
  /**
   * Optional: produce a per-identity wire-format projection of this handler.
   * Implemented by agent handlers (type:'agent'); returns null when the
   * identity has no inspect-bit on the agent. Handlers that don't represent
   * an agent (prefix routers, services) simply omit the method.
   *
   * Powers `Bus.listAccessibleAgents` — the cross-agent ACL projection API
   * that replaces the per-entity ACL loop previously inlined in
   * `WebTransport.buildAgentsPayload`.
   */
  projectForIdentity?(identityId: string): AgentSummary | null;
  /**
   * Optional: decide whether `evt` (originating from this handler) should be
   * delivered to `identityId`, returning the wire-frame `{alias, channel}` on
   * allow or `null` on deny. Implemented by agent handlers; same handler-hook
   * shape as `projectForIdentity`. Powers `Bus.projectEventForIdentity` —
   * keeps event-delivery ACL out of `WebTransport`.
   */
  projectEventForIdentity?(evt: Evt, identityId: string): EventDeliveryDecision | null;
}

/** Wire-frame metadata for an event delivery — returned by the per-handler
 *  ACL gate. `null` means deny. */
export type EventDeliveryDecision = { alias: string; channel: string };

/**
 * Wire-format entry for a single agent in the `agents` packet sent to
 * web-ui clients. Shape is preserved byte-for-byte across the state/event
 * consolidation refactor, validated against a captured baseline packet.
 */
export type AgentSummary = {
  alias: string;
  address: string;
  description?: string;
  channels: Array<{ name: string; bits: string }>;
};

/** Metadata stored alongside a bus entity registration. */
export interface BusEntityMetadata {
  label: string;
  type: 'agent' | 'service';
  description?: string;
  folderPath: string;
}

/** A bus entity = key + metadata. */
type BusEntity = { id: string } & BusEntityMetadata;

/**
 * Cause discriminant for `BusLifecycleEvent.updated`. Subscribers branch on
 * cause to decide whether they care — closes the "filter by re-reading
 * metadata" smell at the consumer side (web.ts pre-I.3). Adding a new cause
 * is one union arm here plus one emit-site update.
 */
export type BusUpdateCause = 'acl-changed' | 'mcp-changed' | 'description-changed';

/** Lifecycle event emitted when handlers are registered/unregistered/updated.
 *
 *  The `updated` variant carries a typed `cause` discriminant — observers
 *  consume the cause directly rather than re-deriving it from metadata.
 *  J.6d audit: no observer reads the `handler` field on `registered`, so it
 *  was dropped for symmetry with `updated` — observers that need it call
 *  `bus.resolve(address)` themselves; carrying it on the event leaks the
 *  internal `BusHandler` shape to every subscriber. */
export type BusLifecycleEvent =
  | { type: 'registered'; address: string }
  | { type: 'deregistered'; address: string; metadata?: BusEntityMetadata }
  | { type: 'updated'; address: string; cause: BusUpdateCause };

export type BusLifecycleListener = (event: BusLifecycleEvent) => void;

/**
 * Optional hook fired when `routeMessage` finds no handler for the destination.
 * Wired by `index.ts` to write a structured row to the host activity log so
 * stranded traffic is visible in the admin UI. The bus itself stays dumb —
 * silent-drop semantics are preserved (we just observe the drop).
 */
type UnhandledLogger = (from: string, to: string, payload: unknown) => void;

export class Bus {
  private exact = new Map<string, BusHandler>();
  private prefixes: Array<{ prefix: string; handler: BusHandler }> = [];
  private lifecycleListeners: BusLifecycleListener[] = [];
  private metadata = new Map<string, BusEntityMetadata>();
  private unhandledLogger?: UnhandledLogger;

  constructor() {}

  /** Subscribe to unrouted-packet events. Called once at startup. */
  setUnhandledLogger(fn: UnhandledLogger): void {
    this.unhandledLogger = fn;
  }

  /** Subscribe to handler lifecycle events. */
  onLifecycle(listener: BusLifecycleListener): void {
    this.lifecycleListeners.push(listener);
  }

  /** Unsubscribe a previously registered lifecycle listener. */
  offLifecycle(listener: BusLifecycleListener): void {
    this.lifecycleListeners = this.lifecycleListeners.filter((l) => l !== listener);
  }

  private emitLifecycle(event: BusLifecycleEvent): void {
    for (const listener of this.lifecycleListeners) {
      try {
        listener(event);
      } catch (err) {
        logger.error({ err, eventType: event.type, address: event.address }, 'Bus lifecycle listener threw');
      }
    }
  }

  /**
   * Register a handler for an exact key or prefix, with optional entity metadata.
   *
   * For `exact` mode the caller is expected to pass the canonical address as
   * `key` (agent orchestrator passes `agentAuth.address`; services pass their
   * own canonical). The bus does not re-derive identity — that's the IdP's job.
   */
  register(
    key: string,
    handler: BusHandler,
    mode: 'exact' | 'prefix',
    metadata?: BusEntityMetadata & { agentAuth?: AgentVerifyResult },
  ): void {
    if (mode === 'exact') {
      if (metadata?.agentAuth && !metadata.agentAuth.verified) {
        throw new Error(`Agent registration rejected — pubkey mismatch (${key})`);
      }
      this.exact.set(key, handler);
      if (metadata) this.metadata.set(key, metadata);
      this.emitLifecycle({ type: 'registered', address: key });
    } else {
      if (!this.prefixes.some((p) => p.prefix === key)) {
        this.prefixes.push({ prefix: key, handler });
      }
    }
  }

  /** Unregister an exact key or prefix. */
  unregister(key: string): void {
    const metadata = this.metadata.get(key);
    this.exact.delete(key);
    this.metadata.delete(key);
    this.prefixes = this.prefixes.filter((p) => p.prefix !== key);
    this.emitLifecycle({ type: 'deregistered', address: key, metadata });
  }

  /**
   * Notify listeners that a handler's state has changed. The `cause` is a
   * typed discriminant subscribers branch on — see `BusUpdateCause`. The
   * bus stays content-agnostic about WHAT the change means; emitters declare
   * which named cause fired so subscribers can filter without re-reading
   * metadata or guessing.
   */
  update(key: string, cause: BusUpdateCause): void {
    if (!this.exact.has(key)) return;
    this.emitLifecycle({ type: 'updated', address: key, cause });
  }

  /**
   * Merge new fields onto a registered entity's metadata in place, then notify
   * listeners. Unlike `update`, this mutates the stored metadata — used for
   * edits that must reach metadata readers (`listEntities`, `getMetadata`,
   * `resolveByLabel`) without a full unregister/re-register cycle, e.g. a
   * description change from the Design console. No-op if the key isn't an
   * exact registration. `label`/`type`/`folderPath` are identity-bearing and
   * not mergeable here — only soft fields like `description` should be passed.
   */
  updateMetadata(key: string, partial: Partial<BusEntityMetadata>, cause: BusUpdateCause): void {
    const existing = this.metadata.get(key);
    if (!existing) return;
    // No-op when the merge changes nothing — dedupes redundant emits, e.g. a
    // file watcher re-firing the same description an in-band caller just applied.
    const changed = (Object.keys(partial) as (keyof BusEntityMetadata)[]).some(
      (k) => existing[k] !== partial[k],
    );
    if (!changed) return;
    this.metadata.set(key, { ...existing, ...partial });
    this.emitLifecycle({ type: 'updated', address: key, cause });
  }

  /**
   * Resolve an address to a handler.
   *
   * Dispatch-only semantics: exact match on canonical address first, then prefix
   * match on the part before ':'. For compound resolved addresses (`identity/handle`),
   * also tries the identity prefix.
   *
   * **No alias fallback here.** Callers that need alias-to-canonical resolution
   * must use `resolveAddress()` (or `resolveByLabel()` for strict alias lookup)
   * at their own layer — the bus does not silently translate.
   *
   * Resolver vocabulary:
   * - `resolve(to)`           — dispatch only; exact + prefix match
   * - `resolveByLabel(alias)` — alias-only lookup; returns canonical key
   * - `resolveAddress(raw)`   — boundary resolver; exact then resolveByLabel fallback
   */
  resolve(to: string): BusHandler | undefined {
    const exact = this.exact.get(to);
    if (exact) return exact;

    const colonIdx = to.indexOf(':');
    if (colonIdx === -1) return undefined;
    const prefix = to.slice(0, colonIdx);
    const byPrefix = this.prefixes.find((p) => p.prefix === prefix)?.handler;
    if (byPrefix) return byPrefix;

    // Compound address: try identity part (before '/') as prefix
    const slashIdx = prefix.indexOf('/');
    if (slashIdx !== -1) {
      const identityPrefix = prefix.slice(0, slashIdx);
      return this.prefixes.find((p) => p.prefix === identityPrefix)?.handler;
    }

    return undefined;
  }

  /** Resolve handler for `to` and call handleMessage. */
  async routeMessage(from: string, to: string, payload: unknown): Promise<void> {
    const handler = this.resolve(to);
    if (handler) {
      await handler.handleMessage(from, to, payload);
      return;
    }
    // Missing handler — invoke optional observer for the host activity log.
    // Errors in the observer are swallowed so a bad logger never affects routing.
    if (this.unhandledLogger) {
      try { this.unhandledLogger(from, to, payload); } catch (err) {
        logger.error({ err, from, to }, 'Bus unhandled-logger threw');
      }
    }
  }

  /** Resolve handler for `to` and call handleEvent. */
  async routeEvent(evt: Evt): Promise<void> {
    const handler = this.resolve(evt.to);
    if (handler) await handler.handleEvent(evt);
  }

  /** Exact keys (for iteration). */
  keys(): string[] {
    return [...this.exact.keys()];
  }

  /** Exact entries (for iteration). */
  handlers(): IterableIterator<[string, BusHandler]> {
    return this.exact.entries();
  }

  /** List entities with metadata, optionally filtered by type. */
  listEntities(filter?: { type?: string }): BusEntity[] {
    const result: BusEntity[] = [];
    for (const [id, meta] of this.metadata) {
      if (filter?.type && meta.type !== filter.type) continue;
      result.push({ id, ...meta });
    }
    return result;
  }

  /**
   * Cross-agent ACL projection for a given identity. Iterates registered
   * agents, asks each handler for its per-identity view via the optional
   * `projectForIdentity` hook, and returns the non-null results.
   *
   * Wire-format-stable: the returned shape is what `WebTransport` serializes
   * into the `agents` packet's `list` field. The Bus itself stays
   * content-agnostic — it does not load ACL files or know about identities;
   * each handler enforces its own policy.
   */
  listAccessibleAgents(identityId: string): AgentSummary[] {
    const result: AgentSummary[] = [];
    for (const [id, meta] of this.metadata) {
      if (meta.type !== 'agent') continue;
      const handler = this.exact.get(id);
      if (!handler?.projectForIdentity) continue;
      const summary = handler.projectForIdentity(identityId);
      if (summary) result.push(summary);
    }
    return result;
  }

  /**
   * Per-identity ACL gate for outbound events. Looks up the handler at
   * `evt.from` and delegates to its optional `projectEventForIdentity`
   * hook. Returns `null` when the source isn't an agent entity or the
   * handler doesn't grant the identity inspect rights on the event's
   * channel.
   *
   * Predicate — not a dispatcher. Mirrors `listAccessibleAgents`: the bus
   * exposes the projection seam, handlers (AgentManager) own the policy,
   * transports get back a yes/no wire-frame decision without reading any
   * ACL state themselves.
   */
  projectEventForIdentity(evt: Evt, identityId: string): EventDeliveryDecision | null {
    const meta = this.metadata.get(evt.from);
    if (!meta || meta.type !== 'agent') return null;
    const handler = this.exact.get(evt.from);
    return handler?.projectEventForIdentity?.(evt, identityId) ?? null;
  }

  /** Find an entity by label, return its registered key (e.g. "smith@d9c1e2"). */
  resolveByLabel(label: string): BusAddress | undefined {
    for (const [id, meta] of this.metadata) {
      if (meta.label === label) return asBusAddress(id);
    }
    return undefined;
  }

  /** Get entity metadata for a registered key. */
  getMetadata(key: string): BusEntityMetadata | undefined {
    return this.metadata.get(key);
  }

  /** Resolve an address to its canonical registered key. Returns undefined if not found. */
  resolveAddress(address: string): BusAddress | undefined {
    if (this.exact.has(address)) return asBusAddress(address);
    // Bare name or alias@idp → resolve via label
    const label = address.includes('@') ? address.slice(0, address.indexOf('@')) : address;
    return this.resolveByLabel(label);
  }
}
