/**
 * Builders for ConsoleMcpDeps and ConsoleContext — extracted from AgentManager
 * so the per-call wiring (live status snapshot, ACL-checked delivery, manifest +
 * channel + service introspection) has its own home and AgentManager stays
 * focused on owning state.
 */
import fs from 'fs';

import { AgentManifestSchema, type AgentConfig } from '@getcast/agent-schema/v1';

import { AclSchema } from '../auth/acl.js';
import { generatePairingCode } from '../auth/pairing.js';
import { agentPath, resolveCapabilities } from '../config.js';
import { isConsoleChannel, loadAdminManual, type ConsoleName } from '../console/index.js';
import { readManifestRaw, writeManifestRaw } from '../console/shared/lifecycle.js';
import type { ConsoleContext } from '../console/prompt.js';
import type { ConsoleMcpDeps } from '../console/tools.js';
import { listExtensionSecrets } from '../extensions/list-secrets.js';
import type { Bus } from '../gateway/bus.js';
import { loadChannelsConfig } from '../conversations/channel-config.js';
import { readText } from '../lib/config-reader.js';
import { logger } from '../logger.js';
import type { McpServerDeps } from './mcp-server.js';

import type { AgentDb } from './agent-db.js';
import type { AgentService } from './agent-service.js';
import { conversations } from '../lib/gates.js';
import type { AgentSpawnContext } from './agent-manager.js';

export interface ConsoleBuilderDeps {
  folder: string;
  agentId: string;
  bus: Bus;
  agentDb: AgentDb;
  service: AgentService;
  /** Conversations scope for this agent's user-channel traffic — used by
   *  the status / expire helpers below to enumerate runners on the right
   *  scope. Console-channel runners live on `console:${folder}`, which
   *  these helpers must NOT iterate. */
  agentScope: string;
  mcpDeps?: McpServerDeps;
  getTimezone: () => string;
  /** Revoke a paired user. Closure over AgentManager.unpair, the sole
   *  writer of state/paired-users.json. */
  unpair: (identityId: string) => { ok: boolean; error?: string };
}

/** Agent-scope consoles see a "Recent activity" block in the snapshot.
 *  Server-scope consoles span multiple agents and don't get the block. */
const AGENT_SCOPE_CONSOLES = new Set<ConsoleName>(['design', 'configure']);

/**
 * Gather the dynamic snapshot data for a console session.
 * Pulls from manifest.json, config/agent.json, config/acl.json, loaded channels,
 * service state, and live runner count.
 */
export function buildConsoleContext(
  deps: ConsoleBuilderDeps,
  agentConfig: AgentConfig,
  consoleName?: ConsoleName,
): ConsoleContext {
  let manifest: ConsoleContext['manifest'] = {};
  try {
    const raw = readText(agentPath(deps.folder, 'manifest.json'));
    if (raw) {
      const rawObj = JSON.parse(raw) as Record<string, unknown>;
      const parsed = AgentManifestSchema.parse(rawObj);
      manifest = {
        name: parsed.name,
        description: parsed.description,
        template: typeof rawObj.template === 'string' ? rawObj.template : undefined,
        templateVersion: typeof rawObj.templateVersion === 'string' ? rawObj.templateVersion : undefined,
        status: parsed.status,
      };
    }
  } catch (err) {
    logger.debug({ agentFolder: deps.folder, err }, 'Failed to parse manifest for console prompt');
  }

  let owner = 'local';
  const aclRaw = readText(agentPath(deps.folder, 'config', 'acl.json'));
  if (aclRaw) {
    try {
      owner = AclSchema.parse(JSON.parse(aclRaw)).owner;
    } catch {
      // ACL missing/unparseable → stay with 'local' default
    }
  }

  const channelsConfig = loadChannelsConfig(deps.folder);
  const channels = Object.keys(channelsConfig).filter((n) => !isConsoleChannel(n));

  const hasService = fs.existsSync(
    agentPath(deps.folder, 'blueprint', 'service', 'manifest.json'),
  );
  const serviceStatus: ConsoleContext['serviceStatus'] = hasService
    ? deps.service.status
    : 'not-configured';

  let activeConversations = 0;
  for (const view of conversations.inScope<AgentSpawnContext>(deps.agentScope)) {
    const channelName = view.ctx?.channelName;
    if (channelName && !isConsoleChannel(channelName)) activeConversations++;
  }

  const adminManual = loadAdminManual() ?? undefined;

  const recentEvents = consoleName && AGENT_SCOPE_CONSOLES.has(consoleName)
    ? deps.agentDb.readEvents({ limit: 10 })
    : undefined;

  // Required resource slots without a provisioned host path. Surfaced for
  // Configure (per-agent and the manager surface picks it up via per-agent
  // briefs); Design sees it too, which is fine — Design is who declared the
  // slot, so a reminder that the operator hasn't bound a path is on-topic.
  const missingRequiredResources = consoleName && AGENT_SCOPE_CONSOLES.has(consoleName)
    ? resolveCapabilities(deps.folder).missingRequired
    : undefined;

  return {
    manifest,
    model: agentConfig.model,
    modelOverrideCount: agentConfig.modelOverrides?.length ?? 0,
    owner,
    timezone: deps.getTimezone(),
    channels,
    serviceStatus,
    activeConversations,
    ...(adminManual ? { adminManual } : {}),
    ...(recentEvents && recentEvents.length > 0 ? { recentEvents } : {}),
    ...(missingRequiredResources && missingRequiredResources.length > 0 ? { missingRequiredResources } : {}),
  };
}

/**
 * Dependencies for the console MCP server. Delegation reuses the normal path
 * (ACL-checked); expire and status are agent-manager local. No frozen
 * consoleCtx — each tool call reads live state. Runner TTL is 30 minutes and
 * tools advertise "live" data; closing over a snapshot at session start makes
 * the tools quietly lie about service status, owner, model, etc. after any
 * mid-session change.
 */
export function buildConsoleMcpDeps(
  deps: ConsoleBuilderDeps,
  loadAgentConfig: () => AgentConfig,
): ConsoleMcpDeps {
  return {
    deliverToChannel: deps.mcpDeps?.deliverToChannel,
    deliverToAgent: deps.mcpDeps?.deliverToAgent,
    resolveAgentByLabel: deps.mcpDeps?.resolveAgentByLabel,
    onExpireConversations: () => {
      let expired = 0;
      for (const view of conversations.inScopeActive<AgentSpawnContext>(deps.agentScope)) {
        const channelName = view.ctx?.channelName;
        if (!channelName || isConsoleChannel(channelName)) continue;
        // Hard expire (no cleanup turn) — Configure's bulk-expire tool is a
        // forced reset, not a polite "wrap up". The Conversation tears down
        // its runner + slot and removes itself from the catalog.
        void conversations.expire(deps.agentScope, view.key, null);
        expired++;
      }
      return { expired };
    },
    getAgentStatus: () => {
      const breakdown = new Map<string, number>();
      let activeConversations = 0;
      for (const view of conversations.inScopeActive<AgentSpawnContext>(deps.agentScope)) {
        const channelName = view.ctx?.channelName;
        if (!channelName || isConsoleChannel(channelName)) continue;
        breakdown.set(channelName, (breakdown.get(channelName) ?? 0) + 1);
        activeConversations++;
      }
      // Build a fresh snapshot so service status / model / owner reflect
      // the current filesystem state, not a value captured at session start.
      const liveCtx = buildConsoleContext(deps, loadAgentConfig());
      return {
        serviceStatus: liveCtx.serviceStatus,
        activeConversations,
        channelBreakdown: Array.from(breakdown.entries()).map(([channel, active]) => ({ channel, active })),
        model: liveCtx.model,
        modelOverrideCount: liveCtx.modelOverrideCount,
        owner: liveCtx.owner,
      };
    },
    getAgentDb: () => deps.agentDb,
    pairUser: (handle: string) => generatePairingCode(deps.folder, handle),
    revokeUser: (identityId: string) => deps.unpair(identityId),
    listExtensionSecrets: () => listExtensionSecrets(deps.folder),
    emitUiDirective: (from, to, channel, directive) => {
      // Fire-and-forget: transports without SSE render a text fallback via
      // their own sendEvent. At-most-once: log dispatch failure for dogfood visibility.
      void deps.bus.routeEvent({
        from,
        to,
        type: 'ui_directive',
        data: { channel, directive },
      }).catch((err) => {
        logger.error({ err, from, to, channel }, 'emitUiDirective dispatch failed');
      });
    },
    requestSecurityReview: deps.mcpDeps?.requestSecurityReview
      ? (changeId) => deps.mcpDeps!.requestSecurityReview!(deps.folder, changeId)
      : undefined,
    setDescription: (description: string) => {
      const res = readManifestRaw(deps.folder);
      if ('error' in res) return { ok: false, reason: res.error };
      // Spread-merge so passthrough provenance fields (template*, stampedAt) survive.
      writeManifestRaw(deps.folder, { ...res.raw, description });
      // Refresh the live bus copy — registration captured the old value and the
      // dir-watcher only re-registers on add/remove/key-rotation, not edits.
      deps.bus.updateMetadata(deps.agentId, { description }, 'description-changed');
      return { ok: true };
    },
  };
}
