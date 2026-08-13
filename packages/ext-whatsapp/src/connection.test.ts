/**
 * ConnectionManager — disconnect classification and the ensureUsable gate.
 *
 * No real Baileys socket: handleDisconnect is driven directly (bracket access
 * to the private method) with boom-shaped errors, the same shape Baileys
 * delivers via connection.update.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionManager, classifyDisconnect } from './connection.js';
import type { Logger } from '@getcast/extension-schema';
import type { WhatsAppStore } from './store.js';

const boom = (statusCode: number): Error =>
  Object.assign(new Error(`boom ${statusCode}`), { output: { statusCode } });

const makeLog = () => ({
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
}) as unknown as Logger & { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };

describe('classifyDisconnect', () => {
  it('classifies 401 as logged-out', () => {
    expect(classifyDisconnect(401)).toBe('logged-out');
  });

  it('classifies 405 as rejected', () => {
    expect(classifyDisconnect(405)).toBe('rejected');
  });

  it('classifies everything else as reconnect', () => {
    expect(classifyDisconnect(428)).toBe('reconnect');
    expect(classifyDisconnect(515)).toBe('reconnect');
    expect(classifyDisconnect(undefined)).toBe('reconnect');
  });
});

describe('ConnectionManager — rejected state and ensureUsable', () => {
  let privateDir: string;
  let log: ReturnType<typeof makeLog>;
  let m: ConnectionManager;

  beforeEach(() => {
    privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-conn-'));
    log = makeLog();
    m = new ConnectionManager({
      privateDir,
      store: {} as WhatsAppStore,
      log,
      getMessage: async () => undefined,
      pairingHistoryDepth: 'standard',
    });
  });

  afterEach(() => {
    m.disconnect();
    fs.rmSync(privateDir, { recursive: true, force: true });
  });

  const pairOnDisk = () => {
    const authDir = path.join(privateDir, 'auth');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(path.join(authDir, 'creds.json'), JSON.stringify({ registered: true }));
  };

  it('reports unpaired without waiting when no credentials exist', async () => {
    const t0 = Date.now();
    expect(await m.ensureUsable(5_000)).toEqual({ ok: false, reason: 'unpaired' });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('405 disconnect enters rejected: no reconnect timer, one error log', () => {
    pairOnDisk();
    m['state'] = { status: 'connecting', attempt: 0 };
    m['handleDisconnect'](boom(405));
    expect(m['state']).toEqual({ status: 'rejected', statusCode: 405 });
    expect(m['reconnectTimer']).toBeNull();
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('non-405 disconnect still schedules a reconnect', () => {
    pairOnDisk();
    m['state'] = { status: 'connecting', attempt: 0 };
    m['handleDisconnect'](boom(428));
    expect(m['state']).toEqual({ status: 'disconnected', attempt: 1 });
    expect(m['reconnectTimer']).not.toBeNull();
  });

  it('ensureUsable reports rejected immediately once in the rejected state', async () => {
    pairOnDisk();
    m['state'] = { status: 'connecting', attempt: 0 };
    m['handleDisconnect'](boom(405));
    const t0 = Date.now();
    expect(await m.ensureUsable(5_000)).toEqual({ ok: false, reason: 'rejected' });
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('a waiter parked before the 405 wakes with rejected, not timeout', async () => {
    pairOnDisk();
    m['state'] = { status: 'connecting', attempt: 0 };
    const waiter = m.ensureUsable(10_000);
    m['handleDisconnect'](boom(405));
    expect(await waiter).toEqual({ ok: false, reason: 'rejected' });
  });

  it('ensureUsable times out while stuck connecting', async () => {
    pairOnDisk();
    m['state'] = { status: 'connecting', attempt: 0 };
    expect(await m.ensureUsable(100)).toEqual({ ok: false, reason: 'timeout' });
  });

  it('ensureUsable returns ok once ready resolves in the open state', async () => {
    pairOnDisk();
    m['state'] = { status: 'open' };
    const waiter = m.ensureUsable(5_000);
    m['readyResolve']();
    expect(await waiter).toEqual({ ok: true });
  });
});
