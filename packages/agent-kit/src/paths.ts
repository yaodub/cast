import { homedir } from 'os';
import path from 'path';

export const AGENT_KIT_ROOT = path.resolve(import.meta.dirname, '..');
export const PROJECT_ROOT = path.resolve(AGENT_KIT_ROOT, '..', '..');
export const AGENT_TEMPLATES_DIR = path.join(AGENT_KIT_ROOT, 'templates');

// Default agents location. Mirrors scripts/lib/resolve-paths.mjs — kept
// duplicated rather than importing across the package/script boundary.
// If you change one, change the other.
export const DEFAULT_AGENTS_DIR = process.env.CAST_AGENTS_DIR
  ?? path.join(homedir(), '.cast', 'agents');

// Hardcoded shortlist for the `pnpm agent config` wizard. The admin picker
// reads the live catalog from cast-services; this one can't (a network call in
// a CLI prompt is the wrong trade), so it's a curated three and drifts by hand.
// Resync it whenever cast-services/models/seed/models.json gains a generation.
export const MODELS = [
  { value: 'claude-sonnet-5', label: 'Sonnet 5', hint: 'Fast, capable, cost-effective' },
  { value: 'claude-opus-5', label: 'Opus 5', hint: 'Most capable, higher cost' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', hint: 'Fastest, lowest cost' },
];
