/**
 * Default Cast data locations.
 *
 * Cast stores agents and config under ~/.cast/ by default, decoupled from
 * the source repo so updates and clones never touch user data. Override
 * with CAST_AGENTS_DIR / CAST_CONFIG_DIR env vars (single source of truth
 * for "where does an instance's data live"); the wrapper scripts here are
 * the only place that resolves the default — packages/cast/src/env.ts
 * keeps the env vars required.
 *
 * The agent-kit CLI duplicates these two constants (packages/agent-kit/
 * src/paths.ts) rather than importing from scripts/, to avoid coupling
 * the package to a script. Keep them in lockstep.
 */
import { homedir } from 'os';
import path from 'path';

const DEFAULT_ROOT = path.join(homedir(), '.cast');

export const DEFAULT_AGENTS_DIR = path.join(DEFAULT_ROOT, 'agents');
export const DEFAULT_CONFIG_DIR = path.join(DEFAULT_ROOT, 'config');

export const resolveAgentsDir = () => process.env.CAST_AGENTS_DIR || DEFAULT_AGENTS_DIR;
export const resolveConfigDir = () => process.env.CAST_CONFIG_DIR || DEFAULT_CONFIG_DIR;
