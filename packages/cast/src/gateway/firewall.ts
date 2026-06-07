/**
 * Server-level firewall — controls which agents accept external traffic.
 *
 * Reads `<CAST_CONFIG_DIR>/firewall.json` with mtime-based caching (hot-reload).
 * Three load sources, three behaviors:
 *
 *   - **missing**: file does not exist → `{ mode: 'allow-all', except: [] }`.
 *     This is the documented default — operator has chosen not to set up
 *     firewall config.
 *   - **parsed**: file present and validates → use it.
 *   - **invalid**: file present but unparseable (JSON syntax error or
 *     fails the schema) → fail-closed `{ mode: 'deny-all', except: [] }`.
 *     This is the only safe interpretation; the prior behavior (default
 *     to allow-all on invalid) silently unblocked every agent if a
 *     config typo or partial write produced an unparseable file. The file
 *     is called `firewall` and the failure mode should match the name.
 *
 * `loadFirewall()` (runtime) treats invalid as fail-closed and stays up
 * so a running server doesn't die on a config-edit typo.
 * `validateFirewallAtStartup()` (boot) throws on invalid so a deploy with
 * a broken config never reaches the running state.
 */
import { FirewallSchema, type Firewall } from '@getcast/agent-schema/v1';

import { CONFIG_DIR } from '../config.js';
import { readText } from '../lib/config-reader.js';
import { logger } from '../logger.js';

import path from 'path';

const firewallPath = path.join(CONFIG_DIR, 'firewall.json');

const ALLOW_ALL: Firewall = { mode: 'allow-all', except: [] };
const DENY_ALL: Firewall = { mode: 'deny-all', except: [] };

type LoadSource = 'parsed' | 'missing' | 'invalid';

interface LoadResult {
  readonly firewall: Firewall;
  readonly source: LoadSource;
  readonly error?: string;
}

function loadInternal(): LoadResult {
  const raw = readText(firewallPath);
  if (raw === null) {
    return { firewall: ALLOW_ALL, source: 'missing' };
  }
  try {
    const json: unknown = JSON.parse(raw);
    const parsed = FirewallSchema.parse(json);
    return { firewall: parsed, source: 'parsed' };
  } catch (err) {
    return {
      firewall: DENY_ALL,
      source: 'invalid',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Last observed load source. Used to log only on transitions — without
 *  this, runtime hot-reload would spam the log on every
 *  `isExternallyReachable` call against an invalid file. */
// SIDE EFFECT: module-level state. Resettable via _resetFirewallStateForTest.
let lastSource: LoadSource | null = null;

/** Load and parse firewall config. Returns ALLOW_ALL if missing, DENY_ALL
 *  if present-but-invalid, parsed firewall otherwise. Logs at error on
 *  the first transition into 'invalid' and at info on recovery. */
export function loadFirewall(): Firewall {
  const result = loadInternal();
  if (result.source !== lastSource) {
    if (result.source === 'invalid') {
      logger.error(
        { filePath: firewallPath, err: result.error },
        'firewall.json is unparseable — falling back to deny-all until the file is fixed',
      );
    } else if (lastSource === 'invalid') {
      // Reached the else branch → result.source is 'parsed' or 'missing'.
      logger.info(
        { filePath: firewallPath, source: result.source },
        'firewall.json now loads cleanly — restored from deny-all fallback',
      );
    }
    lastSource = result.source;
  }
  return result.firewall;
}

/** Boot-time validation. Throws if `firewall.json` exists but is
 *  unparseable — a deploy with a broken firewall should not reach the
 *  running state. Missing file is OK (allow-all is the documented
 *  default). Called once from `index.ts` after the FileWatcher is up. */
export function validateFirewallAtStartup(): void {
  const result = loadInternal();
  if (result.source === 'invalid') {
    throw new Error(
      `firewall.json at ${firewallPath} is unparseable: ${result.error ?? 'unknown error'}. ` +
        `Refusing to start the server — a broken firewall config defaults to fail-closed at ` +
        `runtime, which would block all external traffic. Fix the file or remove it to default ` +
        `to allow-all.`,
    );
  }
  // Seed `lastSource` so the first runtime call doesn't re-log on the
  // missing→missing or parsed→parsed transition.
  lastSource = result.source;
  logger.info(
    { filePath: firewallPath, source: result.source, mode: result.firewall.mode },
    'firewall.json validated at startup',
  );
}

/** Check if an agent (by folder name / label) is externally reachable. */
export function isExternallyReachable(agentLabel: string): boolean {
  const fw = loadFirewall();
  const listed = fw.except.includes(agentLabel);
  return fw.mode === 'allow-all' ? !listed : listed;
}

/** Test-only: reset the transition-tracker so suites can re-exercise
 *  first-load logging without picking up the previous test's state. */
export function _resetFirewallStateForTest(): void {
  lastSource = null;
}
