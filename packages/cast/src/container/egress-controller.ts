/**
 * Host-side egress controller for `sdk-only` containers.
 *
 * The container's firewall pins allowlisted names→IPs into a `CAST_EGRESS`
 * iptables chain + `/etc/hosts` at boot, with port 53 closed (see
 * `packages/agent-runner/entrypoint.sh`). This module is the steady-state brain:
 * it resolves the allowlist on the HOST (the container has no DNS), computes the
 * desired pin-set, and reconciles a running container's chain + `/etc/hosts` via
 * a root-only `container exec` to `/app/update-egress.sh`.
 *
 * Two triggers call `reconcile`: a periodic refresh (CDN-rotation freshness) and
 * the config hot-reload (live allowlist edits). Resolution lives entirely here;
 * the container never resolves after boot.
 *
 * Design: the compute core (`computeDesiredSet`, `diffDesired`, `serializePayload`,
 * `parseAllowlistEntry`, `classifyHost`) is pure and unit-tested directly. The two
 * side-effecting seams (`resolveHosts`, `applyToContainer`) are injectable so the
 * orchestrator is testable without DNS or a real container.
 */
import { spawn } from 'child_process';
import { lookup } from 'node:dns/promises';

import { EGRESS_GRACE_MS, RUNTIME_BINARY } from '../config.js';
import { logger } from '../logger.js';

// Always allowed in sdk-only — mirrors the hardcoded set in entrypoint.sh.
// (Cross-process boundary: duplication with the bash entrypoint is intentional.)
const ANTHROPIC_ENDPOINTS: AllowEntry[] = [
  { host: 'api.anthropic.com', port: 443 },
  { host: 'claude.ai', port: 443 },
  { host: 'platform.claude.com', port: 443 },
];

// Container-only aliases the host cannot resolve — their IP is the bridge gateway,
// known only inside the container. The entrypoint pins these on the static OUTPUT
// chain at boot (outside CAST_EGRESS), so a reconcile never drops them. The
// controller must exclude them from its host-side resolve/desired set, or it would
// flush a rule it can never re-derive. Mirrors entrypoint.sh's casthost handling.
const CONTAINER_ONLY_ALIASES = new Set(['casthost']);

export interface AllowEntry {
  host: string;
  port: number;
}

export interface Pin {
  host: string;
  ip: string;
  family: 4 | 6;
  port: number;
}

export interface DesiredSet {
  /** Canonical: deduped + sorted, so structural equality drives the no-op skip. */
  pins: Pin[];
}

/** Per-host resolution outcome. */
export type ResolveResult =
  | { kind: 'resolved'; host: string; addrs: { address: string; family: 4 | 6 }[] }
  | { kind: 'raw-ip'; host: string; ip: string; family: 4 | 6 }
  | { kind: 'failed'; host: string; error: string };

/** Outcome of a single container reconcile (consumer-facing). */
export type ReconcileResult =
  | { kind: 'skipped'; reason: 'unchanged' | 'not-sdk-only' | 'empty-desired' }
  | { kind: 'applied'; pinCount: number; degraded: boolean }
  | { kind: 'exec-failed'; error: string };

export type ApplyResult = { ok: true } | { ok: false; error: string };

export type ResolveFn = (entries: AllowEntry[]) => Promise<ResolveResult[]>;
export type ApplyFn = (containerName: string, payload: string) => Promise<ApplyResult>;

/** An IP kept reachable for a grace window after it rotated out of resolution. */
interface GraceEntry {
  pin: Pin;
  expiry: number;
}

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

/** Parse a `host`/`host:port` allowlist entry. Port defaults to 443. Mirrors the
 *  `${entry%%:*}` / `${entry##*:}` split in entrypoint.sh (first colon = host
 *  boundary, last segment = port). */
export function parseAllowlistEntry(entry: string): AllowEntry {
  const firstColon = entry.indexOf(':');
  if (firstColon === -1) return { host: entry, port: 443 };
  const host = entry.slice(0, firstColon);
  const portStr = entry.slice(entry.lastIndexOf(':') + 1);
  const port = Number(portStr);
  return { host, port: portStr !== '' && Number.isInteger(port) ? port : 443 };
}

/** Classify an allowlist host as a literal IP or a name to resolve. Mirrors the
 *  regexes in entrypoint.sh's `allow_endpoint`. */
export function classifyHost(host: string): 'ipv4' | 'ipv6' | 'name' {
  if (/^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+(\/[0-9]+)?$/.test(host)) return 'ipv4';
  if (/^[0-9a-fA-F:]+(\/[0-9]+)?$/.test(host)) return 'ipv6';
  return 'name';
}

function pinKey(p: Pin): string {
  return `${p.family}|${p.ip}|${p.port}|${p.host}`;
}

function canonical(d: DesiredSet): string {
  return d.pins.map(pinKey).join('\n');
}

function sortAndDedupe(pins: Pin[]): Pin[] {
  const seen = new Set<string>();
  const out: Pin[] = [];
  for (const p of pins) {
    const k = pinKey(p);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(p);
    }
  }
  return out.sort((a, b) => pinKey(a).localeCompare(pinKey(b)));
}

interface DesiredComputation {
  /** This tick's active pins (resolved IPs + last-known-good for failed hosts).
   *  Tracked separately from `retiring` so an aged-out IP isn't re-retired. */
  active: Pin[];
  desired: DesiredSet;
  retiring: GraceEntry[];
  failedHosts: string[];
}

/**
 * Compute the desired pin-set from this tick's resolutions, the previous tick's
 * *active* pins, and the in-flight grace entries. Pure — `now`/`graceMs` passed in.
 *
 * - Resolved host → pins for its current IPs.
 * - Raw-IP host → a single pin.
 * - Failed host → reuse the previous active pins for that host (last-known-good,
 *   held indefinitely — a DNS hiccup must not blackhole egress).
 * - An IP that a *successful* re-resolve dropped from active → kept in `retiring`
 *   for `graceMs` so a connection that resolved it just before the rotation isn't
 *   cut. `desired` = active ∪ still-retiring.
 */
export function computeDesiredSet(
  entries: AllowEntry[],
  results: ResolveResult[],
  prevActive: Pin[],
  retiring: GraceEntry[],
  now: number,
  graceMs: number,
): DesiredComputation {
  const byHost = new Map(results.map((r) => [r.host, r]));
  const active: Pin[] = [];
  const failedHosts: string[] = [];

  for (const e of entries) {
    const r = byHost.get(e.host);
    if (!r || r.kind === 'failed') {
      failedHosts.push(e.host);
      active.push(...prevActive.filter((p) => p.host === e.host)); // last-known-good
    } else if (r.kind === 'raw-ip') {
      active.push({ host: r.host, ip: r.ip, family: r.family, port: e.port });
    } else {
      for (const a of r.addrs) active.push({ host: r.host, ip: a.address, family: a.family, port: e.port });
    }
  }

  const activeDeduped = sortAndDedupe(active);
  const activeKeys = new Set(activeDeduped.map(pinKey));
  const succeededHosts = new Set(results.filter((r) => r.kind !== 'failed').map((r) => r.host));

  const nextRetiring: GraceEntry[] = [];
  for (const g of retiring) {
    if (activeKeys.has(pinKey(g.pin))) continue; // back in active — no longer retiring
    if (g.expiry > now) nextRetiring.push(g); // still within grace
  }
  const retiringKeys = new Set(nextRetiring.map((g) => pinKey(g.pin)));
  for (const p of prevActive) {
    if (activeKeys.has(pinKey(p))) continue;
    if (!succeededHosts.has(p.host)) continue; // failed host → handled by last-known-good
    if (retiringKeys.has(pinKey(p))) continue;
    nextRetiring.push({ pin: p, expiry: now + graceMs });
  }

  const desiredPins = sortAndDedupe([...activeDeduped, ...nextRetiring.map((g) => g.pin)]);
  return { active: activeDeduped, desired: { pins: desiredPins }, retiring: nextRetiring, failedHosts };
}

/** True when the desired set differs from what was last applied (drives the skip). */
export function diffDesired(applied: DesiredSet | null, next: DesiredSet): boolean {
  return applied === null || canonical(applied) !== canonical(next);
}

/** Serialize the desired set to the `update-egress.sh` stdin contract:
 *  one `host\tip\tfamily\tport` line per pin, trailing newline. */
export function serializePayload(d: DesiredSet): string {
  return d.pins.map((p) => `${p.host}\t${p.ip}\t${p.family}\t${p.port}`).join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Side-effecting seams (injectable)
// ---------------------------------------------------------------------------

/** Resolve allowlist entries on the host. The only `node:dns` touchpoint.
 *  SIDE EFFECT: performs DNS lookups. Literal IPs short-circuit (no lookup);
 *  lookup errors degrade to `{ kind: 'failed' }` so the caller can hold
 *  last-known-good rather than blackholing egress. */
export const resolveHosts: ResolveFn = (entries) =>
  Promise.all(
    entries.map(async (e): Promise<ResolveResult> => {
      const cls = classifyHost(e.host);
      if (cls === 'ipv4') return { kind: 'raw-ip', host: e.host, ip: e.host, family: 4 };
      if (cls === 'ipv6') return { kind: 'raw-ip', host: e.host, ip: e.host, family: 6 };
      try {
        const addrs = await lookup(e.host, { all: true });
        if (addrs.length === 0) return { kind: 'failed', host: e.host, error: 'no addresses' };
        return {
          kind: 'resolved',
          host: e.host,
          addrs: addrs.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 })),
        };
      } catch (err) {
        return { kind: 'failed', host: e.host, error: err instanceof Error ? err.message : String(err) };
      }
    }),
  );

/** Apply the desired set to a running container via a root-only `container exec`
 *  to the baked `/app/update-egress.sh`. The only `execFile`/`spawn` touchpoint.
 *  SIDE EFFECT: mutates the container's CAST_EGRESS chain + /etc/hosts. Never
 *  rejects — a dead container / nonzero exit returns `{ ok: false }`. */
export const applyToContainer: ApplyFn = (containerName, payload) =>
  new Promise<ApplyResult>((resolve) => {
    const proc = spawn(RUNTIME_BINARY, ['exec', '-i', containerName, '/app/update-egress.sh', 'reconcile'], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
    proc.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: `update-egress exited ${code}: ${stderr.slice(-200).trim()}` });
    });
    proc.stdin?.write(payload);
    proc.stdin?.end();
  });

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

interface ContainerRecord {
  /** Last tick's active pins (feeds next tick's last-known-good + rotation grace). */
  active: Pin[];
  retiring: GraceEntry[];
  /** Last set successfully applied to the container — drives the no-op skip. */
  applied: DesiredSet | null;
}

/**
 * Owns per-container pin state and drives reconciles. One `EgressController`
 * per agent (held by AgentManager). `reconcile` is the single chokepoint both
 * the periodic timer and the config hot-reload call.
 */
export class EgressController {
  private records = new Map<string, ContainerRecord>();
  private readonly graceMs: number;
  private readonly resolve: ResolveFn;
  private readonly apply: ApplyFn;

  constructor(opts: { graceMs?: number; resolve?: ResolveFn; apply?: ApplyFn } = {}) {
    this.graceMs = opts.graceMs ?? EGRESS_GRACE_MS;
    this.resolve = opts.resolve ?? resolveHosts;
    this.apply = opts.apply ?? applyToContainer;
  }

  /** Drop a container's tracked state (call when it exits). */
  forget(containerName: string): void {
    this.records.delete(containerName);
  }

  /** Reconcile one container's egress to its current allowlist. Only acts on
   *  `sdk-only`; resolves host-side, diffs against last-applied (skips when
   *  unchanged), holds last-known-good on resolution failure, and never wipes
   *  egress to empty. */
  async reconcile(containerName: string, allowedEndpoints: string[], network: string | undefined): Promise<ReconcileResult> {
    if (network !== 'sdk-only') return { kind: 'skipped', reason: 'not-sdk-only' };

    const entries = [
      ...ANTHROPIC_ENDPOINTS,
      ...allowedEndpoints.map(parseAllowlistEntry).filter((e) => !CONTAINER_ONLY_ALIASES.has(e.host)),
    ];
    const results = await this.resolve(entries);
    const rec = this.records.get(containerName) ?? { active: [], retiring: [], applied: null };
    const { active, desired, retiring, failedHosts } = computeDesiredSet(
      entries,
      results,
      rec.active,
      rec.retiring,
      Date.now(),
      this.graceMs,
    );

    if (desired.pins.length === 0) {
      // All failed with no last-known-good — hold rather than apply an empty set.
      this.records.set(containerName, { active, retiring, applied: rec.applied });
      return { kind: 'skipped', reason: 'empty-desired' };
    }
    if (!diffDesired(rec.applied, desired)) {
      this.records.set(containerName, { active, retiring, applied: rec.applied });
      return { kind: 'skipped', reason: 'unchanged' };
    }

    const res = await this.apply(containerName, serializePayload(desired));
    if (!res.ok) {
      // Container may have exited; keep prior state and let the caller log.
      return { kind: 'exec-failed', error: res.error };
    }
    this.records.set(containerName, { active, retiring, applied: desired });
    return { kind: 'applied', pinCount: desired.pins.length, degraded: failedHosts.length > 0 };
  }

  /** Reconcile many containers concurrently. Per-container isolation: one failure
   *  (e.g. a container that exited mid-refresh) never stalls the others. */
  async reconcileMany(
    containers: { containerName: string; folder: string }[],
    lookupConfig: (folder: string) => { allowedEndpoints: string[]; network: string | undefined },
  ): Promise<void> {
    await Promise.all(
      containers.map(async (c) => {
        try {
          const cfg = lookupConfig(c.folder);
          const result = await this.reconcile(c.containerName, cfg.allowedEndpoints, cfg.network);
          if (result.kind === 'exec-failed') {
            logger.debug(
              { container: c.containerName, folder: c.folder, error: result.error },
              'egress reconcile exec failed (container may have exited)',
            );
          }
        } catch (err) {
          logger.warn({ container: c.containerName, folder: c.folder, err }, 'egress reconcile threw');
        }
      }),
    );
  }
}
