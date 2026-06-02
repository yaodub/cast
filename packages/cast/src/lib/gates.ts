/**
 * Process-wide concurrency primitives (singleton).
 *
 * One `slotPool` covers user channels (AgentManager), console authoring
 * (ConsoleManager), and server-scope consoles (DM / CM / SM). Slot pressure
 * resolves by paging across all conversations (cross-scope LRU
 * swap-eviction inside `ConversationCatalog`).
 *
 * Lives in `lib/` rather than `agent/` because both AgentManager and
 * ConsoleManager need to import this without one reaching across into the
 * other's module — keeps the agent ↔ console layer cycle-free.
 */
import { MAX_CONCURRENT_CONTAINERS } from '../config.js';
import {
  SlotPool,
  ConversationTtl,
  ConversationCatalog,
  ConversationEventBus,
  ConversationsImpl,
  type Conversations,
} from '../conversations/index.js';
import { _resetPanicRegistryForTest } from './panic-registry.js';

export const slotPool = new SlotPool(MAX_CONCURRENT_CONTAINERS);
const conversationTtl = new ConversationTtl();
const conversationEventBus = new ConversationEventBus();
const conversationCatalog = new ConversationCatalog({
  pool: slotPool,
  ttl: conversationTtl,
  eventBus: conversationEventBus,
});
export const conversations: Conversations = new ConversationsImpl({
  catalog: conversationCatalog,
  ttl: conversationTtl,
  eventBus: conversationEventBus,
});

/** Test-only: reset the conversations singleton (scope bindings, catalog,
 *  pool, TTL timers) AND the panic registry (halts + spawn-rate buffers).
 *  Both are process-wide singletons; tests that exercise spawn cycles need
 *  both reset to avoid bleed between cases. Called from `beforeEach` in
 *  suites that construct fresh AgentManagers per test. */
export function _resetConversationsForTest(): void {
  (conversations as ConversationsImpl)._reset();
  _resetPanicRegistryForTest();
}
