/**
 * Multiplexed admin event stream — single SSE for all admin chat events.
 *
 * Replaces (in time) the per-channel SSE routes in chat.ts and the three
 * manager-chat files. The browser opens ONE EventSource and receives events
 * for every (alias, channel) pair, eliminating per-origin SSE cap pressure
 * and letting unread badges work for inactive/closed agents.
 *
 * Envelope is delivered on a single SSE event named "message":
 *   { target: { kind: 'agent', alias, channel }, event, data }
 *   { target: { kind: 'manager', slug }, event, data }
 *   { target: { kind: 'lifecycle' }, event: 'agent_added'|'agent_removed', data }
 *
 * History is owned by the client (IndexedDB via web-ui/src/lib/db.ts).
 * No replay, no Last-Event-ID — packets sent during a connection drop are
 * lost on the wire; the client surfaces a "reconnecting" indicator.
 */
import type { Express, Request, Response } from 'express';

import { CONFIG_MANAGER_DESCRIPTOR } from '../console/config-manager/descriptor.js';
import { DESIGN_MANAGER_DESCRIPTOR } from '../console/design-manager/descriptor.js';
import { SECURITY_MANAGER_DESCRIPTOR } from '../console/security-manager/descriptor.js';
import type { Bus, BusLifecycleEvent } from '../gateway/bus.js';
import { logger } from '../logger.js';
import type { ConsoleSseEvent, ConsoleTransport } from '../transports/console.js';

import { ADMIN_MANIFEST } from './admin-event-manifest.js';
import { setSseHeaders, writeSseEvent } from './sse.js';
import { extractToken, isValidSession } from './trpc.js';

export interface AdminEventsDeps {
  bus: Bus;
  consoleTransport: ConsoleTransport;
}

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Module-level registry of active SSE connections so the shutdown path can
// send a final 'shutdown' event and end the response stream cleanly instead
// of letting `process.exit(0)` TCP-RST the client.
type ActiveStream = { res: Response; close: (reason: string) => void };
const activeStreams = new Set<ActiveStream>();

/** Send a final SSE event to every open admin stream and end the response. */
export function closeAllAdminEventsStreams(reason: string): void {
  for (const stream of activeStreams) {
    try { stream.close(reason); } catch { /* best-effort */ }
  }
  activeStreams.clear();
}

type ManagerSlug = 'design-manager' | 'config-manager' | 'security-manager';

const MANAGERS: ReadonlyArray<{ address: string; slug: ManagerSlug }> = [
  { address: DESIGN_MANAGER_DESCRIPTOR.address, slug: 'design-manager' },
  { address: CONFIG_MANAGER_DESCRIPTOR.address, slug: 'config-manager' },
  { address: SECURITY_MANAGER_DESCRIPTOR.address, slug: 'security-manager' },
];

type Envelope =
  | { target: { kind: 'agent'; alias: string; channel: string }; event: string; data: unknown }
  | { target: { kind: 'manager'; slug: ManagerSlug }; event: string; data: unknown }
  | { target: { kind: 'lifecycle' }; event: 'agent_added' | 'agent_removed'; data: { alias?: string; address: string } };

export function mountAdminEventsStream(app: Express, deps: AdminEventsDeps): void {
  app.get('/api/admin/events', (req, res) => {
    const ip = req.socket.remoteAddress;
    if (!ip || !LOCALHOST_ADDRS.has(ip)) {
      res.status(403).json({ error: 'Admin events stream is localhost-only' });
      return;
    }
    const token = extractToken(req.headers.authorization);
    if (!token || !isValidSession(token)) {
      res.status(401).json({ error: 'Admin session required' });
      return;
    }

    setSseHeaders(res);
    handleEventsConnection(req, res, deps);
  });

  logger.info('Admin events stream mounted at /api/admin/events');
}

function handleEventsConnection(req: Request, res: Response, deps: AdminEventsDeps): void {
  let closed = false;

  // Per-agent subs: address → { alias, disposers[] }. Map shape supports
  // targeted disposal on `deregistered` lifecycle events.
  const agentSubs = new Map<string, { alias: string; disposers: Array<() => void> }>();
  const managerDisposers: Array<() => void> = [];
  let lifecycleListener: ((event: BusLifecycleEvent) => void) | null = null;

  // Idempotent. Called from `req.on('close')` AND eagerly on EPIPE write
  // failure — restoring the parity the old per-channel routes had where
  // a dead socket immediately pruned its subscriber instead of waiting
  // for the (eventual) request-close event. Without eager cleanup the
  // ConsoleTransport's subscriber array can hold zombie push closures
  // for the gap between EPIPE and TCP close — under tab churn this
  // grows unboundedly.
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    if (lifecycleListener) {
      deps.bus.offLifecycle(lifecycleListener);
      lifecycleListener = null;
    }
    for (const d of managerDisposers) {
      try { d(); } catch (err) { logger.warn({ err }, 'manager sub dispose threw'); }
    }
    managerDisposers.length = 0;
    for (const address of Array.from(agentSubs.keys())) {
      const entry = agentSubs.get(address);
      if (!entry) continue;
      for (const d of entry.disposers) {
        try { d(); } catch (err) { logger.warn({ err, address }, 'agent sub dispose threw'); }
      }
      agentSubs.delete(address);
    }
  };

  const writeEnvelope = (env: Envelope): void => {
    if (closed) return;
    if (!writeSseEvent(res, 'message', env)) {
      // Socket dead (EPIPE etc). Tear down every subscriber synchronously
      // so a slow-firing `req.on('close')` doesn't leak fan-out targets.
      cleanup();
    }
  };

  const subscribeAgent = (address: string, alias: string): void => {
    if (agentSubs.has(address)) return; // dedupe — listener may have raced the snapshot
    const disposers: Array<() => void> = [];
    const channels = ADMIN_MANIFEST.agent.channels;
    const subscribeOnce = (channel: string | '*'): void => {
      const dispose = deps.consoleTransport.subscribe({
        agentAddress: address,
        channel,
        push: (e: ConsoleSseEvent) => {
          writeEnvelope({
            target: { kind: 'agent', alias, channel: e.channel },
            event: e.event,
            data: e.data,
          });
        },
      });
      disposers.push(dispose);
    };
    if (channels === '*') {
      subscribeOnce('*');
    } else {
      for (const channel of channels) subscribeOnce(channel);
    }
    agentSubs.set(address, { alias, disposers });
  };

  const unsubscribeAgent = (address: string): string | undefined => {
    const entry = agentSubs.get(address);
    if (!entry) return undefined;
    for (const d of entry.disposers) {
      try { d(); } catch (err) { logger.warn({ err, address }, 'agent sub dispose threw'); }
    }
    agentSubs.delete(address);
    return entry.alias;
  };

  // Manager subs — channel set comes from the manifest.
  const managerChannels = ADMIN_MANIFEST.managers.channels;
  for (const mgr of MANAGERS) {
    const subscribeManager = (channel: string | '*'): void => {
      const dispose = deps.consoleTransport.subscribe({
        agentAddress: mgr.address,
        channel,
        push: (e: ConsoleSseEvent) => {
          writeEnvelope({ target: { kind: 'manager', slug: mgr.slug }, event: e.event, data: e.data });
        },
      });
      managerDisposers.push(dispose);
    };
    if (managerChannels === '*') {
      subscribeManager('*');
    } else {
      for (const ch of managerChannels) subscribeManager(ch);
    }
  }

  // Lifecycle listener registered before the agent snapshot. Synchronous
  // code makes a true race impossible in Node, but the `subscribeAgent`
  // dedupe keeps this robust to any future reorder.
  lifecycleListener = (event: BusLifecycleEvent): void => {
    if (closed) return;
    if (event.type === 'registered') {
      const meta = deps.bus.getMetadata(event.address);
      if (!meta || meta.type !== 'agent') return;
      subscribeAgent(event.address, meta.label);
      writeEnvelope({
        target: { kind: 'lifecycle' },
        event: 'agent_added',
        data: { alias: meta.label, address: event.address },
      });
    } else if (event.type === 'deregistered') {
      const alias = unsubscribeAgent(event.address);
      writeEnvelope({
        target: { kind: 'lifecycle' },
        event: 'agent_removed',
        data: { alias, address: event.address },
      });
    }
    // 'updated' — metadata-only, no subscription topology change.
  };
  deps.bus.onLifecycle(lifecycleListener);

  // Snapshot current agents and subscribe.
  const initialAgents = deps.bus.listEntities({ type: 'agent' });
  for (const ent of initialAgents) {
    subscribeAgent(ent.id, ent.label);
  }

  // Ready handshake — gives the client the initial agent list so it can
  // hydrate its sidebar without waiting for tRPC agent.list to settle.
  writeSseEvent(res, 'ready', {
    agents: initialAgents.map((e) => ({ alias: e.label, address: e.id })),
    managers: MANAGERS.map((m) => m.slug),
  });

  // Register this connection so the shutdown path can close it gracefully.
  // The active-stream entry's `close` writes a final 'shutdown' event before
  // ending res — clients that subscribe to that event get a clean signal
  // instead of an unexplained TCP RST.
  const entry: ActiveStream = {
    res,
    close: (reason: string) => {
      if (closed) return;
      try {
        writeSseEvent(res, 'shutdown', { reason });
      } catch { /* socket may already be dead */ }
      cleanup();
      try { res.end(); } catch { /* ignore */ }
    },
  };
  activeStreams.add(entry);
  req.on('close', () => {
    activeStreams.delete(entry);
    cleanup();
  });
}
