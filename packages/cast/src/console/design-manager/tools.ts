/**
 * Design Manager-specific MCP tools.
 *
 * `design_manager__create_agents` — batch-wraps `deps.createAgent`. Partial
 * failures reported; no rollback. One call fires N `agent-registry.changed`
 * events which coalesce into a single DM runner invalidation (idempotent
 * `markAllInvalidated`) — the next operator message respawns the container
 * once, with all N new agent blueprints mounted and SDK session continuity
 * preserved via the `sessionIdOverride` path.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { textResult } from '../../extensions/registry.js';
import type { ToolResult } from '../../extensions/registry.js';
import type { ConsoleMcpContext, ConsoleMcpDeps } from '../strategy.js';

const CreateAgentsInput = z.object({
  outcome_inference: z
    .string()
    .min(1)
    .describe(
      'One clause stating the operator-world outcome you inferred from their ask — not the system shape. ' +
      'Shown to the operator at tool invocation so they can flag a misread before N folders materialize. ' +
      'Example: "weekly team digest of support themes, not live monitoring." ' +
      'If ask and outcome are identical, say so: "outcome matches ask: three-agent research network."',
    ),
  alternatives_considered: z
    .string()
    .min(1)
    .describe(
      'Other agent shapes you considered and rejected, with what would flip the decision. ' +
      'Example: "rejected 2-agent triage/draft pipeline — low volume, single prompt is tunable. Flip if prompt-length trouble emerges." ' +
      'If only one shape is legitimate for this outcome, say so: "only one shape fits: single agent; pipeline adds complexity without a goal."',
    ),
  agents: z
    .array(
      z.object({
        name: z
          .string()
          .describe('Lowercase alphanumeric plus hyphens, unique across the server'),
        description: z
          .string()
          .optional()
          .describe('One-line summary of the agent\'s "what". Optional; per-agent Design can refine it.'),
        channels: z
          .array(z.string())
          .optional()
          .describe('Reserved — honored as defaults when operator edits via per-agent Design'),
        extensions: z
          .array(z.string())
          .optional()
          .describe('Reserved — honored as defaults when operator edits via per-agent Design'),
      }),
    )
    .min(1)
    .max(20),
});

interface CreateAgentsResult {
  created: string[];
  failed: Array<{ name: string; reason: string }>;
}

export function registerCreateAgentsTool(
  server: McpServer,
  _ctx: ConsoleMcpContext,
  deps: ConsoleMcpDeps,
): void {
  if (!deps.createAgent) return;
  const createAgent = deps.createAgent;

  server.tool(
    'design_manager__create_agents',
    'Batch-create N draft agent folders, each with a minimal scratch blueprint. Brief each new agent separately via conversation__push_to_channel to its __design channel. Partial failures reported; no rollback — half-created folders are draft, operator can archive if wrong. Call once with the full proposed set; do not loop yourself. The channels/extensions fields are reserved for future use — currently honored only as defaults when the operator later edits via per-agent Design.',
    CreateAgentsInput.shape,
    async (args): Promise<ToolResult> => {
      const result: CreateAgentsResult = { created: [], failed: [] };
      for (const spec of args.agents) {
        const res = await createAgent(spec.name, spec.description);
        if (!res.ok) {
          result.failed.push({ name: spec.name, reason: res.reason });
          continue;
        }
        result.created.push(spec.name);
      }
      const summary = [
        `**Outcome:** ${args.outcome_inference}`,
        `**Alternatives considered:** ${args.alternatives_considered}`,
        '',
        '```json',
        JSON.stringify(result, null, 2),
        '```',
      ].join('\n');
      return textResult(summary);
    },
  );
}
