/**
 * Console transport — owns the `admin:*` handle prefix.
 *
 * The admin HTTP router ingests operator messages with a handle like
 * `admin:<session-prefix>`; `idp.resolve()` short-circuits `admin:*` to
 * the `local` identity sentinel (see `identity.ts` — symmetric with `cli:*`).
 * The trust boundary is the admin server's 127.0.0.1 bind plus an explicit
 * localhost check in the admin chat route — same guarantee CLI has.
 *
 * When the agent replies, the gateway's outbound dispatch
 * (`transports.find(t => t.ownsParticipant(handle))`) picks this transport
 * for any `admin:*` recipient and fans the packet out to subscribed SSE
 * clients matching (agentAddress, channel).
 *
 * SSE-over-HTTP rather than WebSocket because the admin UI already uses the
 * same pattern for `/api/changes` (fetchEventSource with Bearer headers).
 * Keeps the auth model uniform.
 */
import type { AnyPacket } from '../gateway/packets.js';
import type { Evt } from '../types.js';
import { channelOf } from './evt-channel.js';
import type { OutboundContext, Transport } from './schema.js';

export interface ConsoleSseEvent {
  event: string;
  data: unknown;
  /** The channel the event was emitted on. Always set for packets and
   *  channel-scoped events (lifecycle, typing, typing_stopped, ui_directive,
   *  message_received). Wildcard subscribers (`channel: '*'`) need this to
   *  label the outgoing envelope; literal-channel subscribers can ignore it. */
  channel: string;
}

interface Subscriber {
  agentAddress: string;
  /** Channel match: a literal channel name OR the `'*'` wildcard which
   *  matches every channel of `agentAddress`. The wildcard form is used by
   *  the admin event manifest so a single subscription per agent catches
   *  events on user channels (`default`, agent-configured) and infra
   *  channels (`__design`, `__configure`) alike. See
   *  `admin/admin-event-manifest.ts`. */
  channel: string | '*';
  /** Push an SSE event to this subscriber's response stream. */
  push: (e: ConsoleSseEvent) => void;
}

export class ConsoleTransport implements Transport {
  readonly name = 'console';
  /**
   * Best-effort live fan-out. Packets emitted while no admin SSE is currently
   * subscribed are dropped on the floor — there is no replay path. Pairs with
   * the client-owned IndexedDB history model: an admin tab gets a packet iff
   * it was open at the moment of emission.
   *
   * `deferredAck = false` means the gateway calls `markDelivered` immediately
   * after `send()` returns regardless of whether any subscriber actually
   * received the packet. Earlier this was set to `true` with the intent that
   * something would call `drainUndelivered` on subscribe, but no drain was
   * ever wired up — packets accumulated silently in `gateway.db`. Matching
   * the contract to the actual behavior here keeps gateway storage clean as
   * we move toward gateway-as-pure-routing.
   */
  readonly deferredAck = false;

  private subscribers: Subscriber[] = [];

  ownsParticipant(participantAddress: string): boolean {
    return participantAddress.startsWith('admin:');
  }

  async send(pkt: AnyPacket, ctx: OutboundContext): Promise<void> {
    const channel = ctx.channel ?? 'default';
    // Preview packets fan out as a distinct event so the admin UI worker can
    // dispatch them into its previews map (transient, coalesced by streamId)
    // rather than the durable messages array. Durable conversation packets
    // also carry a `streamId` when they terminate a preview stream; we
    // forward it as part of the `packet` event so the worker can seal-clear
    // the matching preview entry.
    const isPreviewText = pkt.type === 'preview' && pkt.kind === 'text';
    for (const sub of this.subscribers) {
      if (sub.agentAddress !== ctx.agentAddress) continue;
      if (sub.channel !== '*' && sub.channel !== channel) continue;
      if (isPreviewText) {
        sub.push({
          event: 'preview',
          data: {
            streamId: pkt.streamId,
            from: pkt.from,
            to: pkt.to,
            text: pkt.text,
            timestamp: pkt.timestamp,
            ...(pkt.final ? { final: true } : {}),
          },
          channel,
        });
        continue;
      }
      const streamId = 'streamId' in pkt && typeof pkt.streamId === 'string' ? pkt.streamId : undefined;
      sub.push({
        event: 'packet',
        data: {
          id: pkt.id ?? null,
          type: pkt.type,
          from: pkt.from,
          to: pkt.to,
          text: pkt.text,
          timestamp: pkt.timestamp,
          ...(streamId ? { streamId } : {}),
        },
        channel,
      });
    }
  }

  async sendEvent(evt: Evt): Promise<void> {
    // Per-channel scoping: lifecycle events also carry a channel since
    // a single agent host can have multiple console subscribers (e.g.
    // `__design` + `__configure`) and a fresh-conversation / bootstrap
    // for one shouldn't cross-fan to the other. `channelOf`
    // consumes the discriminated `Evt` union exhaustively — adding a new
    // event kind forces a compile-time decision there.
    const eventChannel = channelOf(evt);
    for (const sub of this.subscribers) {
      if (sub.agentAddress !== evt.from) continue;
      if (
        eventChannel !== undefined
        && sub.channel !== '*'
        && eventChannel !== sub.channel
      ) continue;
      // Channel-less events (ApprovalStaleEvt) tag themselves as 'default'
      // when sent to a wildcard subscriber — they're broadcast to every
      // literal subscriber today anyway, so the channel label is cosmetic.
      sub.push({
        event: evt.type,
        data: evt.data,
        channel: eventChannel ?? (sub.channel === '*' ? 'default' : sub.channel),
      });
    }
  }

  /** Register an SSE subscriber. Returns a disposer that removes it. Pass
   *  `channel: '*'` to receive packets + events on every channel of
   *  `agentAddress`. See the `Subscriber` jsdoc and `admin-event-manifest.ts`
   *  for usage rationale. */
  subscribe(params: {
    agentAddress: string;
    channel: string | '*';
    push: (e: ConsoleSseEvent) => void;
  }): () => void {
    const entry: Subscriber = {
      agentAddress: params.agentAddress,
      channel: params.channel,
      push: params.push,
    };
    this.subscribers.push(entry);
    return () => {
      this.subscribers = this.subscribers.filter((s) => s !== entry);
    };
  }

  async connect(): Promise<void> {
    // Nothing to start — the HTTP routes own subscription lifecycle.
  }

  async disconnect(): Promise<void> {
    this.subscribers = [];
  }

  isConnected(): boolean {
    return true;
  }
}
