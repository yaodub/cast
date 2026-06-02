/**
 * Multiplexed admin event WebSocket — single WS for all admin chat events.
 *
 * WebSocket counterpart of `events-stream.ts`. Same envelope shape, same
 * subscription model, same lifecycle semantics. Differences are limited to
 * transport plumbing:
 *
 *   - Auth: Bearer token in URL query string (`?token=`) instead of an
 *     Authorization header. Browsers can't set headers on WebSocket; the
 *     127.0.0.1 bind keeps the token from leaking to remote logs.
 *   - Wire framing: discriminated union (`type: 'envelope' | 'ready' | 'shutdown'`)
 *     over a single WS instead of per-event-name SSE frames. Worker validates
 *     with Zod at the boundary.
 *
 * Both handlers can run in parallel during the web-ui SharedWorker migration
 * (task 86); the SSE handler is removed after Phase 3 verifies WS works.
 */
import type { WebSocket, WebSocketServer } from 'ws';

import { CONFIG_MANAGER_DESCRIPTOR } from '../console/config-manager/descriptor.js';
import { DESIGN_MANAGER_DESCRIPTOR } from '../console/design-manager/descriptor.js';
import { SECURITY_MANAGER_DESCRIPTOR } from '../console/security-manager/descriptor.js';
import type { Bus, BusLifecycleEvent } from '../gateway/bus.js';
import { logger } from '../logger.js';
import type { ConsoleSseEvent, ConsoleTransport } from '../transports/console.js';

import { ADMIN_MANIFEST } from './admin-event-manifest.js';
import { isValidSession } from './trpc.js';

export interface AdminEventsWsDeps {
  bus: Bus;
  consoleTransport: ConsoleTransport;
}

const LOCALHOST_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

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

type WireFrame =
  | ({ type: 'envelope' } & Envelope)
  | { type: 'ready'; agents: Array<{ alias: string; address: string }>; managers: ManagerSlug[] }
  | { type: 'shutdown'; reason: string };

// SIDE EFFECT: Module-level registry of active WS connections so the shutdown
// path can send a final 'shutdown' frame and close cleanly instead of letting
// `process.exit(0)` TCP-RST the client. Mirrors `activeStreams` in events-stream.ts.
type ActiveSocket = { ws: WebSocket; close: (reason: string) => void };
const activeSockets = new Set<ActiveSocket>();

/** Send a final shutdown frame and close every open admin events WebSocket. */
export function closeAllAdminEventsWebSockets(reason: string): void {
  for (const sock of activeSockets) {
    try { sock.close(reason); } catch { /* best-effort */ }
  }
  activeSockets.clear();
}

/** Wire the admin events handler onto an existing WebSocketServer (noServer mode). */
export function setupAdminEventsWss(wss: WebSocketServer, deps: AdminEventsWsDeps): void {
  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    if (!ip || !LOCALHOST_ADDRS.has(ip)) {
      ws.close(1008, 'Admin events stream is localhost-only');
      return;
    }
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const token = url.searchParams.get('token') ?? undefined;
    if (!isValidSession(token)) {
      ws.close(1008, 'Admin session required');
      return;
    }
    handleConnection(ws, deps);
  });

  wss.on('error', (err) => {
    logger.error({ err }, 'Admin events WebSocket server error');
  });

  logger.info('Admin events WebSocket mounted at /api/admin/events');
}

function handleConnection(ws: WebSocket, deps: AdminEventsWsDeps): void {
  let closed = false;

  const agentSubs = new Map<string, { alias: string; disposers: Array<() => void> }>();
  const managerDisposers: Array<() => void> = [];
  let lifecycleListener: ((event: BusLifecycleEvent) => void) | null = null;

  // Idempotent. Called from `ws.on('close')` AND eagerly on send failure —
  // mirrors the EPIPE-eager-cleanup pattern from events-stream.ts so the
  // ConsoleTransport's subscriber array can't accumulate zombie push closures
  // during the gap between socket-write failure and ws.on('close') firing.
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

  const sendFrame = (frame: WireFrame): void => {
    if (closed) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch (err) {
      logger.debug({ err }, 'Admin events WS send failed — cleaning up subscriptions');
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
          sendFrame({
            type: 'envelope',
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

  // Manager subscriptions: each manager (DM / CM / SM) is registered on the
  // bus at a single channel — the manifest names it. If the manifest ever
  // grows beyond one channel per manager, this loop fans them out.
  const managerChannels = ADMIN_MANIFEST.managers.channels;
  for (const mgr of MANAGERS) {
    const pushForChannel = (channel: string | '*'): void => {
      const dispose = deps.consoleTransport.subscribe({
        agentAddress: mgr.address,
        channel,
        push: (e: ConsoleSseEvent) => {
          sendFrame({ type: 'envelope', target: { kind: 'manager', slug: mgr.slug }, event: e.event, data: e.data });
        },
      });
      managerDisposers.push(dispose);
    };
    if (managerChannels === '*') {
      pushForChannel('*');
    } else {
      for (const ch of managerChannels) pushForChannel(ch);
    }
  }

  // Lifecycle listener registered before the agent snapshot. Synchronous code
  // makes a true race impossible in Node, but `subscribeAgent` dedupe keeps
  // this robust to any future reorder.
  lifecycleListener = (event: BusLifecycleEvent): void => {
    if (closed) return;
    if (event.type === 'registered') {
      const meta = deps.bus.getMetadata(event.address);
      if (!meta || meta.type !== 'agent') return;
      subscribeAgent(event.address, meta.label);
      sendFrame({
        type: 'envelope',
        target: { kind: 'lifecycle' },
        event: 'agent_added',
        data: { alias: meta.label, address: event.address },
      });
    } else if (event.type === 'deregistered') {
      const alias = unsubscribeAgent(event.address);
      sendFrame({
        type: 'envelope',
        target: { kind: 'lifecycle' },
        event: 'agent_removed',
        data: { alias, address: event.address },
      });
    }
    // 'updated' — metadata-only, no subscription topology change.
  };
  deps.bus.onLifecycle(lifecycleListener);

  const initialAgents = deps.bus.listEntities({ type: 'agent' });
  for (const ent of initialAgents) {
    subscribeAgent(ent.id, ent.label);
  }

  // Ready handshake — gives the worker the initial agent list so it can hydrate
  // sidebar projections without waiting for the tRPC agent.list to settle.
  sendFrame({
    type: 'ready',
    agents: initialAgents.map((e) => ({ alias: e.label, address: e.id })),
    managers: MANAGERS.map((m) => m.slug),
  });

  // Register so the shutdown path can close gracefully — clients receive a
  // 'shutdown' frame instead of an unexplained TCP RST.
  const entry: ActiveSocket = {
    ws,
    close: (reason: string) => {
      if (closed) return;
      try {
        ws.send(JSON.stringify({ type: 'shutdown', reason } satisfies WireFrame));
      } catch { /* socket may already be dead */ }
      cleanup();
      try { ws.close(1001, 'Server shutting down'); } catch { /* ignore */ }
    },
  };
  activeSockets.add(entry);

  ws.on('close', () => {
    activeSockets.delete(entry);
    cleanup();
  });
  ws.on('error', (err) => {
    logger.debug({ err }, 'Admin events WS client error');
    activeSockets.delete(entry);
    cleanup();
  });
}
