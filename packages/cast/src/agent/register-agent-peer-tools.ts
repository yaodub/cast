/**
 * agent__list_peers tool registrar — extracted from mcp-server.ts.
 *
 * Registered when the host wires `deps.listPeerAgents`. Surfaces the canonical
 * address, alias, description, and per-channel capability summary for each
 * peer so the LLM understands where it can route queries vs. push messages.
 *
 * Capability rendering is delegated to `renderContractForPeerListing` in
 * `auth/channel-contract.ts` — the same module that renders the prompt
 * block and the bounce message. Single source of truth: bits → operational
 * meaning, three audiences, one switch to evolve when bits change.
 */
import { isToolDisabled } from '@getcast/agent-schema/v1';

import {
  deriveChannelContract,
  renderContractForPeerListing,
} from '../auth/channel-contract.js';
import { isSystemContext, isUser } from '../auth/address.js';
import { textResult } from '../extensions/registry.js';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpAgentContext, McpServerDeps } from './mcp-server.js';

export function registerAgentPeerTools(server: McpServer, ctx: McpAgentContext, deps: McpServerDeps): void {
  if (!deps.listPeerAgents) return;
  if (isToolDisabled('agent__list_peers', ctx.disabledTools ?? [])) return;
  // A peer-agent cell must not enumerate the peer roster — that is cross-agent
  // reconnaissance, the M1-adjacent leak the four-site masquerade fix leaves
  // open (a peer carries a non-self `a:` address, so it is neither system
  // context nor a user). Owner-context (self/scheduler) and user/operator cells
  // may list peers: the agent discovers who it can route queries to, whether
  // acting alone or while serving a user. (Peer listing stays agent-level by
  // design — outbound `q` reach is keyed by target agent on the sender's own
  // ACL, independent of the serving cell's caller, so caller-scoping this list
  // would break delegation-on-behalf-of while protecting nothing. The
  // caller-scoped surfaces are `agent__list_channels` / `agent__list_participants`.)
  if (!isSystemContext(ctx.participant, ctx.agentId) && !isUser(ctx.participant ?? '')) return;

  const listFn = deps.listPeerAgents;
  server.tool(
    'agent__list_peers',
    'List peer agents and your relationship with each (who you can query, who can query you, messaging permissions). Sharded channels render as `name~*` — substitute your own qualifier (e.g. `name~daily`) to address a specific sub-conversation.',
    {},
    async () => {
      const peers = listFn();
      if (peers.length === 0) return textResult('No peer agents configured.');
      const renderName = (ch: { name: string; sharded?: boolean }) =>
        ch.sharded ? `${ch.name}~*` : ch.name;
      const blocks = peers.map((p) => {
        const header = p.description ? `- ${p.alias} (${p.canonical}): ${p.description}` : `- ${p.alias} (${p.canonical})`;
        const lines: string[] = [header];
        for (const ch of p.channels) {
          const capabilities = renderContractForPeerListing(deriveChannelContract(ch.bits));
          if (capabilities.length === 0) continue;
          lines.push(`  on ${renderName(ch)}: ${capabilities.join('; ')}`);
        }
        return lines.join('\n');
      });
      return textResult(blocks.join('\n'));
    },
  );
}
