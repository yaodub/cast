/**
 * Design-specific MCP tools: design__validate, design__agent_status,
 * design__set_description, design__revert_to_draft, design__request_review.
 * `agent__expire_conversations` and `conversation__push_to_channel` are
 * shared (see `../shared/`).
 *
 * Lifecycle authority split: Design can revert ready→draft directly (safety
 * move, no review needed) but cannot flip draft→ready on its own — that path
 * runs through Security Manager via `design__request_review` → SM converses
 * with the operator → SM calls `security__finalize_agent`.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { textResult } from '../../extensions/registry.js';
import type { ToolResult } from '../../extensions/registry.js';
import { loadChannelsConfig } from '../../conversations/channel-config.js';
import { generateId } from '../../lib/utils.js';
import { isConsoleChannel } from '../index.js';
import { appendChangelog } from '../../lib/audit-log.js';
import { readManifestRaw, setLifecycle } from '../shared/lifecycle.js';
import { renderValidationReport, validateAgentBlueprint } from '../shared/validation.js';
import type { ConsoleMcpContext, ConsoleMcpDeps } from '../strategy.js';

// --- handlers ---

function handleValidate(agentFolder: string): ToolResult {
  const report = validateAgentBlueprint(agentFolder);
  return textResult(renderValidationReport(report), report.problems.length > 0);
}

function handleAgentStatus(agentFolder: string, deps: ConsoleMcpDeps): ToolResult {
  const snap = deps.getAgentStatus?.();
  if (!snap) return textResult('Status snapshot unavailable.', true);

  const lines: string[] = [];
  lines.push(`**Service:** ${snap.serviceStatus}`);
  lines.push(`**Model:** ${snap.model ?? '(server default)'}${snap.modelOverrideCount > 0 ? ` (+${snap.modelOverrideCount} override${snap.modelOverrideCount > 1 ? 's' : ''})` : ''}`);
  lines.push(`**Owner:** ${snap.owner}`);
  lines.push('');
  lines.push(`**Active conversations:** ${snap.activeConversations}`);
  if (snap.channelBreakdown.length > 0) {
    for (const c of snap.channelBreakdown) {
      lines.push(`- ${c.channel}: ${c.active}`);
    }
  }

  try {
    const channels = loadChannelsConfig(agentFolder);
    const names = Object.keys(channels).filter((n) => !isConsoleChannel(n));
    lines.push('');
    lines.push(`**Configured channels (${names.length}):** ${names.join(', ') || '(none)'}`);
  } catch {
    // best-effort
  }

  return textResult(lines.join('\n'));
}

function handleRevertToDraft(ctx: ConsoleMcpContext, reason: string): ToolResult {
  const result = setLifecycle(ctx.hostFolder, 'draft', {
    actor: ctx.participant ?? 'console',
    via: 'design_revert',
    reason,
  });
  if ('error' in result) return textResult(result.error, true);
  if (result.noop) {
    return textResult('Agent is already **draft** — nothing to change.', true);
  }
  return textResult(
    [
      'Agent set back to **draft**. The default tab for this agent is now Design. Live traffic is unaffected.',
      `**Reverting because:** ${reason}`,
    ].join('\n'),
  );
}

function handleRequestReview(
  ctx: ConsoleMcpContext,
  deps: ConsoleMcpDeps,
  readinessCheck: string,
): ToolResult {
  const manifest = readManifestRaw(ctx.hostFolder);
  if ('error' in manifest) return textResult(manifest.error, true);
  if (manifest.manifest.status !== 'draft') {
    return textResult(
      'Agent is already **ready** — no review needed. If you want SM to take another look, the operator can open the All-Agents Review chat directly.',
      true,
    );
  }
  if (!deps.requestSecurityReview) {
    return textResult('Security review dispatch is not wired in this build.', true);
  }

  // Consult validation at the gate — light form: surface + carry, never a
  // silent forward. Problems are runtime-fatal; the dispatch still goes
  // through (no hard block), but Design and the changelog both carry them.
  const report = validateAgentBlueprint(ctx.hostFolder);

  const changeId = generateId('review');
  deps.requestSecurityReview(changeId);

  appendChangelog(ctx.hostFolder, {
    actor: ctx.participant ?? 'console',
    action: 'request_review',
    change_id: changeId,
    readiness_check: readinessCheck,
    validation_problems: report.problems.length,
    validation_warnings: report.warnings.length,
  });

  const lines = [
    'Review request sent to **All-Agents Review**.',
    `**Change ID:** ${changeId}`,
    `**Readiness check:** ${readinessCheck}`,
  ];
  if (report.problems.length > 0) {
    lines.push(
      '',
      `**Validate reports ${report.problems.length} problem(s)** that will fail at runtime. They're recorded with this review; surface them to the operator and fix them before they rely on the agent:`,
      '',
      renderValidationReport(report),
    );
  }
  lines.push(
    '',
    'Tell the operator their next step is the All-Agents Review chat — SM will read the agent and walk them through anything noteworthy. SM finalizes the agent live (or declines and asks them to revisit). The agent stays in draft until SM finalizes it; you do not flip the bit.',
  );
  return textResult(lines.join('\n'));
}

function handleSetDescription(deps: ConsoleMcpDeps, description: string): ToolResult {
  if (!deps.setDescription) {
    return textResult('Setting the description is not wired in this build.', true);
  }
  const res = deps.setDescription(description);
  if (!res.ok) return textResult(res.reason, true);
  return textResult(
    `Description set to: "${description}". It now shows in the fleet roster, peer lists, and admin UI.`,
  );
}

// --- registration ---

export function registerDesignTools(
  server: McpServer,
  ctx: ConsoleMcpContext,
  deps: ConsoleMcpDeps,
): void {
  server.tool(
    'design__validate',
    'Validate every per-agent config file against the runtime\'s schemas plus the cross-file invariants the runtime relies on. Reports problems (will fail at runtime), warnings (suspicious — unknown keys, unset optional slots, orphan provisions), and a passes list. Covers: manifest, identity files (whoami/prompt), every channel.json, capabilities.json (strict), config/agent.json (strict — including modelOverrides channel refs), config/provisions.json (strict — required slots, access escalation, pip/disabled-tools unlock), per-extension merged config via each extension\'s own configSchema (this is what catches values like fetch_mode="banana"), per-extension secrets when enabled, MCP server transport fields, MCP required env-slot coverage. Run after any edit and before design__request_review.',
    {},
    async () => handleValidate(ctx.hostFolder),
  );

  server.tool(
    'design__agent_status',
    'Live status: service running/stopped, active conversation count and per-channel breakdown, model and owner.',
    {},
    async () => handleAgentStatus(ctx.hostFolder, deps),
  );

  // Lifecycle — Design owns the safety direction only. Reverting a live agent
  // to draft is a unilateral safety move (pull it off traffic, no review
  // needed). The forward direction (draft → ready) flows through Security
  // Manager via `design__request_review` — SM is the gate, not Design.
  server.tool(
    'design__revert_to_draft',
    'Pull a live agent back to draft. One-way — Design cannot flip back to ready (use design__request_review for that, which routes through All-Agents Review). Idempotent — calling on a draft agent returns a no-op. Requires user confirmation. Live traffic from transports and peer agents is bounced with "not yet ready" until the agent is finalized again.',
    {
      reason: z
        .string()
        .min(1)
        .describe(
          'One-line reason for reverting (major rewrite incoming, prompt no longer correct, posture concern surfaced, etc.).',
        ),
    },
    async (args) => handleRevertToDraft(ctx, args.reason),
  );

  server.tool(
    'design__set_description',
    'Set this agent\'s one-line manifest description — the human-readable summary shown in the fleet roster, peer lists, and admin UI. Writes the manifest and refreshes the live copy immediately (no restart). Propose the wording to the operator before calling.',
    {
      description: z
        .string()
        .describe('One-line summary of the agent\'s bounded "what". Pass an empty string to clear it.'),
    },
    async (args) => handleSetDescription(deps, args.description),
  );

  server.tool(
    'design__request_review',
    'Ask All-Agents Review to review this agent before it goes live. Synthesizes an operator-originated message into the All-Agents Review chat. Review reads the agent, walks the operator through anything noteworthy, and finalizes the agent (draft → ready) only on explicit operator approval — Design does not flip the bit. Use this once the blueprint is complete and you have a clean validate. Tell the operator their next step is the Review chat.',
    {
      readiness_check: z
        .string()
        .min(1)
        .describe(
          'Honest accounting before requesting review. What was verified this session, what is still manual (credentials pending, human-in-loop review not yet wired, etc.), what could fail in week 1 if something is missed. ' +
          'Example: "prompt tested against 5 sample emails in __design, produces acceptable drafts. IMAP creds still pending in Configure. Could fail if Gmail rate-limits under actual volume — monitor first few days."',
        ),
    },
    async (args) => handleRequestReview(ctx, deps, args.readiness_check),
  );
}
