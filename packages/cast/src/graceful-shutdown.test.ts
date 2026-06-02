/**
 * POC: graceful WebSocket close on transport.disconnect().
 *
 * Asserts that calling disconnect() on LocalTransport / WebTransport closes
 * every connected client with WebSocket code 1001 ("going away") and the
 * reason "Server shutting down" — instead of TCP-RST'ing the connection,
 * which is the default `process.exit(0)` behavior.
 *
 * This is the wire-level guarantee that the admin UI and CLI clients can
 * distinguish "server restarting cleanly" from "network error" so they can
 * surface a yellow banner instead of a red one.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'http';
import { AddressInfo } from 'net';
import { WebSocket, WebSocketServer } from 'ws';

import { createLocalTransport } from './transports/local.js';
import { createWebTransport } from './transports/web.js';
import { Bus } from './gateway/bus.js';
import { LocalIdentityProvider } from './auth/identity.js';
import { initGatewayDb, closeGatewayDb } from './gateway/gateway-db.js';
import { MessageGateway } from './gateway/message-gateway.js';
import path from 'path';
import os from 'os';
import fs from 'fs';

// ---- shared helpers ----

interface Harness {
  http: HttpServer;
  port: number;
  cleanup: () => Promise<void>;
}

async function spinUpHttpServer(): Promise<Harness> {
  const http = createServer();
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    http,
    port,
    cleanup: () =>
      new Promise<void>((resolve) => {
        http.close(() => resolve());
      }),
  };
}

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cast-shutdown-test-'));
}

function connectAndAwaitOpen(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function awaitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reasonBuf) => {
      resolve({ code, reason: reasonBuf.toString('utf8') });
    });
  });
}

describe('graceful shutdown — WebSocket close frame', () => {
  let harness: Harness | null = null;
  let dbPath: string | null = null;

  afterEach(async () => {
    if (harness) {
      await harness.cleanup();
      harness = null;
    }
    if (dbPath) {
      try { closeGatewayDb(); } catch { /* may not be open */ }
      try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
      dbPath = null;
    }
  });

  it('LocalTransport.disconnect() closes all clients with code 1001 + reason', async () => {
    harness = await spinUpHttpServer();
    const dir = tmpdir();
    dbPath = path.join(dir, 'gateway.db');

    const wss = new WebSocketServer({ noServer: true });
    harness.http.on('upgrade', (req, socket, head) => {
      if (req.url === '/cli') {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      } else {
        socket.destroy();
      }
    });

    const bus = new Bus();
    const idp = new LocalIdentityProvider(path.join(dir, 'idp.db'));
    initGatewayDb();
    const gateway = new MessageGateway({ bus, transports: () => [], identityProvider: idp });

    const { transport } = createLocalTransport({ gateway, bus, wss, idp });

    const client = await connectAndAwaitOpen(`ws://127.0.0.1:${harness.port}/cli`);
    const closed = awaitClose(client);

    await transport.disconnect();

    const result = await closed;
    expect(result.code).toBe(1001);
    expect(result.reason).toBe('Server shutting down');

    wss.close();
    idp.close();
  });

  it('WebTransport.disconnect() closes all clients with code 1001 + reason', async () => {
    harness = await spinUpHttpServer();
    const dir = tmpdir();
    dbPath = path.join(dir, 'gateway.db');

    const wss = new WebSocketServer({ noServer: true });
    harness.http.on('upgrade', (req, socket, head) => {
      if (req.url?.startsWith('/web')) {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      } else {
        socket.destroy();
      }
    });

    const bus = new Bus();
    const idp = new LocalIdentityProvider(path.join(dir, 'idp.db'));
    initGatewayDb();
    const gateway = new MessageGateway({ bus, transports: () => [], identityProvider: idp });

    const transport = createWebTransport({ gateway, bus, idp, wss });

    // WebTransport tracks clients only after auth. Skip the auth handshake by
    // manually injecting a fake client into the transport's clients set —
    // good enough for the close-code POC; the auth surface isn't what's
    // under test here.
    const ws = await connectAndAwaitOpen(`ws://127.0.0.1:${harness.port}/web`);
    // Reach into the transport to add the live socket — POC test depth, not
    // production wiring. The structural cast keeps the test compile-only
    // dependent on the field name shape.
    const internal = transport as unknown as { clients: Set<{ ws: WebSocket }> };
    internal.clients.add({ ws });

    const closed = awaitClose(ws);
    await transport.disconnect();

    const result = await closed;
    expect(result.code).toBe(1001);
    expect(result.reason).toBe('Server shutting down');

    wss.close();
    idp.close();
  });
});
