/**
 * Console strategy registry. The single source of truth for which consoles
 * exist and how they're wired. Adding a new console is a new entry here —
 * never a new branch in shared code.
 */
import { configManagerStrategy } from './config-manager/strategy.js';
import { configureStrategy } from './configure/strategy.js';
import { designStrategy } from './design/strategy.js';
import { designManagerStrategy } from './design-manager/strategy.js';
import { securityManagerStrategy } from './security-manager/strategy.js';
import { CONSOLE_CHANNEL_PREFIX, type ConsoleName } from './index.js';
import type { ConsoleStrategy } from './strategy.js';

export const CONSOLE_REGISTRY: Record<ConsoleName, ConsoleStrategy> = {
  design: designStrategy,
  configure: configureStrategy,
  'config-manager': configManagerStrategy,
  'design-manager': designManagerStrategy,
  'security-manager': securityManagerStrategy,
};

export function getConsoleStrategy(name: ConsoleName): ConsoleStrategy {
  return CONSOLE_REGISTRY[name];
}

export function listConsoleStrategies(): ConsoleStrategy[] {
  return Object.values(CONSOLE_REGISTRY);
}

/** All registered console names. */
export function listConsoleNames(): ConsoleName[] {
  return Object.keys(CONSOLE_REGISTRY) as ConsoleName[];
}

/**
 * Parse a `__<name>`-prefixed channel name into its `ConsoleName`. Returns
 * `null` for unknown names. Registry-driven — adding a new console is just
 * a registry entry, not a new branch here.
 */
export function parseConsoleName(channelName: string): ConsoleName | null {
  if (!channelName.startsWith(CONSOLE_CHANNEL_PREFIX)) return null;
  const name = channelName.slice(CONSOLE_CHANNEL_PREFIX.length);
  const names = Object.keys(CONSOLE_REGISTRY) as string[];
  return names.includes(name) ? (name as ConsoleName) : null;
}
