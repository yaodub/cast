/**
 * Configure-specific MCP tools: configure__validate, configure__list_participants,
 * configure__list_extension_secrets, configure__pair_user, configure__revoke_user.
 *
 * Shared tools (`conversation__push_to_channel`, `agent__expire_conversations`) are
 * registered by `../tools.ts` unconditionally. Mutating tools call
 * `appendChangelog()` — see `state/admin-changelog.jsonl`.
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
import { appendChangelog } from '../shared/audit-log.js';
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
// configure__pair_user
// ---------------------------------------------------------------------------

export function handlePairUser(
  ctx: ConsoleMcpContext,
  deps: ConsoleMcpDeps,
  handle: string,
  accessScope: string,
): ToolResult {
  const pairUser = deps.pairUser;
  if (!pairUser) return textResult('Pairing unavailable.', true);

  let code: string;
  try {
    code = pairUser(handle);
  } catch (err) {
    return textResult(`Failed to generate pairing code: ${String(err)}`, true);
  }

  appendChangelog(ctx.hostFolder, {
    actor: ctx.participant ?? 'console',
    action: 'pair_user',
    handle,
    code,
    accessScope,
  });

  const lines = [
    `Generated pairing code **${code}** for handle \`${handle}\`.`,
    `**Access this grants:** ${accessScope}`,
    '',
    `Share this with the user. They complete pairing by sending the agent: \`/pair ${code}\``,
    '',
    'If the user has never messaged this agent, they must send any message first so their identity is registered — then the code can be redeemed. Codes expire after 30 minutes.',
  ];
  return textResult(lines.join('\n'));
}

// ---------------------------------------------------------------------------
// configure__revoke_user
// ---------------------------------------------------------------------------

export function handleRevokeUser(
  ctx: ConsoleMcpContext,
  deps: ConsoleMcpDeps,
  identityId: string,
): ToolResult {
  const revoke = deps.revokeUser;
  if (!revoke) return textResult('Revocation unavailable.', true);

  const result = revoke(identityId);
  if (!result.ok) {
    return textResult(result.error ?? 'Revocation failed.', true);
  }

  appendChangelog(ctx.hostFolder, {
    actor: ctx.participant ?? 'console',
    action: 'revoke_user',
    identityId,
  });

  return textResult(`Revoked paired user \`${identityId}\`. Their ACL grants from \`state/paired-users.json\` are gone. (The identity itself remains in the roster — re-pair to grant access again.)`);
}

// Revoke is handled by `AgentManager.unpair()` — the sole writer of
// `state/paired-users.json`. Wired into the
// Configure MCP `revokeUser` closure via ConsoleBuilderDeps.unpair.

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

  server.tool(
    'configure__pair_user',
    'Generate a 6-digit pairing code for a transport handle (e.g. tg:12345, wa:+15551234567). Returns the code and instructions. The operator shares the code out-of-band; the user completes pairing by sending the agent /pair <code>. The handle must have sent at least one message before the code can be redeemed. Codes expire after 30 minutes.',
    {
      handle: z.string().min(1).describe('Transport handle including prefix, e.g. "tg:12345" or "wa:+15551234567".'),
      access_scope: z
        .string()
        .min(1)
        .describe(
          'What this user will be able to do, stated in the operator\'s terms (not ACL bits). ' +
          'Example: "Sam can send messages to content-writer and receive its replies on the default channel." ' +
          'Shown to the operator at pairing time so they can flag if the scope is broader than they expected. ' +
          'If the pairing is broader than usual (admin-equivalent, multi-channel), name that explicitly.',
        ),
    },
    async (args) => handlePairUser(ctx, deps, args.handle, args.access_scope),
  );

  server.tool(
    'configure__revoke_user',
    'Revoke a paired user\'s ACL grants by identity id. Removes the entry from state/paired-users.json. The identity itself stays in the roster — re-pair to grant access again. Use configure__list_participants to find identity ids.',
    {
      identityId: z.string().min(1).describe('Identity id — looks like "u:abc123@srv". Run configure__list_participants to find it.'),
    },
    async (args) => handleRevokeUser(ctx, deps, args.identityId),
  );
}
