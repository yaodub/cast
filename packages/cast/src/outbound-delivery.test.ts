/**
 * Outbound delivery worker — retry, TTL expiry, ordering, deferred-ack.
 *
 * Exercises the gateway's single drain implementation (`drainRecipientPending`)
 * through its three public entry points: live sends (`deliverOutbound`),
 * worker passes (`runDeliveryPass`), and reconnect nudges (`nudgeRecipient`).
 * The transport is a controllable fake; time travels via vi.setSystemTime.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  OUTBOUND_ACK_REDUE_MS,
  OUTBOUND_DELIVERY_TTL_MS,
  OUTBOUND_RETRY_BACKOFF_MS,
} from './config.js';
import { LocalIdentityProvider } from './auth/identity.js';
import { Bus } from './gateway/bus.js';
import {
  _initTestGatewayDb,
  getPacketHistory,
  getPendingOutboundForRecipient,
  markDeliveredIfAddressedTo,
  storePacket,
} from './gateway/gateway-db.js';
import { MessageGateway } from './gateway/message-gateway.js';
import { conversationPkt } from './gateway/packets.js';
import type { AnyPacket } from './gateway/packets.js';
import type { Transport } from './transports/schema.js';

const AGENT = 'a:agent1@test';
const USER = 'cli:u1';

interface FakeTransport {
  transport: Transport;
  /** Texts of successfully sent conversation packets, in send order. */
  sent: string[];
  /** While true, every send throws. */
  setFailing(failing: boolean): void;
}

function makeTransport(opts?: { deferredAck?: boolean }): FakeTransport {
  const sent: string[] = [];
  let failing = false;
  const transport: Transport = {
    name: 'test',
    deferredAck: opts?.deferredAck ?? false,
    send: async (pkt: AnyPacket) => {
      if (failing) throw new Error('transport down');
      if (pkt.type === 'conversation') sent.push(pkt.text);
    },
    sendEvent: async () => {},
    ownsParticipant: () => true,
    isConnected: () => true,
    connect: async () => {},
    disconnect: async () => {},
  };
  return { transport, sent, setFailing: (f) => { failing = f; } };
}

function makeGateway(fake: FakeTransport): MessageGateway {
  return new MessageGateway({
    bus: new Bus(),
    transports: () => [fake.transport],
    identityProvider: LocalIdentityProvider._createTest(),
  });
}

/** Insert a pending outbound row as a previous process lifetime would have left it. */
function insertPending(id: string, text: string, ageMs: number): void {
  const ts = new Date(Date.now() - ageMs).toISOString();
  storePacket(id, conversationPkt(AGENT, USER, text, undefined, ts, undefined, id), 'outbound');
}

function pendingTexts(): string[] {
  return getPendingOutboundForRecipient(USER).map((p) => {
    const payload = JSON.parse(p.payload) as { text: string };
    return payload.text;
  });
}

describe('outbound delivery', () => {
  beforeEach(() => {
    _initTestGatewayDb();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('delivers a live outbound and marks it delivered', async () => {
    const fake = makeTransport();
    const gw = makeGateway(fake);

    await gw.deliverOutbound(conversationPkt(AGENT, USER, 'hello'));

    expect(fake.sent).toEqual(['hello']);
    expect(pendingTexts()).toEqual([]);
  });

  it('keeps a failed send pending and delivers it on a later pass, after backoff', async () => {
    const fake = makeTransport();
    const gw = makeGateway(fake);

    fake.setFailing(true);
    await gw.deliverOutbound(conversationPkt(AGENT, USER, 'lost'));
    expect(fake.sent).toEqual([]);
    expect(pendingTexts()).toEqual(['lost']);

    // Transport heals, but the packet isn't due yet — the pass must not retry early.
    fake.setFailing(false);
    await gw.runDeliveryPass();
    expect(fake.sent).toEqual([]);

    vi.setSystemTime(Date.now() + (OUTBOUND_RETRY_BACKOFF_MS[0] ?? 0) + 1);
    await gw.runDeliveryPass();
    expect(fake.sent).toEqual(['lost']);
    expect(pendingTexts()).toEqual([]);
  });

  it('drains older failed packets before a new live send, preserving order', async () => {
    const fake = makeTransport();
    const gw = makeGateway(fake);

    fake.setFailing(true);
    await gw.deliverOutbound(conversationPkt(AGENT, USER, 'first'));
    expect(pendingTexts()).toEqual(['first']);

    // The next live send is evidence the wire is worth retrying now — the
    // backlog drains ahead of the new packet, in timestamp order.
    fake.setFailing(false);
    vi.setSystemTime(Date.now() + 1000);
    await gw.deliverOutbound(conversationPkt(AGENT, USER, 'second'));
    expect(fake.sent).toEqual(['first', 'second']);
    expect(pendingTexts()).toEqual([]);
  });

  it('stops the drain at the first undeliverable packet so later ones wait behind it', async () => {
    const fake = makeTransport();
    const gw = makeGateway(fake);

    insertPending('pkt-a', 'a', 2000);
    insertPending('pkt-b', 'b', 1000);

    fake.setFailing(true);
    await gw.runDeliveryPass();
    expect(fake.sent).toEqual([]);
    // Both still pending — 'b' was never attempted out of order.
    expect(pendingTexts()).toEqual(['a', 'b']);

    fake.setFailing(false);
    await gw.nudgeRecipient(USER);
    expect(fake.sent).toEqual(['a', 'b']);
  });

  it('expires packets older than the TTL as failed instead of delivering them', async () => {
    const fake = makeTransport();
    const gw = makeGateway(fake);

    insertPending('pkt-old', 'stale', OUTBOUND_DELIVERY_TTL_MS + 60_000);
    insertPending('pkt-young', 'fresh', 60_000);

    await gw.runDeliveryPass();

    // The stale packet was never sent; the fresh one delivered.
    expect(fake.sent).toEqual(['fresh']);
    expect(pendingTexts()).toEqual([]);
    const history = getPacketHistory(AGENT, USER);
    const stale = history.find((p) => p.id === 'pkt-old');
    const fresh = history.find((p) => p.id === 'pkt-young');
    expect(stale?.failed_at).not.toBeNull();
    expect(stale?.delivered_at).toBeNull();
    expect(fresh?.delivered_at).not.toBeNull();
    expect(fresh?.failed_at).toBeNull();
  });

  it('keeps deferred-ack sends pending until the client acks', async () => {
    const fake = makeTransport({ deferredAck: true });
    const gw = makeGateway(fake);

    await gw.deliverOutbound(conversationPkt(AGENT, USER, 'to-web'));
    expect(fake.sent).toEqual(['to-web']);
    // Sent but not delivered — only the client ack marks it.
    const pending = getPendingOutboundForRecipient(USER);
    expect(pending).toHaveLength(1);
    const pktId = pending[0]?.id ?? '';

    // Forged ack (wrong recipient) must not mark.
    expect(markDeliveredIfAddressedTo(pktId, 'cli:intruder')).toBe(false);
    expect(getPendingOutboundForRecipient(USER)).toHaveLength(1);

    // Real ack clears it.
    expect(markDeliveredIfAddressedTo(pktId, USER)).toBe(true);
    expect(getPendingOutboundForRecipient(USER)).toHaveLength(0);
  });

  it('re-sends an unacked deferred-ack packet after the redue window', async () => {
    const fake = makeTransport({ deferredAck: true });
    const gw = makeGateway(fake);

    await gw.deliverOutbound(conversationPkt(AGENT, USER, 'unacked'));
    expect(fake.sent).toEqual(['unacked']);

    // Within the redue window: no re-send.
    await gw.runDeliveryPass();
    expect(fake.sent).toEqual(['unacked']);

    // Past it: re-sent (the web client dedups by packet id and re-acks).
    vi.setSystemTime(Date.now() + OUTBOUND_ACK_REDUE_MS + 1);
    await gw.runDeliveryPass();
    expect(fake.sent).toEqual(['unacked', 'unacked']);
  });

  it('marks unparseable payloads failed instead of stalling the drain', async () => {
    const fake = makeTransport();
    const gw = makeGateway(fake);

    // Deliberately malformed boundary data — a payload that no longer parses
    // against AnyPacketSchema. The cast is the point of the test.
    storePacket('pkt-poison', { type: 'bogus', from: AGENT, to: USER, timestamp: new Date().toISOString() } as unknown as Parameters<typeof storePacket>[1], 'outbound');
    insertPending('pkt-good', 'after-poison', 0);

    await gw.runDeliveryPass();

    expect(fake.sent).toEqual(['after-poison']);
    expect(getPendingOutboundForRecipient(USER)).toHaveLength(0);
    const poison = getPacketHistory(AGENT, USER).find((p) => p.id === 'pkt-poison');
    expect(poison?.failed_at).not.toBeNull();
  });

  it('boot pass delivers packets left pending by a previous process lifetime', async () => {
    const fake = makeTransport();
    const gw = makeGateway(fake);

    insertPending('pkt-1', 'from-last-life', 30_000);

    gw.startDeliveryWorker();
    await vi.advanceTimersByTimeAsync(0); // flush the immediate first pass
    gw.stopDeliveryWorker();

    expect(fake.sent).toEqual(['from-last-life']);
    expect(pendingTexts()).toEqual([]);
  });
});
