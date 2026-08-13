/**
 * WatchManager tests — the intent-cell return contract.
 *
 * This is the purest extension↔Cast seam in the package: no library protocol is
 * under test, only whether a fire returns to the cell that asked, carrying the
 * binding the host stamped. Events are hand-fired; `deliver` is a spy.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { STATUS_INBOUND, STATUS_SENDING, STATUS_RCS_DELIVERED } from 'gmessages';
import type { ClientEvent, InboundMessage } from 'gmessages';
import { noopLogger } from '@getcast/extension-schema';
import type { ToolCallContext } from '@getcast/extension-schema';

import { WatchManager } from './watch-manager.js';
import { GmessagesConfigSchema, type GmessagesConfig } from './schemas.js';
import type { ConversationView } from './resolver.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VIEW: ConversationView = {
  conversationId: 'c1',
  label: 'Alice Chen',
  kind: 'rcs',
  participants: ['Alice Chen'],
  isGroup: false,
};

function message(over: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: 'm1',
    conversationId: 'c1',
    participantId: 'them',
    text: 'ping',
    // Must be NEWER than the watch's creation mark, or the replay guard correctly drops it. A zero
    // here silently made every fixture "older than the watch" and nothing delivered.
    timestampMicros: BigInt(Date.now()) * 1000n + 1_000_000n,
    // Inbound by default: the direction filter tests this, so a fixture without it is invisible.
    statusCode: STATUS_INBOUND,
    statusLabel: null,
    reactions: [],
    attachments: [],
    ...over,
  };
}

/**
 * `messagesOf` is the library's decoder; the manager calls it on `event.update`.
 * Faking the module lets a test hand-fire a decoded message without building a
 * protobuf — the decoder is the library's business, not this seam's.
 */
vi.mock('gmessages', async (orig) => {
  // Only `messagesOf` is faked — decoding a real push is the library's business, not this seam's.
  // The tracker and the status constant are the REAL ones, because their exact behaviour (collapsing
  // repeats, and which code counts as inbound) is precisely what these tests are asserting.
  const actual = await orig<typeof import('gmessages')>();
  return {
    ...actual,
    messagesOf: (update: unknown) => (update as { messages: InboundMessage[] }).messages,
  };
});

const pushOf = (...messages: InboundMessage[]): ClientEvent =>
  ({ kind: 'push', update: { messages } }) as unknown as ClientEvent;

const cell = (participant: string, channel?: string): ToolCallContext =>
  ({ participant, channel }) as ToolCallContext;

// ---------------------------------------------------------------------------

describe('WatchManager', () => {
  let dir: string;
  let deliver: ReturnType<typeof vi.fn>;

  function make(config: Partial<GmessagesConfig> = {}, resolveTo: ConversationView | 'ambiguous' | null = VIEW) {
    const mgr = new WatchManager({
      privateDir: dir,
      deliver: deliver as never,
      log: noopLogger,
      config: GmessagesConfigSchema.parse(config),
      resolve: async () =>
        resolveTo === 'ambiguous'
          ? { ambiguous: [VIEW, { ...VIEW, conversationId: 'c9', label: 'Alice Wong' }] }
          : resolveTo
            ? { match: resolveTo }
            : {},
      ownParticipantId: () => 'me',
    });
    mgr.start();
    return mgr;
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-watch-'));
    deliver = vi.fn(async () => ({ ok: true, result: null }));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // -------------------------------------------------------------------------

  describe('binding capture', () => {
    it('stores the calling cell and echoes BOTH halves on delivery', async () => {
      const mgr = make();
      await mgr.handleWatch({ chat: 'Alice', instructions: 'summarise' }, cell('user:yao', 'sms'));

      mgr.onEvent(pushOf(message()));
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));

      const [text, opts] = deliver.mock.calls[0]!;
      expect(opts).toEqual({ replyTo: 'user:yao', channel: 'sms' });
      expect(text).toContain('Alice Chen');
      expect(text).toContain('ping');
      expect(text).toContain('Watch instructions: summarise');
    });

    it('refuses to create a watch with no participant context', async () => {
      const mgr = make();
      const res = await mgr.handleWatch({ chat: 'Alice', instructions: 'x' }, {} as ToolCallContext);
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('conversation context');
    });

    it('requires instructions', async () => {
      const mgr = make();
      const res = await mgr.handleWatch({ chat: 'Alice' }, cell('user:yao', 'sms'));
      expect(res.isError).toBe(true);
    });

    it('surfaces ambiguity instead of guessing a conversation', async () => {
      const mgr = make({}, 'ambiguous');
      const res = await mgr.handleWatch({ chat: 'Alice', instructions: 'x' }, cell('user:yao', 'sms'));
      expect(res.isError).toBe(true);
      expect(res.content[0]!.text).toContain('Multiple conversations match');
    });
  });

  describe('delivery filtering', () => {
    it('ignores this account’s own sends, whichever device they came from', async () => {
      // Direction is read from the STATUS, not the participant id: a message typed on the paired
      // handset carries that conversation's participant id, which never matches this device's, so
      // `isOwnMessage` alone let every outgoing message notify the agent.
      const mgr = make();
      await mgr.handleWatch({ chat: 'Alice', instructions: 'x' }, cell('user:yao', 'sms'));
      mgr.onEvent(pushOf(message({ statusCode: STATUS_SENDING, participantId: 'phone' })));
      await new Promise((r) => setTimeout(r, 10));
      expect(deliver).not.toHaveBeenCalled();
    });

    it('stays silent through a send’s whole status progression', async () => {
      // The reported symptom: one outgoing message notified three times, because the relay pushes
      // it again at each step of sending → handed off → delivered.
      const mgr = make();
      await mgr.handleWatch({ chat: 'Alice', instructions: 'x' }, cell('user:yao', 'sms'));
      for (const statusCode of [STATUS_SENDING, 1, STATUS_RCS_DELIVERED]) {
        mgr.onEvent(pushOf(message({ messageId: 'out1', statusCode })));
      }
      await new Promise((r) => setTimeout(r, 10));
      expect(deliver).not.toHaveBeenCalled();
    });

    it('delivers an inbound message ONCE even when its push repeats', async () => {
      const mgr = make();
      await mgr.handleWatch({ chat: 'Alice', instructions: 'x' }, cell('user:yao', 'sms'));
      // Same id, same status, three pushes — a batch can carry a repeat.
      mgr.onEvent(pushOf(message({ messageId: 'in1' })));
      mgr.onEvent(pushOf(message({ messageId: 'in1' })));
      mgr.onEvent(pushOf(message({ messageId: 'in1' }), message({ messageId: 'in1' })));
      await new Promise((r) => setTimeout(r, 10));
      expect(deliver).toHaveBeenCalledTimes(1);
    });

    it('delivers distinct inbound messages separately', async () => {
      const mgr = make();
      await mgr.handleWatch({ chat: 'Alice', instructions: 'x' }, cell('user:yao', 'sms'));
      mgr.onEvent(pushOf(message({ messageId: 'in1', text: 'first' }), message({ messageId: 'in2', text: 'second' })));
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(2));
    });

    it('ignores an unrecognised status rather than announcing it', async () => {
      // Positive filtering: a code we cannot classify is treated as not-inbound, so a watch stays
      // quiet instead of reporting something the user may in fact have sent.
      const mgr = make();
      await mgr.handleWatch({ chat: 'Alice', instructions: 'x' }, cell('user:yao', 'sms'));
      mgr.onEvent(pushOf(message({ statusCode: 12345 })));
      await new Promise((r) => setTimeout(r, 10));
      expect(deliver).not.toHaveBeenCalled();
    });

    it('ignores messages for other conversations', async () => {
      const mgr = make();
      await mgr.handleWatch({ chat: 'Alice', instructions: 'x' }, cell('user:yao', 'sms'));
      mgr.onEvent(pushOf(message({ conversationId: 'other' })));
      await new Promise((r) => setTimeout(r, 10));
      expect(deliver).not.toHaveBeenCalled();
    });

    it('ignores non-push events', async () => {
      const mgr = make();
      await mgr.handleWatch({ chat: 'Alice', instructions: 'x' }, cell('user:yao', 'sms'));
      mgr.onEvent({ kind: 'response' } as unknown as ClientEvent);
      await new Promise((r) => setTimeout(r, 10));
      expect(deliver).not.toHaveBeenCalled();
    });

    it('does not deliver from a deny-listed conversation', async () => {
      const mgr = make({ chats: { c1: { read: 'deny' } } });
      // Creation is blocked too, but assert the fire path independently.
      const res = await mgr.handleWatch({ chat: 'Alice', instructions: 'x' }, cell('user:yao', 'sms'));
      expect(res.isError).toBe(true);
      mgr.onEvent(pushOf(message()));
      await new Promise((r) => setTimeout(r, 10));
      expect(deliver).not.toHaveBeenCalled();
    });

    it('still delivers under approval mode — installing the watch was the approval', async () => {
      const mgr = make({ read_mode: 'approval' });
      await mgr.handleWatch({ chat: 'Alice', instructions: 'x' }, cell('user:yao', 'sms'));
      mgr.onEvent(pushOf(message()));
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    });

    it('survives a rejecting deliver without throwing', async () => {
      deliver.mockRejectedValue(new Error('channel gone'));
      const mgr = make();
      await mgr.handleWatch({ chat: 'Alice', instructions: 'x' }, cell('user:yao', 'sms'));
      expect(() => mgr.onEvent(pushOf(message()))).not.toThrow();
      await new Promise((r) => setTimeout(r, 10));
    });
  });

  describe('ownership — list and unwatch are cell-scoped', () => {
    it('hides and protects another cell’s watches', async () => {
      const mgr = make();
      await mgr.handleWatch({ chat: 'Alice', instructions: 'x', id: 'w1' }, cell('user:alice', 'sms'));

      const other = cell('user:bob', 'sms');
      expect(mgr.handleListWatches(other).content[0]!.text).toContain('No active watches');
      // Same message as a genuinely missing id: existence is not an oracle.
      expect(mgr.handleUnwatch({ id: 'w1' }, other).content[0]!.text).toBe('Watch "w1" not found.');
      // And the id cannot be hijacked by re-creating it.
      const taken = await mgr.handleWatch({ chat: 'Alice', instructions: 'y', id: 'w1' }, other);
      expect(taken.isError).toBe(true);
      expect(taken.content[0]!.text).toContain('already in use');
    });

    it('lets the owning cell list and remove its own', async () => {
      const mgr = make();
      const owner = cell('user:alice', 'sms');
      await mgr.handleWatch({ chat: 'Alice', instructions: 'x', id: 'w1' }, owner);
      expect(mgr.handleListWatches(owner).content[0]!.text).toContain('w1');
      expect(mgr.handleUnwatch({ id: 'w1' }, owner).content[0]!.text).toBe('Watch "w1" removed.');
      expect(mgr.handleListWatches(owner).content[0]!.text).toContain('No active watches');
    });

    it('lets an operator cell see every watch', async () => {
      const mgr = make();
      await mgr.handleWatch({ chat: 'Alice', instructions: 'x', id: 'w1' }, cell('user:alice', 'sms'));
      // `ownsBinding` grants the cli:/admin: operator tier god-mode.
      expect(mgr.handleListWatches(cell('cli:root')).content[0]!.text).toContain('w1');
    });
  });

  describe('replay across a restart', () => {
    // The bug that actually reached a user: the relay re-sends recent messages when the stream
    // reconnects, and the in-memory tracker starts empty in a new process — so every restart
    // re-announced the same messages. Six restarts produced six replay bursts, ~1s after each.
    // Relative to WHEN IT IS CALLED — a constant captured at module load drifts behind the watch's
    // own creation mark once a few slow tests have run, and every fixture silently becomes "history".
    const after = (seconds: number) => BigInt(Date.now()) * 1000n + BigInt(seconds) * 1_000_000n;

    it('does not re-announce messages a previous process already delivered', async () => {
      const first = make();
      await first.handleWatch({ chat: 'Alice', instructions: 'x' }, cell('user:yao', 'sms'));
      first.onEvent(pushOf(message({ messageId: 'in1', timestampMicros: after(1) })));
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));

      // A new process: fresh manager, fresh tracker, same watches.json — then the relay replays.
      deliver.mockClear();
      const revived = make();
      revived.onEvent(pushOf(message({ messageId: 'in1', timestampMicros: after(1) })));
      await new Promise((r) => setTimeout(r, 10));
      expect(deliver).not.toHaveBeenCalled();
    });

    it('still delivers a genuinely newer message after a restart', async () => {
      const first = make();
      await first.handleWatch({ chat: 'Alice', instructions: 'x' }, cell('user:yao', 'sms'));
      first.onEvent(pushOf(message({ messageId: 'in1', timestampMicros: after(1) })));
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));

      deliver.mockClear();
      const revived = make();
      revived.onEvent(
        pushOf(
          message({ messageId: 'in1', timestampMicros: after(1) }), // replayed
          message({ messageId: 'in2', timestampMicros: after(2), text: 'new' }), // actually new
        ),
      );
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      expect(deliver.mock.calls[0]![0]).toContain('new');
    });

    it('a new watch does not announce the thread’s existing history', async () => {
      const mgr = make();
      await mgr.handleWatch({ chat: 'Alice', instructions: 'x' }, cell('user:yao', 'sms'));
      // Older than the watch — it is not news to a watch that did not exist yet.
      mgr.onEvent(pushOf(message({ messageId: 'old', timestampMicros: BigInt(Date.now()) * 1000n - 60_000_000n })));
      await new Promise((r) => setTimeout(r, 10));
      expect(deliver).not.toHaveBeenCalled();
    });

    it('carries the message id, so a recipient can tell new from redelivered', async () => {
      const mgr = make();
      await mgr.handleWatch({ chat: 'Alice', instructions: 'x' }, cell('user:yao', 'sms'));
      mgr.onEvent(pushOf(message({ messageId: 'in9', timestampMicros: after(1) })));
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      expect(deliver.mock.calls[0]![0]).toContain('Message id: in9');
    });
  });

  describe('persistence', () => {
    it('reloads watches across a restart and keeps delivering to the stored binding', async () => {
      const first = make();
      await first.handleWatch({ chat: 'Alice', instructions: 'keep' }, cell('user:yao', 'sms'));
      expect(fs.existsSync(path.join(dir, 'watches.json'))).toBe(true);

      const revived = make();
      revived.onEvent(pushOf(message()));
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
      expect(deliver.mock.calls[0]![1]).toEqual({ replyTo: 'user:yao', channel: 'sms' });
    });

    it('ignores a corrupt watches file rather than failing to start', () => {
      fs.writeFileSync(path.join(dir, 'watches.json'), 'not json');
      expect(() => make()).not.toThrow();
    });
  });
});
