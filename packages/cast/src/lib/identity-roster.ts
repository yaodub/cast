/**
 * Identity roster — tracks known identities per agent.
 *
 * Stores a JSON file at `state/identity-roster.json` that maps identity IDs
 * to their display name and type. Updated after successful pairing.
 *
 * Transport-blind: handles are an IdP concern (`handle_mappings`), not duplicated
 * here. The roster is a per-agent display name book keyed by bare identity.
 */
import fs from 'fs';
import { z } from 'zod';

import { agentPath } from '../config.js';
import type { ResolvedIdentity } from '../auth/identity.js';
import { logger } from '../logger.js';
import { writeAtomic } from './utils.js';

const RosterEntrySchema = z.object({
  name: z.string(),
  type: z.string().optional(),
});

const IdentityRosterSchema = z.record(z.string(), RosterEntrySchema);

type IdentityRoster = z.infer<typeof IdentityRosterSchema>;

/** Read the identity roster for an agent. Returns empty object if missing. */
export function readRoster(agentFolder: string): IdentityRoster {
  const rosterPath = agentPath(agentFolder, 'state', 'identity-roster.json');
  try {
    return IdentityRosterSchema.parse(JSON.parse(fs.readFileSync(rosterPath, 'utf-8')));
  } catch {
    return {};
  }
}

/** Create or update a roster entry after pairing/identity resolution. */
export function updateRoster(agentFolder: string, identity: ResolvedIdentity): void {
  const roster = readRoster(agentFolder);
  const existing = roster[identity.id];

  if (existing) {
    existing.name = identity.declaredName;
  } else {
    roster[identity.id] = { name: identity.declaredName };
  }

  const rosterPath = agentPath(agentFolder, 'state', 'identity-roster.json');
  try {
    fs.mkdirSync(agentPath(agentFolder, 'state'), { recursive: true });
    writeAtomic(rosterPath, JSON.stringify(roster, null, 2) + '\n');
  } catch (err) {
    logger.warn({ agentFolder, err }, 'Failed to write identity roster');
  }
}
