/**
 * ConversationTtl — per-conversation idle-timeout timers.
 *
 * Notable properties:
 *
 * - **Keyed by Conversation reference, not by string key.** A destroyed
 *   Conversation has its timer cancelled at destroy time — no stale-key drift
 *   class. This is the structural fix for the audit-finding bug where TTL
 *   ownership keyed by `scopedKey` died with the slot.
 * - **No ccSessionId or lifecycle persistence concerns.** Those live on the
 *   Conversation class and the underlying state-store. TTL is purely about
 *   timer scheduling and the cleanup-call-on-fire.
 *
 * On timer fire, calls `conv.expire(meta.cleanup ?? null)`. The Conversation's
 * state machine handles cleanup-turn semantics; TTL doesn't know how cleanup
 * works.
 */
import type { ExpirableConversation, IdleTimeoutMeta } from './types.js';
import { logger } from '../logger.js';

interface TimerEntry {
  timer: NodeJS.Timeout;
  meta: IdleTimeoutMeta;
}

export class ConversationTtl {
  private timers = new Map<ExpirableConversation, TimerEntry>();

  /**
   * Install or replace the TTL timer for `conv`. On expiry, calls
   * `conv.expire(meta.cleanup ?? null)`. The timer survives runner death by
   * construction: there is no slot-bound state to lose.
   */
  scheduleTtl(conv: ExpirableConversation, meta: IdleTimeoutMeta, delayMs: number): void {
    this.cancelTtl(conv);
    const timer = setTimeout(() => {
      this.timers.delete(conv);
      void this.fire(conv, meta);
    }, delayMs);
    // Don't block process exit on a pending TTL.
    timer.unref();
    this.timers.set(conv, { timer, meta });
  }

  /** Clear the timer for `conv`. No-op if none installed. */
  cancelTtl(conv: ExpirableConversation): void {
    const entry = this.timers.get(conv);
    if (entry) {
      clearTimeout(entry.timer);
      this.timers.delete(conv);
    }
  }

  /** Snapshot current meta without disturbing the timer. */
  peekMeta(conv: ExpirableConversation): IdleTimeoutMeta | undefined {
    return this.timers.get(conv)?.meta;
  }

  /** Whether a timer is scheduled. */
  hasTimer(conv: ExpirableConversation): boolean {
    return this.timers.has(conv);
  }

  /**
   * Cancel all timers in `scope`. Called by `Conversations.shutdownScope`
   * when an agent or console folder unmounts.
   */
  shutdownScope(scope: string): void {
    for (const [conv, entry] of this.timers) {
      if (conv.scope === scope) {
        clearTimeout(entry.timer);
        this.timers.delete(conv);
      }
    }
  }

  /** Cancel all timers. Called on process shutdown. */
  shutdown(): void {
    for (const entry of this.timers.values()) clearTimeout(entry.timer);
    this.timers.clear();
  }

  /** Test-only reset. */
  _reset(): void {
    this.shutdown();
  }

  private async fire(conv: ExpirableConversation, meta: IdleTimeoutMeta): Promise<void> {
    try {
      await conv.expire(meta.cleanup ?? null);
    } catch (err) {
      logger.error(
        { scope: conv.scope, conversationKey: conv.key, err },
        'ConversationTtl: conv.expire threw on timer fire',
      );
    }
  }
}
