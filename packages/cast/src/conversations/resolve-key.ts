import type { AgentChannel, ConversationKey } from './types.js';

/**
 * Resolve a deterministic conversation key from channel config and message metadata.
 * Pure function — no side effects.
 *
 * Throws if:
 * - qualifier provided but channel doesn't support sharding
 * - no participant provided
 */
export function resolveConversationKey(
  channelName: string,
  channel: AgentChannel,
  participant?: string,
  qualifier?: string,
): ConversationKey {
  if (qualifier && !channel.use_sharding) {
    throw new Error(`Channel "${channelName}" does not support sharding`);
  }
  if (!participant) {
    throw new Error(`Channel "${channelName}" requires a participant`);
  }

  return {
    channel: channelName,
    participant,
    qualifier: channel.use_sharding && qualifier ? qualifier : null,
  };
}

/** Serialize a ConversationKey to a string for DB storage / lookup. */
export function serializeConversationKey(key: ConversationKey): string {
  const parts = [key.channel];
  if (key.participant !== null) parts.push(key.participant);
  if (key.qualifier !== null) parts.push(key.qualifier);
  return parts.join('|');
}
