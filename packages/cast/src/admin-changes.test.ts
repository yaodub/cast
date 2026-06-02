import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

import { mountChangesStream } from './admin/changes.js';
import { createSession } from './admin/trpc.js';
import type { FileWatcher } from './lib/file-watcher.js';
import type { Express, RequestHandler, Request, Response } from 'express';

// Silence the logger.info call from mountChangesStream
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Test harness — capture the registered handler, stub watcher, build mock req/res
// ---------------------------------------------------------------------------

interface FakeWatcher extends Pick<FileWatcher, 'onAnyChange'> {
  version: number;
  fire: () => void;
}

function makeWatcher(initialVersion = 0): FakeWatcher {
  let cb: (() => void) | null = null;
  return {
    version: initialVersion,
    onAnyChange(handler: () => void) { cb = handler; },
    fire() { cb?.(); },
  };
}

function captureHandler(watcher: FakeWatcher): RequestHandler {
  let handler: RequestHandler | null = null;
  const mockApp = {
    get: (path: string, h: RequestHandler) => {
      if (path === '/api/changes') handler = h;
    },
  } as unknown as Express;
  mountChangesStream(mockApp, watcher as unknown as FileWatcher);
  if (!handler) throw new Error('handler not registered');
  return handler;
}

interface MockRes {
  readonly writes: string[];
  readonly statusCode: () => number;
  readonly ended: () => boolean;
  readonly emitClose: () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly raw: any; // the object passed as `res` to the handler
}

function makeReq(opts: { token?: string; lastEventId?: string } = {}): { req: Request; emitClose: () => void } {
  const emitter = new EventEmitter();
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.lastEventId) headers['last-event-id'] = opts.lastEventId;
  const req = Object.assign(emitter, { headers }) as unknown as Request;
  return { req, emitClose: () => emitter.emit('close') };
}

function makeRes(opts: { writeThrows?: boolean } = {}): MockRes {
  const writes: string[] = [];
  let status = 0;
  let ended = false;
  const res = {
    status(n: number) { status = n; return res; },
    set(_h: Record<string, string>) { return res; },
    flushHeaders() {},
    write(chunk: string) {
      if (opts.writeThrows) throw new Error('EPIPE');
      writes.push(chunk);
      return true;
    },
    end() { ended = true; },
  };
  return {
    writes,
    statusCode: () => status,
    ended: () => ended,
    emitClose: () => {},
    raw: res,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('mountChangesStream', () => {
  let watcher: FakeWatcher;
  let handler: RequestHandler;
  let token: string;

  beforeEach(() => {
    watcher = makeWatcher(5);
    handler = captureHandler(watcher);
    token = createSession();
  });

  it('rejects with 401 when no valid session', () => {
    const { req } = makeReq();
    const res = makeRes();
    handler(req, res.raw as Response, vi.fn());
    expect(res.statusCode()).toBe(401);
    expect(res.ended()).toBe(true);
    expect(res.writes).toHaveLength(0);
  });

  it('emits a ready event on connect carrying the current revision', () => {
    const { req } = makeReq({ token });
    const res = makeRes();
    handler(req, res.raw as Response, vi.fn());
    expect(res.writes.join('')).toContain('event: ready\nid: 5\ndata: 5\n\n');
  });

  it('broadcasts a change event when watcher fires onAnyChange', () => {
    const { req } = makeReq({ token });
    const res = makeRes();
    handler(req, res.raw as Response, vi.fn());
    res.writes.length = 0;

    watcher.version = 6;
    watcher.fire();

    expect(res.writes.join('')).toContain('event: change\nid: 6\ndata: 6\n\n');
  });

  it('emits a catchup change event when Last-Event-ID is behind current revision', () => {
    const { req } = makeReq({ token, lastEventId: '2' });
    const res = makeRes();
    handler(req, res.raw as Response, vi.fn());
    const output = res.writes.join('');
    expect(output).toContain('event: ready\nid: 5\ndata: 5\n\n');
    expect(output).toContain('event: change\nid: 5\ndata: 5\n\n');
  });

  it('does not emit catchup when Last-Event-ID matches or exceeds current revision', () => {
    const { req } = makeReq({ token, lastEventId: '5' });
    const res = makeRes();
    handler(req, res.raw as Response, vi.fn());
    const output = res.writes.join('');
    expect(output).toContain('event: ready\n');
    expect(output).not.toContain('event: change\n');
  });

  it('drops clients whose socket throws on write (EPIPE)', () => {
    // First client: healthy
    const good = makeRes();
    handler(makeReq({ token }).req, good.raw as Response, vi.fn());

    // Second client: write throws immediately → never added to the Set
    const dead = makeRes({ writeThrows: true });
    handler(makeReq({ token }).req, dead.raw as Response, vi.fn());

    good.writes.length = 0;

    // Fire: healthy client receives event, dead client doesn't throw/crash us
    watcher.version = 7;
    expect(() => watcher.fire()).not.toThrow();
    expect(good.writes.join('')).toContain('event: change\nid: 7');
  });

  it('removes clients from the broadcast set on req close', () => {
    const { req, emitClose } = makeReq({ token });
    const res = makeRes();
    handler(req, res.raw as Response, vi.fn());
    res.writes.length = 0;

    emitClose();

    watcher.version = 8;
    watcher.fire();
    expect(res.writes).toHaveLength(0);
  });
});
