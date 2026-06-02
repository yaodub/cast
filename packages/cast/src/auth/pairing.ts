/**
 * Pairing — links transport handles to identities via pairing codes.
 *
 * Manages two files per agent:
 * - `state/paired-users.json` — ACL grants for paired users (identity → channel → bits).
 *   Same format as acl.json peers. Human-readable for authorization auditing.
 * - `state/pairing-codes.json` — code state (consumed, expiry, handle restriction).
 *   Only read during /pair flow.
 *
 * Includes per-handle rate limiting to prevent brute-force attacks on codes.
 */
import { randomInt } from 'crypto';
import fs from 'fs';

import { z } from 'zod';

import { agentPath } from '../config.js';
import type { ResolvedIdentity } from './identity.js';
import { writeAtomic } from '../lib/utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PairingResult {
  success: boolean;
  identity?: ResolvedIdentity;
  message: string;
}

// ---------------------------------------------------------------------------
// Paired Users — state/paired-users.json (ACL grants only)
// ---------------------------------------------------------------------------

/** Per-identity channel permissions, same format as acl.json peers. */
const PairedUsersSchema = z.record(z.string(), z.record(z.string(), z.string()));

/** Read paired user grants — used by ACL merge. State file, not watched. */
export function readPairedUsers(agentFolder: string): Record<string, Record<string, string>> {
  const filePath = agentPath(agentFolder, 'state', 'paired-users.json');
  try {
    return PairedUsersSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch {
    return {};
  }
}

export function writePairedUsers(agentFolder: string, users: Record<string, Record<string, string>>): void {
  const filePath = agentPath(agentFolder, 'state', 'paired-users.json');
  fs.mkdirSync(agentPath(agentFolder, 'state'), { recursive: true });
  writeAtomic(filePath, JSON.stringify(users, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Pairing Codes — state/pairing-codes.json (code state only)
// ---------------------------------------------------------------------------

const PairingCodeSchema = z.object({
  consumed: z.boolean().optional(),
  for_handle: z.string().min(1),
  expires: z.string().optional(),
});

const PairingCodesSchema = z.record(z.string(), PairingCodeSchema);

/** Read pairing codes — state file, not watched. */
export function readPairingCodes(agentFolder: string): Record<string, z.infer<typeof PairingCodeSchema>> {
  const filePath = agentPath(agentFolder, 'state', 'pairing-codes.json');
  try {
    return PairingCodesSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf-8')));
  } catch {
    return {};
  }
}

export function writePairingCodes(agentFolder: string, codes: Record<string, z.infer<typeof PairingCodeSchema>>): void {
  const filePath = agentPath(agentFolder, 'state', 'pairing-codes.json');
  fs.mkdirSync(agentPath(agentFolder, 'state'), { recursive: true });
  writeAtomic(filePath, JSON.stringify(codes, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// Code generation
// ---------------------------------------------------------------------------

const CODE_EXPIRY_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Generate a 6-digit pairing code locked to a specific handle.
 * Writes to `state/pairing-codes.json`. Returns the code string.
 */
export function generatePairingCode(agentFolder: string, handle: string): string {
  const codes = readPairingCodes(agentFolder);

  // Revoke any existing unconsumed code for this handle
  for (const [existing, state] of Object.entries(codes)) {
    if (state.for_handle === handle && !state.consumed) {
      codes[existing] = { ...state, consumed: true };
    }
  }

  // Generate unique 6-digit code
  let code: string;
  do {
    code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  } while (code in codes);

  codes[code] = {
    for_handle: handle,
    expires: new Date(Date.now() + CODE_EXPIRY_MS).toISOString(),
  };
  writePairingCodes(agentFolder, codes);

  return code;
}

// Pairing flow itself (rate-limit + code validation + paired-users.json
// write + bus.update emit) lives on `AgentManager.pair()` — see
// `agent/agent-manager.ts`. AgentManager is the only writer of
// `state/paired-users.json`.
