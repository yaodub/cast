/**
 * Console mount-table facade. Composes `buildBaseMounts` (shared) with the
 * strategy's `buildMountAdditions` (per-console).
 *
 * Kept as a named export for the `console-mounts.test.ts` smoke test and for
 * any future caller that wants a "give me the full mount table" helper.
 * `ConsoleManager` also composes via this path so the smoke test exercises
 * the real production code.
 */
import { buildBaseMounts } from './base-mounts.js';
import type { ConsoleName } from './index.js';
import { getConsoleStrategy } from './registry.js';
import type { Host } from '../types.js';
import type { VolumeMount } from '../container/container-mounts.js';

export function buildConsoleMounts(
  agent: Host,
  consoleName: ConsoleName,
  conversationKey: string,
): VolumeMount[] {
  const strategy = getConsoleStrategy(consoleName);
  return [
    ...strategy.buildMountAdditions(agent, conversationKey),
    ...buildBaseMounts(agent, conversationKey),
  ];
}
