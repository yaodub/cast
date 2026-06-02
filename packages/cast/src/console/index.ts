/**
 * Agent consoles — authoring surfaces that run Claude inside the agent folder
 * with a scoped mount table and dedicated prompt.
 *
 * Design: blueprint authoring with internet.
 * Configure: ops, users, secrets — sdk-only network.
 * Config Manager: server-scope auditor + intra-surface mutator.
 * Design Manager: server-scope orchestrator, mutates agent set.
 * Security Manager: server-scope finalize auditor + posture advisor.
 *
 * Per-console wiring lives in `console/<name>/strategy.ts` and is registered
 * in `console/registry.ts`. This file holds only the primitives that don't
 * fit inside a strategy (name type, channel prefix, manuals dir resolution).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export type ConsoleName = 'design' | 'configure' | 'config-manager' | 'design-manager' | 'security-manager';

/** Prefix that marks an infrastructure / console channel. */
export const CONSOLE_CHANNEL_PREFIX = '__';

// Public console API — symbols from inside `console/` that other layers
// (notably `agent/`) need. Re-exported here so consumers don't reach into
// per-console subdirs (`console/configure/tools.ts`,
// `console/shared/page-manual.ts`) — keeps the boundary one-way.
export { loadAdminManual } from './shared/page-manual.js';

/** Is this channel name an infrastructure channel (console or otherwise)? */
export function isConsoleChannel(channelName: string): boolean {
  return channelName.startsWith(CONSOLE_CHANNEL_PREFIX);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the path to the cast manuals directory. In dev the manuals live
 * alongside packages/cast/src at packages/cast/manuals; after bundling
 * they're copied next to dist/index.js as dist/manuals.
 *
 * Returns null if manuals aren't on disk — callers should degrade gracefully.
 */
export function resolveManualsDir(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../manuals'), // dev: packages/cast/src/console/ → packages/cast/manuals/
    path.resolve(__dirname, 'manuals'),       // prod: bundled index.js → <outdir>/manuals/
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}
