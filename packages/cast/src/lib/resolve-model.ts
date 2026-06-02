/**
 * resolveModel — pick the Claude model for a given spawn context.
 *
 * Resolution order:
 *   1. Walk `config.modelOverrides`, filter to entries whose specified
 *      dimensions match the context; pick highest specificity.
 *   2. Fall back to top-level `config.model`.
 *   3. If neither matches, return undefined (SDK default applies downstream).
 *
 * Schema-enforced invariants this code relies on:
 *   - Every entry has `channel` (required).
 *   - `(channel, phase)` pairs are unique within the array.
 * So no runtime tie-breaking is needed — collisions are statically rejected.
 */
import type { AgentConfig, ModelOverrideEntry } from '@getcast/agent-schema/v1';
import { logger } from '../logger.js';

export interface ModelResolveContext {
  channelName?: string;
  phase?: 'bootstrap' | 'cleanup';
}

export function resolveModel(
  config: AgentConfig,
  ctx: ModelResolveContext,
): string | undefined {
  const overrides = config.modelOverrides ?? [];
  let best: { entry: ModelOverrideEntry; score: number } | null = null;
  for (const entry of overrides) {
    if (entry.channel !== ctx.channelName) continue;
    let score = 1;
    if (entry.phase !== undefined) {
      if (entry.phase !== ctx.phase) continue;
      score = 2;
    }
    if (!best || score > best.score) best = { entry, score };
  }
  if (best) {
    logger.info(
      { channelName: ctx.channelName, phase: ctx.phase, model: best.entry.model },
      'modelOverride fired',
    );
    return best.entry.model;
  }
  return config.model;
}
