/**
 * AgentService stop/restart interleaving — the SIGKILL race regression.
 *
 * The bug: stop() resolved at kill time instead of at the child's close
 * event, so restart() spawned the successor while the predecessor was still
 * dying; the predecessor's late close (code=null, signal=SIGKILL) was then
 * misattributed to the brand-new `starting` state ("exited before ready"),
 * orphaning the live successor — and the NEXT restart "worked", giving the
 * every-alternate-restart failure pattern.
 *
 * Both branches: graceful exits restart cleanly without a kill, AND the
 * kill path (slow/unkillable child) still hands over to the successor with
 * stale events ignored.
 */
import { EventEmitter } from 'events';
import fs from 'fs';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const spawned = vi.hoisted(() => [] as FakeProc[]);
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, spawn: spawnMock };
});

import { agentPath } from '../config.js';
import { AgentService } from './agent-service.js';

class FakeProc extends EventEmitter {
  send = vi.fn();
  kill = vi.fn();
}

const FOLDER = 'svc-restart-race-test';

function makeService(): AgentService {
  return new AgentService({
    folder: FOLDER,
    onRouteMessage: vi.fn().mockResolvedValue({ ok: true, result: null }),
  });
}

/** Drive a service to `running`: start + emit ready from the spawned fake. */
async function startToRunning(svc: AgentService): Promise<FakeProc> {
  const p = svc.start();
  const proc = spawned[spawned.length - 1]!;
  proc.emit('message', { type: 'ready' });
  await p;
  expect(svc.status).toBe('running');
  return proc;
}

beforeEach(() => {
  spawned.length = 0;
  spawnMock.mockReset();
  spawnMock.mockImplementation(() => {
    const proc = new FakeProc();
    spawned.push(proc);
    return proc;
  });
  // A runnable service on disk: stamped-bundle shape (index.js, no entry).
  fs.rmSync(agentPath(FOLDER), { recursive: true, force: true });
  fs.mkdirSync(agentPath(FOLDER, 'blueprint', 'service'), { recursive: true });
  fs.writeFileSync(agentPath(FOLDER, 'blueprint', 'service', 'manifest.json'), '{}');
  fs.writeFileSync(agentPath(FOLDER, 'blueprint', 'service', 'index.js'), '// bundle');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('restart — graceful branch', () => {
  it('hands over cleanly when the old process exits on shutdown (no kill)', async () => {
    const svc = makeService();
    const procA = await startToRunning(svc);

    const restartP = svc.restart();
    expect(procA.send).toHaveBeenCalledWith({ type: 'shutdown' });
    procA.emit('close', 0, null);

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2));
    spawned[1]!.emit('message', { type: 'ready' });
    await restartP;

    expect(svc.status).toBe('running');
    expect(procA.kill).not.toHaveBeenCalled();
  });
});

describe('restart — kill branch (the regression)', () => {
  it('does not spawn the successor until the killed predecessor has actually closed', async () => {
    vi.useFakeTimers();
    const svc = makeService();
    const procA = await startToRunning(svc);

    const restartP = svc.restart();

    // Patience expires → SIGKILL. stop() must NOT resolve here.
    await vi.advanceTimersByTimeAsync(7_000);
    expect(procA.kill).toHaveBeenCalledWith('SIGKILL');
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // The predecessor's close arrives — exactly the event that used to be
    // misattributed to the successor's `starting` state. Now it gates the
    // successor's spawn instead.
    procA.emit('close', null, 'SIGKILL');
    await vi.advanceTimersByTimeAsync(0);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    spawned[1]!.emit('message', { type: 'ready' });
    await expect(restartP).resolves.toBeUndefined(); // used to reject "exited before ready"
    expect(svc.status).toBe('running');
  });

  it('proceeds after the post-kill fallback and ignores the predecessor\'s stale close', async () => {
    vi.useFakeTimers();
    const svc = makeService();
    const procA = await startToRunning(svc);

    const restartP = svc.restart();
    await vi.advanceTimersByTimeAsync(7_000); // SIGKILL
    await vi.advanceTimersByTimeAsync(2_000); // unkillable — fallback resolves stop()

    await vi.advanceTimersByTimeAsync(0);
    expect(spawnMock).toHaveBeenCalledTimes(2);

    // The zombie finally closes AFTER the successor is mid-startup — the
    // stale-event guard must leave the successor's state untouched.
    procA.emit('close', null, 'SIGKILL');
    expect(svc.status).toBe('starting');

    spawned[1]!.emit('message', { type: 'ready' });
    await expect(restartP).resolves.toBeUndefined();
    expect(svc.status).toBe('running');
  });
});
