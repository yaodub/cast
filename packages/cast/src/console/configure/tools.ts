/**
 * Configure-specific MCP tools: configure__validate, configure__list_participants,
 * configure__list_extension_secrets.
 *
 * Shared tools (`conversation__push_to_channel`, `agent__expire_conversations`) are
 * registered by `../tools.ts` unconditionally. These configure tools are
 * read-only; access changes are audited at their write sites (`lib/audit-log.ts`).
 *
 * Every tool reads live state on demand; none closes over a session-start
 * snapshot. Runner TTL is 30 minutes and operators expect "live" data.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { extractIdentity } from '../../auth/address.js';
import { textResult } from '../../extensions/registry.js';
import type { ToolResult } from '../../extensions/registry.js';
import { readRoster } from '../../lib/identity-roster.js';
import { renderValidationReport, validateAgentBlueprint } from '../shared/validation.js';
import type { ConsoleMcpContext, ConsoleMcpDeps } from '../strategy.js';

// ---------------------------------------------------------------------------
// configure__validate
// ---------------------------------------------------------------------------

export function handleValidate(agentFolder: string): ToolResult {
  const report = validateAgentBlueprint(agentFolder);
  return textResult(renderValidationReport(report), report.problems.length > 0);
}

// ---------------------------------------------------------------------------
// configure__list_participants
// ---------------------------------------------------------------------------

export function handleListParticipants(agentFolder: string, deps: ConsoleMcpDeps): ToolResult {
  const db = deps.getAgentDb?.();
  if (!db) return textResult('Participant DB unavailable.', true);

  const rows = db.getAllParticipants();
  if (rows.length === 0) {
    return textResult('No participants have messaged this agent yet.');
  }

  const roster = readRoster(agentFolder);
  const lines: string[] = [`**${rows.length} participant${rows.length === 1 ? '' : 's'}** (most recent first):`];
  for (const row of rows) {
    const identityId = extractIdentity(row.address);
    const entry = roster[identityId];
    const name = entry?.name ?? '(no display name)';
    lines.push(`- \`${row.address}\` — ${name} (last active ${row.last_active})`);
  }
  return textResult(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// configure__list_extension_secrets
// ---------------------------------------------------------------------------

export function handleListExtensionSecrets(deps: ConsoleMcpDeps): ToolResult {
  const list = deps.listExtensionSecrets?.();
  if (list === undefined) return textResult('Extension secrets unavailable.', true);

  if (list.length === 0) {
    return textResult('No extensions with declared secrets are registered.');
  }

  const byExt = new Map<string, { key: string; isSet: boolean }[]>();
  for (const entry of list) {
    const bucket = byExt.get(entry.extension) ?? [];
    bucket.push({ key: entry.key, isSet: entry.isSet });
    byExt.set(entry.extension, bucket);
  }

  const lines: string[] = ['**Extension secrets (redacted — key names only):**', ''];
  for (const [ext, keys] of byExt) {
    const setCount = keys.filter((k) => k.isSet).length;
    lines.push(`**${ext}** — ${setCount}/${keys.length} set`);
    for (const { key, isSet } of keys) {
      lines.push(`- \`${key}\` — ${isSet ? '✓ set' : '✗ missing'}`);
    }
    lines.push('');
  }
  lines.push('Credentials and PII go through the admin form (no MCP write tool, by design — keeps them out of chat logs). Non-sensitive fields in the same file you can edit directly. Procedure: configure.md § Form-first secrets.');
  return textResult(lines.join('\n').trimEnd());
}

// ---------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------

export function registerConfigureTools(
  server: McpServer,
  ctx: ConsoleMcpContext,
  deps: ConsoleMcpDeps,
): void {
  server.tool(
    'configure__validate',
    'Validate every per-agent config file against the runtime\'s schemas plus the cross-file invariants the runtime relies on. Reports problems (will fail at runtime), warnings (suspicious — unknown keys, unset optional slots, orphan provisions), and a passes list. Covers manifest, identity files, channels, capabilities.json, agent.json (incl. modelOverrides channel refs), provisions.json (required slots, access escalation, pip/disabled-tools unlock), per-extension merged config and secrets, MCP transport fields and required env-slot coverage. Run after any config edit, after binding a slot, on session start when the snapshot reports unbound required slots, and before telling the operator setup is complete.',
    {},
    async () => handleValidate(ctx.hostFolder),
  );

  server.tool(
    'configure__list_participants',
    'List every participant address that has messaged this agent, enriched with display names from the identity roster. Use to audit ACL against real users or to resolve an address to a human.',
    {},
    async () => handleListParticipants(ctx.hostFolder, deps),
  );

  server.tool(
    'configure__list_extension_secrets',
    'List declared secret keys for every registered extension, showing whether each is set in config/ext/<name>/secrets.json. Returns key names only — never values. Use to audit which credentials are configured.',
    {},
    async () => handleListExtensionSecrets(deps),
  );

}
