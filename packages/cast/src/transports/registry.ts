/**
 * Transport registry — module-level registration + generic load/reconcile.
 *
 * Mirrors `extensions/registry.ts` for transports. Each routed transport
 * registers itself at server startup; this module then walks `routes.json`,
 * validates each entry against the registered transport's `configSchema`,
 * builds a `TransportContext`, and constructs the instance.
 *
 * The previous `loadRoutedTransports()` and `reconcileRoutedTransports()`
 * lived inline in `index.ts` with a hard-coded `routedNames = new Set([...])`
 * and one bespoke wiring block per transport. Both are now generic.
 */
import path from 'path';
import { z } from 'zod';

import type { Bus } from '../gateway/bus.js';
import type { MessageGateway } from '../gateway/message-gateway.js';
import type { SystemCommandDispatcher } from '../commands/index.js';
import { CONFIG_DIR } from '../config.js';
import { readParsed } from '../lib/config-reader.js';
import { logger } from '../logger.js';

import type { Transport, TransportContext, TransportDefinition } from './schema.js';

// ---------------------------------------------------------------------------
// Reserved prefixes
// ---------------------------------------------------------------------------

/**
 * Address-prefix namespaces no routed transport may claim. Two categories:
 *
 * - **System bus prefixes** (`u`, `local`) — gateway routing, not transport-owned.
 * - **Bespoke transport prefixes** (`cli`, `web`, `admin`, `console`) — owned by
 *   always-instantiated bespoke transports that don't go through this registry.
 *   The `console:` namespace also hosts virtual agents (`console:config-manager`).
 *
 * `cast:` and `a:`/`ext:` are agent / system addressing namespaces in
 * `auth/address.ts`. Belt-and-braces inclusion to keep transports from
 * silently shadowing them.
 *
 * If a bespoke transport is ever migrated to `defineTransport`, drop its
 * prefix from this set on the same commit.
 */
const RESERVED_PREFIXES = new Set([
  'u', 'a', 'ext', 'cast',           // system addressing
  'local', 'cli', 'web', 'admin', 'console', // bespoke transport / virtual-agent namespaces
]);

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const registry = new Map<string, TransportDefinition<unknown>>();
const prefixesInUse = new Set<string>();

/** Register a routed transport definition. Called explicitly at startup, mirrors `registerExtension`. */
export function registerTransport<TConfig>(def: TransportDefinition<TConfig>): void {
  if (registry.has(def.name)) {
    throw new Error(`Transport "${def.name}" is already registered`);
  }
  if (RESERVED_PREFIXES.has(def.addressPrefix)) {
    throw new Error(
      `Transport "${def.name}" cannot use reserved address prefix "${def.addressPrefix}:" — reserved for system / bespoke-transport use`,
    );
  }
  if (prefixesInUse.has(def.addressPrefix)) {
    throw new Error(
      `Transport "${def.name}" cannot claim address prefix "${def.addressPrefix}:" — already owned by another registered transport`,
    );
  }
  // Up-cast to the unknown-erased registry shape — the parse-then-create
  // dance below preserves type-safety per call.
  registry.set(def.name, def as TransportDefinition<unknown>);
  prefixesInUse.add(def.addressPrefix);
}

/** Get all registered routed-transport definitions. */
export function getRegisteredTransports(): ReadonlyMap<string, TransportDefinition<unknown>> {
  return registry;
}

/** Get the address-prefix list owned by all registered routed transports. */
export function getRegisteredAddressPrefixes(): string[] {
  return Array.from(registry.values(), (def) => def.addressPrefix);
}

// ---------------------------------------------------------------------------
// Routes file
// ---------------------------------------------------------------------------

/**
 * Generic routes.json shape — keys are transport names, values are unknown
 * (each transport validates its own slice via its `configSchema`).
 */
const GenericRoutesSchema = z.record(z.string(), z.unknown());

function loadRoutesGeneric(): Record<string, unknown> {
  return readParsed(path.join(CONFIG_DIR, 'routes.json'), GenericRoutesSchema, {});
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export interface TransportLoaderDeps {
  gateway: MessageGateway;
  bus: Bus;
  systemCommands: SystemCommandDispatcher;
}

function buildContext(name: string, deps: TransportLoaderDeps): TransportContext {
  return {
    ingestInbound: (from, to, text, senderName, routing, attachments) =>
      deps.gateway.ingestInbound(from, to, text, senderName, routing, attachments),
    ingestApprovalResponse: (from, to, response) =>
      deps.gateway.ingestApprovalResponse(from, to, response),
    resolveAddress: (address) => deps.bus.resolveAddress(address),
    listSystemCommands: () => deps.systemCommands.listCommands(),
    log: logger.child({ transport: name }),
  };
}

/**
 * Load all registered routed transports from current routes.json.
 *
 * For each registered transport, validates the matching routes.json slice
 * against its configSchema, calls `def.create(ctx, config)`, and awaits
 * `connect()`. Failures are logged and skipped — one bad transport does not
 * prevent others from connecting.
 */
export async function loadRoutedTransports(deps: TransportLoaderDeps): Promise<Transport[]> {
  const routes = loadRoutesGeneric();
  const result: Transport[] = [];

  for (const [name, def] of registry) {
    const slice = routes[name];
    const parsed = def.configSchema.safeParse(slice);
    if (!parsed.success) {
      logger.warn(
        { transport: name, issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ') },
        'Transport route validation failed — skipped',
      );
      continue;
    }

    let instance: Transport | null;
    try {
      instance = def.create(buildContext(name, deps), parsed.data);
    } catch (err) {
      logger.error({ transport: name, err }, 'Transport create() threw — skipped');
      continue;
    }
    if (!instance) continue;

    try {
      await instance.connect();
      result.push(instance);
    } catch (err) {
      logger.error({ transport: name, err }, 'Transport connect() failed — skipped');
    }
  }

  return result;
}

/**
 * Rebuild all routed transports from routes.json.
 *
 * SIDE EFFECT: Mutates the passed `transports` array. The gateway holds a
 * closure over this same array, so an in-place swap (rather than returning
 * a new list) is required to keep outbound routing live across reloads.
 *
 * Connect-new-then-disconnect-old order avoids any outbound gap.
 */
export async function reconcileRoutedTransports(
  deps: TransportLoaderDeps,
  transports: Transport[],
): Promise<void> {
  const routedNames = new Set(registry.keys());

  // Connect new transports before tearing down old ones (no outbound gap)
  const fresh = await loadRoutedTransports(deps);

  // Swap: remove old routed transports, push new ones
  const old = transports.filter((t) => routedNames.has(t.name));
  for (let i = transports.length - 1; i >= 0; i--) {
    if (routedNames.has(transports[i]!.name)) transports.splice(i, 1);
  }
  for (const t of fresh) transports.push(t);

  // Tear down old connections (fire-and-forget)
  for (const t of old) {
    t.disconnect().catch((err) => {
      logger.warn({ transport: t.name, err }, 'Failed to disconnect old transport');
    });
  }

  logger.info('Routed transports reconciled (routes.json changed)');
}
