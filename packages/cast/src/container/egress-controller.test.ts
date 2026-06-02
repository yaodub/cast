import { describe, it, expect, vi } from 'vitest';

// Avoid the real config.ts runtime probe (resolveRuntime throws without a
// container binary) and pino setup — the controller only needs these symbols,
// and the side-effecting seams are injected below.
vi.mock('../config.js', () => ({ RUNTIME_BINARY: 'container', EGRESS_GRACE_MS: 600_000 }));
vi.mock('../logger.js', () => ({ logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import {
  EgressController,
  classifyHost,
  computeDesiredSet,
  diffDesired,
  parseAllowlistEntry,
  resolveHosts,
  serializePayload,
} from './egress-controller.js';
import type { AllowEntry, ApplyFn, ApplyResult, DesiredSet, Pin, ResolveFn, ResolveResult } from './egress-controller.js';

const pin = (host: string, ip: string, port = 443, family: 4 | 6 = 4): Pin => ({ host, ip, family, port });
const resolved = (host: string, ...ips: string[]): ResolveResult => ({
  kind: 'resolved',
  host,
  addrs: ips.map((ip) => ({ address: ip, family: 4 as const })),
});
const failed = (host: string): ResolveResult => ({ kind: 'failed', host, error: 'nx' });

// Resolve fake driven by a host→ips map (missing/null → failed). Anthropic hosts
// default to fixed IPs so `desired` is non-empty unless a test overrides them.
function makeResolve(map: Record<string, string[] | null>): ResolveFn {
  const full: Record<string, string[] | null> = {
    'api.anthropic.com': ['10.0.0.1'],
    'claude.ai': ['10.0.0.2'],
    'platform.claude.com': ['10.0.0.3'],
    ...map,
  };
  return (entries) =>
    Promise.resolve(
      entries.map((e) => {
        const ips = full[e.host];
        return ips == null ? failed(e.host) : resolved(e.host, ...ips);
      }),
    );
}

function recordingApply(result: ApplyResult = { ok: true }): { fn: ApplyFn; calls: { name: string; payload: string }[] } {
  const calls: { name: string; payload: string }[] = [];
  const fn: ApplyFn = (name, payload) => {
    calls.push({ name, payload });
    return Promise.resolve(result);
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Pure core
// ---------------------------------------------------------------------------

describe('parseAllowlistEntry', () => {
  it('defaults the port to 443 and splits host:port', () => {
    expect(parseAllowlistEntry('api.x.com')).toEqual({ host: 'api.x.com', port: 443 });
    expect(parseAllowlistEntry('api.x.com:8080')).toEqual({ host: 'api.x.com', port: 8080 });
    expect(parseAllowlistEntry('192.168.1.100:5432')).toEqual({ host: '192.168.1.100', port: 5432 });
  });
});

describe('classifyHost', () => {
  it('distinguishes ipv4 / ipv6 / name', () => {
    expect(classifyHost('1.2.3.4')).toBe('ipv4');
    expect(classifyHost('fe80::1')).toBe('ipv6');
    expect(classifyHost('api.anthropic.com')).toBe('name');
  });
});

describe('diffDesired', () => {
  it('is true vs null and on any change, false when identical', () => {
    const a: DesiredSet = { pins: [pin('x', '1.1.1.1')] };
    expect(diffDesired(null, a)).toBe(true);
    expect(diffDesired(a, { pins: [pin('x', '1.1.1.1')] })).toBe(false);
    expect(diffDesired(a, { pins: [pin('x', '2.2.2.2')] })).toBe(true);
  });
});

describe('serializePayload', () => {
  it('emits host\\tip\\tfamily\\tport lines', () => {
    expect(serializePayload({ pins: [pin('x.com', '1.1.1.1'), pin('y.com', '2.2.2.2', 8080)] })).toBe(
      'x.com\t1.1.1.1\t4\t443\ny.com\t2.2.2.2\t4\t8080\n',
    );
  });
});

describe('computeDesiredSet', () => {
  const entries: AllowEntry[] = [{ host: 'x.com', port: 443 }];

  it('resolved → pins for current IPs', () => {
    const r = computeDesiredSet(entries, [resolved('x.com', '2.2.2.2')], [], [], 0, 100);
    expect(r.desired.pins).toEqual([pin('x.com', '2.2.2.2')]);
  });

  it('raw-ip → single pin, no resolution needed', () => {
    const r = computeDesiredSet(
      [{ host: '203.0.113.5', port: 5432 }],
      [{ kind: 'raw-ip', host: '203.0.113.5', ip: '203.0.113.5', family: 4 }],
      [],
      [],
      0,
      100,
    );
    expect(r.desired.pins).toEqual([pin('203.0.113.5', '203.0.113.5', 5432)]);
  });

  it('failed host → holds last-known-good active pins (no aging)', () => {
    const prevActive = [pin('x.com', '1.1.1.1')];
    const r = computeDesiredSet(entries, [failed('x.com')], prevActive, [], 1000, 100);
    expect(r.desired.pins.map((p) => p.ip)).toEqual(['1.1.1.1']);
    expect(r.failedHosts).toEqual(['x.com']);
  });

  it('rotation → keeps the old IP within grace, drops it after, never re-retires', () => {
    const prevActive = [pin('x.com', '1.1.1.1')];
    const results = [resolved('x.com', '2.2.2.2')];
    // tick 1: rotation at now=1000, grace=100 → old retiring (expiry 1100) + new active
    const t1 = computeDesiredSet(entries, results, prevActive, [], 1000, 100);
    expect(t1.desired.pins.map((p) => p.ip).sort()).toEqual(['1.1.1.1', '2.2.2.2']);
    expect(t1.active.map((p) => p.ip)).toEqual(['2.2.2.2']);
    // tick 2: now=2000 > expiry → old aged out
    const t2 = computeDesiredSet(entries, results, t1.active, t1.retiring, 2000, 100);
    expect(t2.desired.pins.map((p) => p.ip)).toEqual(['2.2.2.2']);
    // tick 3: aged-out IP must not be re-retired
    const t3 = computeDesiredSet(entries, results, t2.active, t2.retiring, 3000, 100);
    expect(t3.desired.pins.map((p) => p.ip)).toEqual(['2.2.2.2']);
  });
});

describe('resolveHosts', () => {
  it('short-circuits literal IPs without DNS', async () => {
    const r = await resolveHosts([
      { host: '1.2.3.4', port: 443 },
      { host: 'fe80::1', port: 443 },
    ]);
    expect(r).toEqual([
      { kind: 'raw-ip', host: '1.2.3.4', ip: '1.2.3.4', family: 4 },
      { kind: 'raw-ip', host: 'fe80::1', ip: 'fe80::1', family: 6 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator (injected fakes — both branches of each gate exercised)
// ---------------------------------------------------------------------------

describe('EgressController.reconcile', () => {
  it('skips non-sdk-only without resolving or applying', async () => {
    const apply = recordingApply();
    const resolve = vi.fn(makeResolve({}));
    const c = new EgressController({ resolve, apply: apply.fn });
    const r = await c.reconcile('ctr', [], 'full');
    expect(r).toEqual({ kind: 'skipped', reason: 'not-sdk-only' });
    expect(resolve).not.toHaveBeenCalled();
    expect(apply.calls).toHaveLength(0);
  });

  it('applies on first reconcile, then skips when unchanged', async () => {
    const apply = recordingApply();
    const c = new EgressController({ resolve: makeResolve({ 'api.x.com': ['9.9.9.9'] }), apply: apply.fn });
    expect((await c.reconcile('ctr', ['api.x.com:443'], 'sdk-only')).kind).toBe('applied');
    expect(apply.calls).toHaveLength(1);
    expect(await c.reconcile('ctr', ['api.x.com:443'], 'sdk-only')).toEqual({ kind: 'skipped', reason: 'unchanged' });
    expect(apply.calls).toHaveLength(1);
  });

  it('re-applies on rotation with the new IP', async () => {
    const apply = recordingApply();
    let ip = '9.9.9.9';
    const resolve: ResolveFn = (entries) => makeResolve({ 'api.x.com': [ip] })(entries);
    const c = new EgressController({ resolve, apply: apply.fn });
    await c.reconcile('ctr', ['api.x.com:443'], 'sdk-only');
    ip = '8.8.8.8';
    expect((await c.reconcile('ctr', ['api.x.com:443'], 'sdk-only')).kind).toBe('applied');
    expect(apply.calls).toHaveLength(2);
    expect(apply.calls[1]?.payload).toContain('8.8.8.8');
  });

  it('holds (no apply) when all resolution fails with no prior state', async () => {
    const apply = recordingApply();
    const resolve: ResolveFn = (entries) => Promise.resolve(entries.map((e) => failed(e.host)));
    const c = new EgressController({ resolve, apply: apply.fn });
    expect(await c.reconcile('ctr', ['api.x.com:443'], 'sdk-only')).toEqual({ kind: 'skipped', reason: 'empty-desired' });
    expect(apply.calls).toHaveLength(0);
  });

  it('keeps last-known-good when resolution later fails (no re-apply, egress retained)', async () => {
    const apply = recordingApply();
    let ok = true;
    const resolve: ResolveFn = (entries) =>
      Promise.resolve(entries.map((e) => (ok ? resolved(e.host, e.host === 'api.x.com' ? '9.9.9.9' : '10.0.0.1') : failed(e.host))));
    const c = new EgressController({ resolve, apply: apply.fn });
    await c.reconcile('ctr', ['api.x.com:443'], 'sdk-only'); // applied
    ok = false; // every host fails now
    expect(await c.reconcile('ctr', ['api.x.com:443'], 'sdk-only')).toEqual({ kind: 'skipped', reason: 'unchanged' });
    expect(apply.calls).toHaveLength(1); // egress held, never re-applied to empty
  });

  it('excludes container-only aliases (casthost) from resolve and the applied set', async () => {
    const apply = recordingApply();
    const seen: string[] = [];
    const resolve: ResolveFn = (entries) => {
      seen.push(...entries.map((e) => e.host));
      return makeResolve({ 'api.x.com': ['9.9.9.9'] })(entries);
    };
    const c = new EgressController({ resolve, apply: apply.fn });
    const r = await c.reconcile('ctr', ['casthost:5432', 'api.x.com:443'], 'sdk-only');
    expect(r.kind).toBe('applied');
    // casthost is pinned on the static OUTPUT chain at boot — the host cannot
    // resolve it, so it must never be resolved here nor enter the payload (which
    // would flush it on apply).
    expect(seen).not.toContain('casthost');
    expect(seen).toContain('api.x.com');
    expect(apply.calls[0]?.payload).not.toContain('casthost');
    expect(apply.calls[0]?.payload).toContain('api.x.com');
  });

  it('reports exec-failed and retries on the next tick', async () => {
    const calls: string[] = [];
    let failApply = true;
    const apply: ApplyFn = (_name, payload) => {
      calls.push(payload);
      return Promise.resolve(failApply ? { ok: false, error: 'gone' } : { ok: true });
    };
    const c = new EgressController({ resolve: makeResolve({ 'api.x.com': ['9.9.9.9'] }), apply });
    expect(await c.reconcile('ctr', ['api.x.com:443'], 'sdk-only')).toEqual({ kind: 'exec-failed', error: 'gone' });
    expect(calls).toHaveLength(1);
    failApply = false;
    expect((await c.reconcile('ctr', ['api.x.com:443'], 'sdk-only')).kind).toBe('applied'); // state not advanced → retries
    expect(calls).toHaveLength(2);
  });
});
