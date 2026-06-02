import { logger } from '../logger.js';
import * as minimal from './minimal.js';
import * as standard from './standard.js';

export interface ProfileContent {
  prompt: string;
  skills: string;
  bootstrap: string;
  /**
   * Tool names disabled during the bootstrap phase. Enforces the read-only
   * invariant of bootstrap — populate with tools that mutate persistent state
   * (task scheduling, conversation pushes, summary writes, request closes).
   * Empty = no restriction. Sibling field rather than nested in `bootstrap`
   * to keep the four content fields uniformly typed; if more phase-config
   * accrues, refactor to a `Phase` shape.
   */
  bootstrapDisabledTools: string[];
  /**
   * Guidance on proactive conversation closure — gated at assembly time to
   * persistent channels only. Single-shot channels self-close; cleanup-turn
   * spawns are caught at handler time (`requestConversationEnd`'s isExpired
   * guard). Consoles use a separate prompt pipeline and don't see this.
   */
  proactiveClosure: string;
  cleanup: string;
}

const KNOWN_PROFILES = new Set(['standard', 'minimal']);

export function getProfile(name: string): ProfileContent {
  if (!KNOWN_PROFILES.has(name)) {
    logger.warn({ requested: name }, 'Unknown profile, falling back to standard');
  }
  return name === 'minimal' ? minimal : standard;
}
