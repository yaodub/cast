/**
 * SubscriptionManager tests — the 0.3 intent-cell-return contract.
 *
 * Covers: binding capture (target + originChannel host-stamped from the call
 * context), delivery echoing the stored binding, ownership scoping on
 * list/unsubscribe, the ownership-gated upsert (superseded handle stopped,
 * watermark carried when the watched surface is unchanged), and legacy-entry
 * tolerance (no originChannel → baked-channel fallback, i.e. `channel`
 * omitted from deliver opts).
 *
 * The watcher is a fake: watch() records its options and returns a handle
 * whose stop() is observable — no IMAP anywhere.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { SubscriptionManager } from './subscription-manager.js';
import { EmailConfigSchema } from './schemas.js';
import type { EmailEnvelope } from './schemas.js';
import type { WatchHandle, WatchOptions } from './types.js';
import { noopLogger } from '@getcast/extension-schema';
import type { ExtensionContext, ToolCallContext } from '@getcast/extension-schema';

type Deliver = ExtensionContext['deliver'];

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeWatcher {
  watches: Array<{ opts: WatchOptions; handle: WatchHandle & { stopped: boolean } }> = [];
  private nextId = 0;

  watch(opts: WatchOptions): Promise<WatchHandle> {
    const handle = {
      id: `w${this.nextId++}`,
      stopped: false,
      stop() { this.stopped = true; },
      watermark: 42,
    };
    this.watches.push({ opts, handle });
    return Promise.resolve(handle);
  }

  /** The most recently created watch entry. */
  get last() { return this.watches[this.watches.length - 1]; }
}

function ctx(participant?: string, channel?: string): ToolCallContext {
  return { stagingDir: '/tmp/in', stagingOutDir: '/tmp/out', participant, channel };
}

const CONFIG = EmailConfigSchema.parse({ inbound: { default: 'enabled' } });

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let dir: string;
let watcher: FakeWatcher;
let deliver: ReturnType<typeof vi.fn<Deliver>>;
let mgr: SubscriptionManager;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'submgr-'));
  watcher = new FakeWatcher();
  deliver = vi.fn<Deliver>().mockResolvedValue({ ok: true, result: null });
  mgr = new SubscriptionManager({
    watcher,
    privateDir: dir,
    deliver,
    config: CONFIG,
    log: noopLogger,
  });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function subsOnDisk(): Array<Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'subscriptions.json'), 'utf-8'));
}

const ALICE = ctx('u:alice@srv', 'default');
const BOB = ctx('u:bob@srv', 'main');

// ---------------------------------------------------------------------------
// Binding capture
// ---------------------------------------------------------------------------

describe('handleSubscribe — binding capture', () => {
  it('stamps target, originChannel, createdBy from the call context', async () => {
    const res = await mgr.handleSubscribe({ schedule: 'realtime', instructions: 'summarize', id: 'sub-a' }, ALICE);
    expect(res.isError).toBeUndefined();

    const [row] = subsOnDisk();
    expect(row.target).toBe('u:alice@srv');
    expect(row.originChannel).toBe('default');
    expect(row.createdBy).toBe('u:alice@srv');
  });

  it('tolerates a missing channel (agent-level context) — binding has no originChannel', async () => {
    await mgr.handleSubscribe({ schedule: 'realtime', instructions: 'i', id: 'sub-b' }, ctx('u:alice@srv'));
    const [row] = subsOnDisk();
    expect(row.originChannel).toBeUndefined();
  });

  it('rejects when there is no participant context', async () => {
    const res = await mgr.handleSubscribe({ schedule: 'realtime', instructions: 'i' }, ctx());
    expect(res.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Delivery — intent-cell return
// ---------------------------------------------------------------------------

describe('deliverEmails — echoes the stored binding', () => {
  const EMAILS: EmailEnvelope[] = [
    { emailId: 'e1', from: 'x@school.edu', subject: 's', date: '2026-01-01' } as EmailEnvelope,
  ];

  it('passes replyTo + channel from the binding', async () => {
    await mgr.handleSubscribe({ schedule: 'realtime', instructions: 'i', id: 'sub-c' }, ALICE);
    watcher.last.opts.onEmails(EMAILS);

    expect(deliver).toHaveBeenCalledTimes(1);
    const [, opts] = deliver.mock.calls[0]!;
    expect(opts).toEqual({ replyTo: 'u:alice@srv', channel: 'default' });
  });

  it('legacy entry without originChannel omits channel (baked-channel fallback)', async () => {
    // Simulate a pre-0.3.1 store: entry with no originChannel, loaded at start().
    fs.writeFileSync(path.join(dir, 'subscriptions.json'), JSON.stringify([{
      id: 'legacy', criteria: {}, target: 'u:alice@srv', schedule: 'realtime',
      instructions: 'i', enabled: true, watermark: 7, createdAt: '2026-01-01T00:00:00Z',
    }]));
    await mgr.start();
    watcher.last.opts.onEmails(EMAILS);

    const [, opts] = deliver.mock.calls[0]!;
    expect(opts?.replyTo).toBe('u:alice@srv');
    expect(opts?.channel).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Ownership scoping
// ---------------------------------------------------------------------------

describe('ownership — list and unsubscribe are cell-scoped', () => {
  beforeEach(async () => {
    await mgr.handleSubscribe({ schedule: 'realtime', instructions: 'i', id: 'sub-alice' }, ALICE);
    await mgr.handleSubscribe({ schedule: 'realtime', instructions: 'i', id: 'sub-bob' }, BOB);
  });

  it('list shows only the caller\'s entries', () => {
    const res = mgr.handleListSubscriptions(ALICE);
    const text = res.content[0].text;
    expect(text).toContain('sub-alice');
    expect(text).not.toContain('sub-bob');
  });

  it('operator tier sees all entries', () => {
    const res = mgr.handleListSubscriptions(ctx('cli:operator', 'default'));
    const text = res.content[0].text;
    expect(text).toContain('sub-alice');
    expect(text).toContain('sub-bob');
  });

  it('unsubscribe denies another cell\'s entry with the not-found message (no oracle)', () => {
    const res = mgr.handleUnsubscribe({ id: 'sub-alice' }, BOB);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
    expect(mgr.subscriptionCount).toBe(2);
  });

  it('unsubscribe removes own entry and stops its watch', () => {
    const aliceHandle = watcher.watches[0].handle;
    const res = mgr.handleUnsubscribe({ id: 'sub-alice' }, ALICE);
    expect(res.isError).toBeUndefined();
    expect(aliceHandle.stopped).toBe(true);
    expect(mgr.subscriptionCount).toBe(1);
  });

  it('operator can remove any entry', () => {
    const res = mgr.handleUnsubscribe({ id: 'sub-bob' }, ctx('admin:web'));
    expect(res.isError).toBeUndefined();
    expect(mgr.subscriptionCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

describe('explicit-id upsert', () => {
  it('stops the superseded watch handle (no duplicate live watch)', async () => {
    await mgr.handleSubscribe({ schedule: 'realtime', instructions: 'v1', id: 'sub-x' }, ALICE);
    const first = watcher.watches[0].handle;

    await mgr.handleSubscribe({ schedule: 'realtime', instructions: 'v2', id: 'sub-x' }, ALICE);
    expect(first.stopped).toBe(true);
    expect(mgr.subscriptionCount).toBe(1);
    expect(watcher.watches).toHaveLength(2); // old stopped, new live
  });

  it('carries the watermark when criteria and folder are unchanged', async () => {
    await mgr.handleSubscribe({ schedule: 'realtime', instructions: 'v1', id: 'sub-y', from: '@school.edu' }, ALICE);
    // Re-subscribe, same watched surface: the new watch resumes from the old
    // watermark instead of reseeding (initialWatermark flows into watch()).
    await mgr.handleSubscribe({ schedule: 'realtime', instructions: 'v2', id: 'sub-y', from: '@school.edu' }, ALICE);
    expect(watcher.last.opts.initialWatermark).toBe(42);
  });

  it('reseeds when the criteria change', async () => {
    await mgr.handleSubscribe({ schedule: 'realtime', instructions: 'v1', id: 'sub-z', from: '@a.com' }, ALICE);
    await mgr.handleSubscribe({ schedule: 'realtime', instructions: 'v2', id: 'sub-z', from: '@b.com' }, ALICE);
    expect(watcher.last.opts.initialWatermark).toBeUndefined();
  });

  it('rejects an id owned by another cell', async () => {
    await mgr.handleSubscribe({ schedule: 'realtime', instructions: 'i', id: 'sub-w' }, ALICE);
    const res = await mgr.handleSubscribe({ schedule: 'realtime', instructions: 'steal', id: 'sub-w' }, BOB);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('already in use');
    // Alice's binding untouched.
    const row = subsOnDisk().find(r => r.id === 'sub-w')!;
    expect(row.target).toBe('u:alice@srv');
  });
});
