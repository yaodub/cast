/**
 * Public barrel for the conversation model.
 *
 * External callers reach the new machinery exclusively through `Conversations`.
 * Internal types are re-exported for tests and the host-side wiring; the
 * concrete `Conversation` / `ConversationCatalog` classes are also exported
 * because the wiring layer (`lib/gates.ts` glue) builds them
 * directly.
 */

export type {
  AgentChannel,
  ChannelJsonConfig,
  ChannelsConfig,
  ConversationKey,
  ConversationState,
  ConversationPhase,
  IdleTimeoutMeta,
  ExpirableConversation,
} from './types.js';

export {
  ChannelJsonSchema,
  DEFAULT_CHANNEL,
  DEFAULT_CHANNEL_JSON,
  DEFAULT_CHANNEL_NAME,
  DEFAULT_IDLE_TIMEOUT_MS,
  MAX_IDLE_TIMEOUT_MS,
} from './types.js';

export { SlotPool, type Slot } from './slot-pool.js';
export { ConversationTtl } from './ttl.js';

export {
  ConversationEventBus,
  type ConversationEvent,
  type ConversationEventKind,
  type SubscriptionFilter,
} from './event-bus.js';

// `Conversation` is exposed as a *type* only — external consumers interact
// via the `Conversations` façade and the `ConversationView` handle. Tests
// that construct a Conversation directly import from `./conversation.js`.
export type {
  BuildSpawnHooks,
  Conversation,
  ConversationCatalogRef,
  ConversationOpts,
  ConversationView,
  DeliverOpts,
} from './conversation.js';

export {
  ConversationCatalog,
  type ConversationCatalogOpts,
  type ConversationFactoryOpts,
  type SlotResult,
} from './catalog.js';

export {
  ConversationsImpl,
  type Conversations,
  type ConversationScopeBinding,
  type ConversationScopeHandlers,
} from './facade.js';

export type {
  Runner,
  RunnerFactory,
  RunnerConstructionOpts,
  SpawnOutcome,
  SpawnHooks,
  PendingMessage,
  DeliverKind,
} from './runner.js';

