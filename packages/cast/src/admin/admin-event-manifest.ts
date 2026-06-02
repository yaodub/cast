/**
 * Admin event subscription manifest.
 *
 * Declarative source of truth for what the admin SSE + WebSocket connections
 * observe. Before Phase H both `admin/ws-events.ts` and `admin/events-stream.ts`
 * held identical hardcoded `AGENT_CHANNELS = ['__design', '__configure']`
 * arrays — the textbook "Class 2: scope-blind transport observers" symptom.
 * Either file could drift independently;
 * neither knew it should grow when user-channel events became part of the
 * admin UI's surface.
 *
 * After Phase H Step 5:
 *
 * - `agent.channels: '*'` says "every channel of every registered agent" —
 *   replaces the hardcoded console-only list. `ConsoleTransport.subscribe`
 *   gained wildcard support so a single subscription per agent catches every
 *   channel without iterating a closed enumeration. The admin UI now sees
 *   queue / lifecycle events on user channels (`default`, agent-configured),
 *   not just on the console infra channels.
 * - `managers.channels: ['default']` keeps the existing manager-console
 *   subscription model: each manager (DM / CM / SM) is registered on the bus
 *   at a single channel.
 *
 * Subscribers in `ws-events.ts` and `events-stream.ts` consume this manifest
 * rather than re-listing channels. If a future admin connection variant
 * appears (e.g. SharedWorker push), it consumes the same manifest.
 */

/** What an admin connection subscribes to within a single bus entity (agent
 *  or manager). `channels: '*'` is a wildcard accepted by
 *  `ConsoleTransport.subscribe` — the transport matches events on any channel
 *  for the given agent address. */
export interface AdminSubscriptionSpec {
  /** Discriminant. Drives which bus entities the spec applies to and how
   *  envelopes are labeled downstream:
   *  - `'agent'`: every entity whose bus metadata `type === 'agent'`.
   *  - `'manager'`: the explicit DM / CM / SM addresses listed by the
   *    consumer (manifest does not enumerate them — the consumer holds the
   *    descriptor imports). */
  readonly kind: 'agent' | 'manager';
  /** Channel filter. `'*'` matches every channel of the bound entity (added
   *  to `ConsoleTransport.subscribe` in Step 5). An explicit list matches
   *  only those names exactly. */
  readonly channels: readonly string[] | '*';
}

export const ADMIN_MANIFEST: {
  readonly agent: AdminSubscriptionSpec;
  readonly managers: AdminSubscriptionSpec;
} = {
  agent: {
    kind: 'agent',
    channels: '*',
  },
  managers: {
    kind: 'manager',
    channels: ['default'],
  },
};
