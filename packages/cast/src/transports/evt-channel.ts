/**
 * Channel extraction from a typed `Evt` union.
 *
 * Pre-I.10, `transports/console.ts` re-derived "which channel does this event
 * scope to?" with a 6-way kind chain (`evt.type === 'typing' || evt.type ===
 * 'typing_stopped' || …`). The discriminated `Evt` union already encodes the
 * channel on each variant's `data` — every event except `approval_stale`
 * carries `data.channel`. This helper consumes the union exhaustively so
 * future event kinds force a compile-time decision about whether they carry
 * a channel.
 */
import type { Evt } from '../types.js';

/**
 * The channel name an event is scoped to, or `undefined` if the event has
 * none. `approval_stale` is the only channel-less variant today — the
 * approval flow lives on `default` semantically, but the variant carries no
 * field for it.
 */
export function channelOf(evt: Evt): string | undefined {
  switch (evt.type) {
    case 'typing':
    case 'typing_stopped':
    case 'lifecycle':
    case 'ui_directive':
    case 'message_received':
      return evt.data.channel;
    case 'approval_stale':
      return undefined;
  }
}
