/**
 * Host-side MCP server over Unix domain socket.
 *
 * Tools call host APIs directly (messageBus, db, etc.) — no file I/O,
 * no polling, sub-millisecond latency.
 *
 * Socket path: mnt/agents/{name}/mcp/cast.sock
 * Transport: MCP Streamable HTTP over Unix socket
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';

const execFileAsync = promisify(execFile);

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import { isToolDisabled } from '@getcast/agent-schema/v1';

import type { ExtensionInstance, ToolCallContext, ToolResult } from '../extensions/registry.js';
import { textResult } from '../extensions/registry.js';
import { conversationKeyToPath, toZonedIso } from '../lib/utils.js';
import { registerAgentPeerTools } from './register-agent-peer-tools.js';
import { registerApprovalTools } from './register-approval-tools.js';
import { registerMessageLogTools } from './register-message-log-tools.js';
import { registerPipTools } from './register-pip-tools.js';
import { registerTaskTools } from './register-task-tools.js';
import { registerTimeTools } from './register-time-tools.js';
import { agentPath, resolveCapabilities } from '../config.js';
import { mcpTransport } from '../container/mcp-transport.js';
import { loadChannelsConfig } from '../conversations/channel-config.js';
import { createPathResolver } from '../lib/agent-paths.js';
import { appendFeedRow } from '../lib/feed-format.js';
import { readAgentConfig } from '../container/container-runner.js';
import type { ResourceEntry } from '@getcast/agent-schema/v1';

import { isParticipantAddress, isReadTier, isSystemContext } from '../auth/address.js';
import { guardsForActor, intraAgentInfraGuard } from '../console/shared/delegation-guards.js';
import { parseChannelString, parseOperatorChannel } from '../conversations/parse-channel.js';
import type { LocalPushActor, PushActor } from './push-actor.js';
import { logger } from '../logger.js';
import type { AgentDb } from './agent-db.js';
import type { MessageLogStore } from '../lib/message-log-store.js';
import type { AgentStateStore } from './state-store.js';
import type { Host, RouteResult } from '../types.js';
import type { AgentChannel } from '../conversations/types.js';
import { generateId, roughTimeAgo } from '../lib/utils.js';
import type { FileWatchService } from './file-watch-service.js';

// --- Types ---

/**
 * Fire-and-forget delivery verbs. Sync validation surfaces immediate errors to
 * the LLM; the async lifecycle (target spawn, response) flows back through
 * normal bus paths, not as a return value here. On success the dispatcher
 * mints a correlation `requestId` and returns it so the caller can match
 * later `<cast:rejection request="<id>">` deliveries against the originating
 * push.
 */
export type DeliveryResult =
  | { ok: true; requestId: string }
  | { ok: false; reason: string };

/**
 * Local intra-agent delivery. The `actor` argument is the trust-tier
 * discriminator — `dispatchLocalPush` skips the user-trust gates
 * (`participantExists`, `gateInbound`) for operator-trust actors. Each
 * actor variant's matching tool registration calls this with its own
 * variant; the type system enforces that any new actor must thread
 * through every implementer.
 */
export type DeliverToChannel = (
  actor: LocalPushActor,
  channel: string,
  text: string,
  participant: string,
  callerChannel?: string,
  callerParticipant?: string,
  qualifier?: string,
  callerQualifier?: string,
) => Promise<DeliveryResult>;

/**
 * Cross-agent or self-target-as-cross delivery. When `targetAgent` resolves
 * to the caller's own agent address, the implementation routes locally via
 * `dispatchLocalPush` rather than the bus, making "pass self-label" and
 * "omit target_agent" semantically equivalent. Cross-agent push from a
 * per-agent console is rejected synchronously here (per the MODES.md
 * model — per-agent consoles route cross-agent through DM/CM).
 */
export type DeliverToAgent = (
  actor: PushActor,
  targetAgent: string,
  channel: string,
  text: string,
  participant: string,
  qualifier?: string,
  callerChannel?: string,
  callerQualifier?: string,
) => Promise<DeliveryResult>;

type RejectionHandler = (requestId: string, returnToAgent: string, returnToChannel: string, returnToParticipant: string, reason: string) => Promise<void>;

/** One row of `listChannelsFor` — a room joined with the caller's standing. */
export interface ChannelStandingRow {
  name: string;
  /** The caller's placement bits, or the literal 'owner' for read-tier rows
   *  (read-tier standing is the tier itself, not a placement). */
  bits: string;
  sharded?: boolean;
  /** `show_co_participants !== false` on this channel. */
  postureOpen: boolean;
  /** Placement names a channel with no config dir — operator-authored ACL
   *  intent, surfaced for debugging rather than silently dropped. */
  missingConfig?: boolean;
}

/**
 * Result of `listRoomMembers`. `scope: 'registry'` is the read-tier flat view
 * (channel omitted — exact timestamps, scheduler back-compat); `scope: 'room'`
 * renders recency at day granularity (presence-oracle trim). The deny arm
 * carries wording byte-identical to the push verdict's channel denial —
 * channel existence is not an oracle.
 */
export type RoomMembersResult =
  | {
      ok: true;
      scope: 'room' | 'registry';
      members: { identity: string; kind: 'user' | 'peer'; lastActive?: string }[];
      /** Policy-keyed, population-blind posture note. */
      postureNote?: string;
    }
  | { ok: false; reason: string };

export interface McpServerDeps {
  /** Same-agent cross-channel delivery (fire-and-forget). */
  deliverToChannel?: DeliverToChannel;
  /** Cross-agent delivery via bus (fire-and-forget). */
  deliverToAgent?: DeliverToAgent;
  /** Rooms the caller is placed in (read tier: every user channel). */
  listChannelsFor?: (caller: string | null) => ChannelStandingRow[];
  /** Members of one room, scoped by the caller's standing — mirrors the push
   *  verdict (`auth/conversation-context.ts`): read tier unfiltered, members
   *  see their own rooms, everyone else gets the uniform denial. */
  listRoomMembers?: (caller: string | null, channel: string | null) => RoomMembersResult;
  resolveAgentByLabel?: (label: string) => string | undefined;
  /** Route a rejection for a closed inbound request. */
  routeRejection?: RejectionHandler;
  /** List peer agents with canonical address, alias, description, and per-channel permission bits. */
  listPeerAgents?: () => {
    canonical: string;
    alias: string;
    description?: string;
    channels: { name: string; bits: string; sharded?: boolean }[];
  }[];
  /** Request conversation end with cooldown. */
  onEndConversation?: (conversationKey: string, cooldownSeconds?: number) =>
    { accepted: boolean; cooldownSeconds: number; reason?: string };
  /** Request human approval for a tool call. Returns the approval ID and pending count. */
  requestApproval?: (data: {
    tool: string;
    args: Record<string, unknown>;
    summary: string;
    details?: string;
    participant: string;
    channel?: string;
    conversationKey?: string;
    expiresIn?: number;
  }) => { id: string; pendingCount: number };
  /** Per-agent file-watch service handle. When wired, the watch tools (`file__watch_feed`,
   *  `file__unwatch`, `file__list_watches`) become available alongside `file__append_feed`. */
  getFileWatchService?: () => FileWatchService;
  /** Dispatch a security-review request for the named agent folder. Wired to
   *  `gateway.ingestInbound` in `index.ts` so a Design-side tool call lands in
   *  Security Manager's `default` channel the same way the operator-button
   *  path does. Optional — surfaced to per-agent Design via `ConsoleMcpDeps`. */
  requestSecurityReview?: (folder: string, changeId: string) => void;
}

/** Per-agent context passed when creating a session. */
export interface McpAgentContext {
  agentFolder: string;
  agentId: string;
  /** Host (name + folder) for path-resolution and resource lookup. Optional for
   *  call sites that only have agentFolder; required for tools that build a PathResolver. */
  host?: Host;
  /** Participant address. Null for agent-level sockets. */
  participant: string | null;
  /** Channel name. Null for agent-level sockets. */
  channelName: string | null;
  /** Caller's source-conversation qualifier — the sharding sub-key in
   *  `channel~qualifier` form. Carried separately on internal context per
   *  `conversations/parse-channel.ts:5-7`. Threaded into outbound push
   *  payloads so receiver-side rejections route back to the same sharded
   *  sub-cell that issued the push. Null for un-sharded conversations. */
  callerQualifier?: string;
  /** Channel object — needed by tools that gate on `channel.idle_timeout` (single-shot exclusion).
   *  Optional because consoles and agent-level sockets don't have a channel. */
  channel?: AgentChannel;
  /** Per-agent state store. */
  store: AgentStateStore;
  /** Full per-agent database — provides participant registry, request tracking,
   *  approvals, and event logging to MCP tools that need them. Undefined for
   *  console runners (consoles do not have a per-agent DB surface). */
  agentDb?: AgentDb;
  /** Message log bundle — `agentDb.messages` for agent runners, the console
   *  store's messages bundle for console runners. Wires the `message_log__*`
   *  or `console_log__*` tool family depending on which prefix the call site
   *  passes. */
  messageLog?: MessageLogStore;
  /** Merged disabled tools (agent-wide + channel-level). */
  disabledTools?: string[];
  /** Active extension instances for this agent. */
  activeExtensions?: readonly ExtensionInstance[];
  /** Conversation key for the current conversation. Getter allows late binding. */
  getConversationKey?: () => string | null;
  /** Resolved IANA timezone for this agent. */
  timezone?: string;
  /** pip config — when present, pip__install and pip__list tools are registered. */
  pipConfig?: { allowed_packages: string[] };
}

// --- Helpers ---

/** Resolve the staging directories for extension tool calls. */
function resolveStagingContext(ctx: McpAgentContext): ToolCallContext {
  const convKey = ctx.getConversationKey?.() ?? null;
  let base: string;
  if (convKey) {
    base = path.join(agentPath(ctx.agentFolder, 'staging'), conversationKeyToPath(convKey));
  } else {
    // Agent-level socket (no conversation) — use a temp staging dir
    base = path.join(agentPath(ctx.agentFolder, 'staging'), '_agent');
  }
  return { stagingDir: path.join(base, 'in'), stagingOutDir: path.join(base, 'out') };
}

// --- Tool handler types ---

export interface ToolCtx {
  agentFolder: string;
  agentId: string;
  participant: string | null;
  channelName: string | null;
  store: AgentStateStore;
  /** Effective IANA timezone for this agent — used to render tool output and default schedules. */
  agentTz: string;
}

// --- Tool handlers (standalone functions, receive only needed deps) ---

function handleConversationListSummaries(channel: string | undefined, ctx: ToolCtx): ToolResult {
  const channels = channel ? [channel] : undefined;
  let rows = ctx.store.getConversationsWithSummaries(channels, 7 * 86400_000) ?? [];

  // Outside the read tier (system/self ∥ machine-trusted operator surface),
  // only show the caller's own conversations. A peer agent cell is NOT read
  // tier (it carries a *different* agent's address), so it falls here and no
  // longer reads other participants' summaries — closing the M2 leak. A
  // configured `u:` owner is member-tier for reads (read ⊂ write).
  const readTier = isReadTier(ctx.participant, ctx.agentId);
  if (!readTier) {
    rows = rows.filter((r) => !r.participant || r.participant === ctx.participant);
  }

  // No posture filter here: `show_co_participants` is a member↔member control,
  // and the member-tier filter above already reduces the result to the caller's
  // own rows — there is no co-participant row left for posture to drop. The
  // read tier (the agent hosting the room, the machine-trusted operator) is not
  // a co-participant and is deliberately exempt. Posture's live homes are the
  // push verdict, the discovery deps, and prompt assembly.
  const channelsConfig = loadChannelsConfig(ctx.agentFolder);

  // Static policy note when the *current* channel hides co-participants. Keyed on
  // policy, not population, so it never reveals whether other participants exist —
  // and scoped to "this channel" rather than the whole result, since rows from
  // other (flag-on) channels can still legitimately appear. Read-tier callers are
  // exempt from the filter, so the note would be false for them — skip it.
  const currentChannelHides =
    !readTier && !!ctx.channelName && channelsConfig[ctx.channelName]?.show_co_participants === false;
  const visibilityNote =
    "Co-participant visibility is disabled on this channel; other participants' conversations on it are not shown.";

  if (rows.length === 0) {
    return textResult(
      currentChannelHides ? `${visibilityNote} (No conversations to list.)` : 'No recent conversations.',
    );
  }

  const hasOtherParticipants = ctx.participant
    ? rows.some((r) => r.participant && r.participant !== ctx.participant)
    : false;

  const lines = rows.map((r) => {
    const parts: string[] = [];
    if (r.participant) parts.push(`participant: ${r.participant}`);
    parts.push(`channel: ${r.channel_name}`);
    parts.push(`status: ${r.status}`);
    parts.push(`last_activity: ${roughTimeAgo(new Date(r.last_active).getTime())}`);
    if (r.summary) parts.push(`summary: ${r.summary}`);
    return `- ${parts.join(', ')}`;
  });

  // Both notes can apply: the current channel hides its co-participants while
  // results still include other-participant rows from flag-on channels.
  let output = '';
  if (currentChannelHides) {
    output += `${visibilityNote}\n\n`;
  }
  if (hasOtherParticipants) {
    output += 'Note: Results include conversations with other participants. Respect their privacy.\n\n';
  }
  output += lines.join('\n');
  return textResult(output);
}

function handleConversationWriteSummary(
  summary: string,
  store: AgentStateStore | undefined,
  getConversationKey: (() => string | null) | undefined,
): ToolResult {
  const convKey = getConversationKey?.();
  if (!convKey || !store) return textResult('Cannot submit summary: no conversation context.', true);
  store.updateSummary(convKey, summary);
  return textResult('Summary saved.');
}

async function handlePushToChannel(opts: {
  actor: LocalPushActor;
  args: { channel: string; text: string; target_agent?: string };
  deliverToChannel: DeliverToChannel;
  deliverToAgent: DeliverToAgent | undefined;
  resolveAgentByLabel: ((label: string) => string | undefined) | undefined;
}): Promise<ToolResult> {
  const { actor, args, deliverToChannel, deliverToAgent, resolveAgentByLabel } = opts;
  const callerParticipant = actor.participant;
  const callerChannel = actor.channel;
  const callerQualifier = actor.kind === 'user-agent' ? actor.callerQualifier : undefined;

  // Trust-tier-aware parser. User-trust rejects `__*` to prevent prompt-
  // injected user-channel LLMs from minting infrastructure addresses;
  // operator-trust admits `__*` because per-agent consoles legitimately
  // address `__design` / `__configure`. The actor decides which runs —
  // the regex is the structural enforcement of that decision, not a
  // standalone security check.
  const parse = actor.kind === 'user-agent' ? parseChannelString : parseOperatorChannel;
  const parsed = parse(args.channel);
  if (!parsed.ok) return textResult(parsed.reason, true);
  const { channel, qualifier } = parsed.parsed;

  // Resolve `target_agent` BEFORE deriving `sameAgent`. Passing your own
  // agent label is semantically equivalent to omitting `target_agent` —
  // both express an intra-agent push and must run the identical guard set.
  // Deriving `sameAgent` from `!args.target_agent` (the previous shape)
  // skipped guards on the self-target branch, opening a path around the
  // permanent `__configure → __design` exfil-carrier block.
  let resolvedTarget: string;
  if (args.target_agent) {
    if (!resolveAgentByLabel) return textResult('Cross-agent push is not configured.', true);
    const r = resolveAgentByLabel(args.target_agent);
    if (!r) return textResult(`Unknown agent: "${args.target_agent}"`, true);
    resolvedTarget = r;
  } else {
    resolvedTarget = actor.agentId;
  }
  const sameAgent = resolvedTarget === actor.agentId;

  // Compose actor-specific guards. User-agent gets only `selfLoopGuard` —
  // the parser regex already blocks `__*` so console-source / infra guards
  // can't fire. Per-agent console runs the full set because its operator-
  // trust parser admits `__*` channel names and the guards are what keep
  // the trust boundary intact.
  for (const guard of guardsForActor(actor)) {
    const r = guard({ sameAgent, sourceChannel: callerChannel, targetChannel: channel });
    if (r.deny) return textResult(r.reason, true);
  }

  // Fire-and-forget — verbs return after queueing, not after lifecycle. Sync
  // validation errors (unknown participant, ACL denied) come back as
  // `{ ok: false }`; success returns immediately. The async lifecycle
  // — receiver-side ACL deny in particular — flows back as
  // `<cast:rejection request="<id>">` on a future turn; the `id` here is
  // what the LLM matches against to correlate.
  if (sameAgent) {
    const result = await deliverToChannel(
      actor, channel, args.text, callerParticipant,
      callerChannel, callerParticipant, qualifier, callerQualifier,
    );
    if (!result.ok) return textResult(`Push failed: ${result.reason}`, true);
    return textResult(`Queued for delivery to ${args.channel}. id: ${result.requestId}. Delivery is asynchronous and at-most-once; if it fails, a cast:rejection notice referencing this id arrives on a later turn.`);
  }
  if (!deliverToAgent) return textResult('Cross-agent push is not configured.', true);
  const result = await deliverToAgent(
    actor, resolvedTarget, channel, args.text, callerParticipant, qualifier,
    callerChannel, callerQualifier,
  );
  if (!result.ok) return textResult(`Push failed: ${result.reason}`, true);
  const viaLabel = args.target_agent ?? resolvedTarget;
  return textResult(`Queued for delivery to ${args.channel} via ${viaLabel}. id: ${result.requestId}. Delivery is asynchronous and at-most-once; if it fails, a cast:rejection notice referencing this id arrives on a later turn.`);
}

/**
 * Register `conversation__push_to_channel` on `server`. Used by both the
 * agent-side MCP server (user-channel runners) and the per-agent console
 * MCP server (`__design`, `__configure`) — they share the host agent's
 * identity so `target_agent` is optional, but they sit in different trust
 * tiers (user-channel LLMs face hostile inputs; consoles run on operator
 * instructions). The `actor` argument carries both axes — addressing and
 * trust — so the handler can pick the right parser, guard set, and
 * dispatcher gates for the caller. Server-scope consoles (DM/CM/SM)
 * register a different shape via `console/shared/delegate.ts`.
 */
export function registerPushToChannelTool(
  server: McpServer,
  opts: {
    actor: LocalPushActor;
    deliverToChannel: DeliverToChannel;
    deliverToAgent: DeliverToAgent | undefined;
    resolveAgentByLabel: ((label: string) => string | undefined) | undefined;
  },
): void {
  server.tool(
    'conversation__push_to_channel',
    `Push a turn into a different channel for the current participant. Opens or continues a parallel conversation for the same user; the target conversation may be cold or active. Delivery is asynchronous and at-most-once: the tool returns once the turn is queued, not after the target processes it. If delivery fails, a cast:rejection notice referencing the returned id arrives on a later turn.`,
    {
      channel: z.string().describe('Target channel name (e.g., "default"). For sharded channels, use "name~qualifier" to address a specific sub-conversation (e.g., "research~daily").'),
      text: z.string().describe('Message content for the target channel conversation'),
      target_agent: z.string().optional().describe('Target agent label for cross-agent push (e.g., "knowledge"). Omit for a same-agent push (e.g., Design → Configure on the same agent). Passing your own alias is equivalent to omitting.'),
    },
    async (args) => handlePushToChannel({
      actor: opts.actor,
      args,
      deliverToChannel: opts.deliverToChannel,
      deliverToAgent: opts.deliverToAgent,
      resolveAgentByLabel: opts.resolveAgentByLabel,
    }),
  );
}

/**
 * Shared registrar for `conversation__end`. The agent-side caller in
 * `registerTools` gates registration on `ctx.channel?.idle_timeout !== null`
 * (omit on single-shot). The console-side caller in
 * `console/tools.ts:registerConsoleTools` gates on the strategy — all console
 * channels are persistent, so the gate is structural. Caller is responsible
 * for the `isToolDisabled` check; this function only registers.
 */
export function registerConversationEndTool(
  server: McpServer,
  opts: {
    getConversationKey: () => string | null;
    onEndConversation: (
      key: string,
      cooldownMs?: number,
    ) => { accepted: boolean; cooldownSeconds: number; reason?: string };
  },
): void {
  server.tool(
    'conversation__end',
    `End the current conversation after a cooldown period. The conversation expires normally — cleanup and summary run as usual. If the participant sends a message before the cooldown, the end is cancelled and you are notified.

Default cooldown: 300 seconds (5 minutes). Minimum: 60 seconds. Maximum: the channel's idle_timeout.
Not available on single-shot channels (they end automatically).`,
    {
      cooldown_seconds: z.number().int().min(60).max(86400).optional()
        .describe('Seconds before conversation expires. Default 300. Clamped to the channel\'s idle_timeout.'),
    },
    async (args) => {
      const key = opts.getConversationKey();
      if (!key) return { content: [{ type: 'text' as const, text: 'No active conversation.' }], isError: true };
      const result = opts.onEndConversation(key, args.cooldown_seconds);
      if (!result.accepted) return { content: [{ type: 'text' as const, text: result.reason ?? 'Cannot end this conversation.' }], isError: true };
      return { content: [{ type: 'text' as const, text: `Conversation will end in ${result.cooldownSeconds} seconds. If the participant sends a message, the end will be cancelled.` }] };
    },
  );
}

async function handlePushToParticipant(opts: {
  actor: Extract<LocalPushActor, { kind: 'user-agent' }>;
  args: { target_participant: string; channel: string; text: string };
  deliverToChannel: DeliverToChannel;
}): Promise<ToolResult> {
  const { actor, args, deliverToChannel } = opts;
  const callerParticipant = actor.participant;
  const callerChannel = actor.channel;
  const callerQualifier = actor.callerQualifier;

  // User-agent only — per-agent consoles do not register this tool. The
  // user-trust parser blocks `__*` channel names just like push_to_channel.
  const parsed = parseChannelString(args.channel);
  if (!parsed.ok) return textResult(parsed.reason, true);
  const { channel, qualifier } = parsed.parsed;

  // Shape gate at the tool edge: only structurally valid participant
  // addresses proceed. Handler-level (not zod .refine) so the surfaced
  // string is exactly this — it states the expected form and nothing about
  // what the rejected value contained.
  if (!isParticipantAddress(args.target_participant)) {
    return textResult('Invalid target_participant. Use a participant identity as returned by agent__list_participants, e.g. u:abc@srv.', true);
  }

  // Intra-agent only — push_to_participant has no `target_agent` argument.
  // Cross-agent + cross-participant is not a single-step primitive; use
  // r/a (request) and let the receiver's own logic decide whether to push
  // internally.
  const infraGuard = intraAgentInfraGuard({
    sameAgent: true,
    sourceChannel: callerChannel,
    targetChannel: channel,
  });
  if (infraGuard.deny) return textResult(infraGuard.reason, true);

  const result = await deliverToChannel(
    actor,
    channel,
    args.text,
    args.target_participant,
    callerChannel,
    callerParticipant,
    qualifier,
    callerQualifier,
  );
  if (!result.ok) return textResult(`Push failed: ${result.reason}`, true);
  return textResult(`Queued for delivery to ${args.channel}. id: ${result.requestId}. Delivery is asynchronous and at-most-once; if it fails, a cast:rejection notice referencing this id arrives on a later turn.`);
}

function handleListChannels(
  listFn: NonNullable<McpServerDeps['listChannelsFor']>,
  ctx: ToolCtx,
): ToolResult {
  const rows = listFn(ctx.participant);
  if (rows.length === 0) return textResult('No channels to list.');
  const lines = rows.map((r) => {
    const name = r.sharded ? `${r.name}~*` : r.name;
    const standing = r.bits === 'owner' ? '' : ` — your access: ${r.bits}`;
    const posture = r.postureOpen ? '' : ' [co-participant visibility off]';
    const missing = r.missingConfig ? ' [no channel config]' : '';
    return `- ${name}${standing}${posture}${missing}`;
  });
  return textResult(
    `Channels:\n${lines.join('\n')}\n\nUse agent__list_participants with a channel name to see who is reachable there.`,
  );
}

function handleListParticipants(
  listFn: NonNullable<McpServerDeps['listRoomMembers']>,
  ctx: ToolCtx,
  channelArg: string | undefined,
): ToolResult {
  let channel: string | null;
  if (channelArg !== undefined) {
    const parsed = parseChannelString(channelArg);
    if (!parsed.ok) return textResult(parsed.reason, true);
    // Qualifier accepted and dropped — shards share the room's membership.
    channel = parsed.parsed.channel;
  } else {
    // Omitted: the current channel for member-tier callers; the registry
    // (null) for the read tier. A self-fire's cell carries a channel, but
    // the scheduler's notify flows discover recipients beyond the firing
    // channel's membership — "omitted = current" would blind them.
    channel = isReadTier(ctx.participant, ctx.agentId) ? null : ctx.channelName;
  }
  const result = listFn(ctx.participant, channel);
  if (!result.ok) return textResult(result.reason, true);

  if (result.scope === 'registry') {
    // Read-tier flat view — today's rendering, pinned for scheduler flows.
    if (result.members.length === 0) return textResult('No participants found.');
    const formatted = result.members
      .map((p) => `- ${p.identity} (last active: ${p.lastActive})`)
      .join('\n');
    return textResult(`Participants:\n${formatted}`);
  }

  const lines = result.members.map((m) => {
    if (m.kind === 'peer') return `- ${m.identity} — peer agent (request counterparty, not a push target)`;
    const recency = m.lastActive ? `last active: ${m.lastActive}` : 'no session yet';
    return `- ${m.identity} (${recency})`;
  });
  const body = lines.length === 0
    ? `No participants are placed on channel "${channel}".`
    : `Members of "${channel}":\n${lines.join('\n')}`;
  return textResult(result.postureNote ? `${body}\n\n${result.postureNote}` : body);
}



// --- File tool handlers ---

const FILE_APPEND_FEED_DESC =
  `Append a row to a feed at the given container path. A feed is an ordered, append-only JSONL stream that peers observe via file__watch_feed. The framework assigns a monotonic \`id\` starting at 1 so watchers can cursor through rows. Creates the file if it doesn't exist; the parent directory must already exist and be a writable mount.

Row shape: \`{id, data, meta?}\` — \`data\` is your row content (any JSON-serializable value); \`meta\` is optional coordination metadata (agents-only convention, not surfaced to humans).

Use feeds for coordination — shared meeting points between channels or agents, peer event streams, intra-agent rendezvous. Peers watch via file__watch_feed and receive new rows as <cast:watch> fires. Your own appends are auto-suppressed (the framework advances your cursor before the fire arrives), so you only see peer activity.

NOT a journaling / audit / diary tool. For plain-JSONL journals you write to remember things (no peer watching them), use the Edit/Write tool to append rows directly — feeds enforce a strict \`{id, data, meta?}\` envelope that will reject plain JSONL with a corruption error.

Best-effort, not transactional: no host-side locking. Fails closed on corruption (parse error, missing id, non-monotonic) — operator must repair manually.`;

function buildPathResolver(host: Host, conversationKey: string) {
  const resolved = resolveCapabilities(host.folder);
  const mountResources: Record<string, ResourceEntry> = {};
  for (const [name, res] of Object.entries(resolved.resources)) {
    if (res.path) mountResources[name] = { path: res.path, access: res.access };
  }
  return createPathResolver(host, conversationKey, mountResources);
}

function handleFileAppendLog(
  args: { path: string; data: unknown; meta?: unknown },
  ctx: { host: Host; conversationKey: string },
): ToolResult {
  const containerPath = args.path;
  const parentContainer = path.posix.dirname(containerPath);
  const basename = path.posix.basename(containerPath);
  if (!basename || basename === '.' || basename === '..') {
    return textResult(`Invalid path: ${containerPath} — must reference a file inside a mount.`, true);
  }

  const resolver = buildPathResolver(ctx.host, ctx.conversationKey);
  const parent = resolver.resolveWritable(parentContainer);
  if (!parent.ok) {
    switch (parent.kind) {
      case 'invalid-path':
        return textResult(`Invalid parent path for ${containerPath}: ${parent.message}`, true);
      case 'no-mount':
        return textResult(`No writable mount matches parent of ${containerPath} (resolved parent: ${parent.containerPath}).`, true);
      case 'enoent':
        return textResult(`Parent directory does not exist: ${parent.hostPath}. Create it via Bash mkdir -p before appending.`, true);
      case 'symlink':
        return textResult(`Parent directory is a symlink (rejected for security): ${parent.hostPath}.`, true);
      case 'traversal':
        return textResult(`Parent directory escapes the mount root (rejected for security): ${parent.hostPath} not under ${parent.mountRoot}.`, true);
      case 'wrong-mode':
        return textResult(`Parent directory is read-only; cannot append. Choose a writable mount.`, true);
    }
  }

  const targetHostPath = path.join(parent.hostPath, basename);
  const result = appendFeedRow(targetHostPath, ctx.conversationKey, args.data, args.meta);
  if (!result.ok) {
    return textResult(`Feed corruption detected at row offset ${result.rowOffset}: ${result.reason}. Refusing to append. Operator must repair.`, true);
  }
  return textResult(`Appended row id=${result.id} to ${containerPath}.`);
}

const DURATION_RE = /^(\d+)(s|m|h|d)$/;
const MAX_EXPIRES_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_WATCHES = 3;

function parseDurationToIso(input: string, now: Date = new Date()):
  | { ok: true; iso: string }
  | { ok: false; reason: string }
{
  const m = DURATION_RE.exec(input);
  if (!m) return { ok: false, reason: `Invalid duration: "${input}". Use format like "60s", "5m", "2h", "7d".` };
  const n = Number(m[1]);
  const unit = m[2]!;
  const multiplier = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  const ms = n * multiplier;
  if (ms <= 0) return { ok: false, reason: 'Duration must be positive.' };
  if (ms > MAX_EXPIRES_MS) return { ok: false, reason: `Duration exceeds 30-day cap.` };
  return { ok: true, iso: new Date(now.getTime() + ms).toISOString() };
}

function readMaxWatchesPerChannel(folder: string): number {
  try {
    return readAgentConfig(folder).fileWatch?.maxWatchesPerChannel ?? DEFAULT_MAX_WATCHES;
  } catch (err) {
    logger.warn(
      { err, agentFolder: folder },
      'readAgentConfig failed for fileWatch.maxWatchesPerChannel — using default',
    );
    return DEFAULT_MAX_WATCHES;
  }
}

const FILE_WATCH_FEED_DESC =
  `Register a watch on a feed (an ordered JSONL stream written via file__append_feed). The framework fires <cast:watch path="..." since="..." through="..."> tags into your conversation when peers append rows. Your own appends are auto-suppressed (cursor advances before the fire arrives), so you only see peer activity.

Path must already exist — call file__append_feed first to create it (write a placeholder row, or touch by appending). Watches anchor at the feed's current end at registration time, so historical rows are not delivered.

Per-conversation cap: fileWatch.maxWatchesPerChannel (default 3). Use file__list_watches to see current entries; file__unwatch to free a slot.

Optional expiresIn: a duration string like "60s", "5m", "2h", "7d" (max 30d). The field is stored but expiry is not enforced — watches persist until explicitly removed.`;

const FILE_UNWATCH_DESC = 'Drop a previously registered watch on a feed. Errors if the path is not currently watched in this conversation.';

const FILE_LIST_WATCHES_DESC = 'List watches active in this conversation. Each entry shows the feed path, the last id observed, when it was registered, and (if set) when it expires.';

function handleFileWatchLog(
  args: { path: string; expiresIn?: string },
  ctx: {
    folder: string;
    conversationKey: string;
    channel: string;
    participant: string;
    service: FileWatchService;
    agentTz: string;
  },
): Promise<ToolResult> {
  const cap = readMaxWatchesPerChannel(ctx.folder);
  const current = ctx.service.list(ctx.conversationKey).length;
  if (current >= cap) {
    return Promise.resolve(textResult(
      `Watch limit reached (${current}/${cap}). Use file__unwatch to free a slot, or raise fileWatch.maxWatchesPerChannel via Configure.`,
      true,
    ));
  }

  let expiresAt: string | undefined;
  if (args.expiresIn !== undefined) {
    const parsed = parseDurationToIso(args.expiresIn);
    if (!parsed.ok) return Promise.resolve(textResult(parsed.reason, true));
    expiresAt = parsed.iso;
  }

  return ctx.service
    .register(ctx.conversationKey, {
      path: args.path,
      channel: ctx.channel,
      participant: ctx.participant,
      expiresAt,
    })
    .then((result) => {
      if (!result.ok) return textResult(result.reason, true);
      const expirySuffix = expiresAt ? `, expires ${toZonedIso(new Date(expiresAt), ctx.agentTz)}` : '';
      return textResult(
        `Watch registered on ${args.path} (lastSeenId=${result.entry.lastSeenId}${expirySuffix}).`,
      );
    });
}

function handleFileUnwatch(
  args: { path: string },
  ctx: { conversationKey: string; service: FileWatchService },
): ToolResult {
  const existing = ctx.service.list(ctx.conversationKey).some((w) => w.path === args.path);
  if (!existing) {
    return textResult(`No watch on ${args.path} for this conversation.`, true);
  }
  ctx.service.unregister(ctx.conversationKey, args.path);
  return textResult(`Watch on ${args.path} removed.`);
}

function handleFileListWatches(
  ctx: { conversationKey: string; service: FileWatchService; agentTz: string },
): ToolResult {
  const entries = ctx.service.list(ctx.conversationKey);
  if (entries.length === 0) return textResult('No watches in this conversation.');
  const lines = entries.map((e) => {
    const registered = toZonedIso(new Date(e.registered), ctx.agentTz);
    const expires = e.expiresAt ? `, expires ${toZonedIso(new Date(e.expiresAt), ctx.agentTz)}` : '';
    return `- ${e.path} — last id ${e.lastSeenId}, registered ${registered}${expires}`;
  });
  return textResult(`Watches:\n${lines.join('\n')}`);
}

// --- Tool registration (wiring manifest) ---

export function registerTools(server: McpServer, ctx: McpAgentContext, deps: McpServerDeps): void {
  const { disabledTools = [], agentDb, getConversationKey } = ctx;
  const disabled = (name: string) => isToolDisabled(name, disabledTools);
  const agentTz = ctx.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const toolCtx: ToolCtx = {
    agentFolder: ctx.agentFolder,
    agentId: ctx.agentId,
    participant: ctx.participant,
    channelName: ctx.channelName,
    store: ctx.store,
    agentTz,
  };

  registerTaskTools(server, ctx, toolCtx);

  if (!disabled('conversation__list_summaries')) server.tool(
    'conversation__list_summaries', 'List recent conversations across channels. Shows participant, status, last activity, and summary (if available).',
    { channel: z.string().optional().describe('Filter to a specific channel name') },
    async (args) => handleConversationListSummaries(args.channel, toolCtx),
  );

  if (!disabled('conversation__write_summary')) server.tool(
    'conversation__write_summary', 'Submit a summary of the current conversation. The summary is stored and visible via conversation__list_summaries. Use this to record key decisions, action items, and outcomes.',
    { summary: z.string().describe('A concise summary of the conversation — focus on decisions, action items, and key outcomes') },
    async (args) => handleConversationWriteSummary(args.summary, ctx.store, getConversationKey),
  );

  // file__* tools — all gated on (a) host wired (path resolver), (b) conversation context exists,
  // (c) channel + participant context. file__append_feed registers here. The watch tools register
  // in the separate block below, which additionally requires deps.getFileWatchService and a
  // non-single-shot channel (see there for why).
  const fileToolHost = ctx.host;
  const fileToolChannel = ctx.channelName;
  const fileToolParticipant = ctx.participant;
  if (
    fileToolHost
    && getConversationKey
    && ctx.channel
    && fileToolChannel
    && fileToolParticipant
  ) {
    // file__append_feed is available on single-shot channels too: appending is a fire-and-forget
    // synchronous write (fs.appendFileSync), with no dependency on future turns. A single-shot
    // channel recording into a feed that persistent peers watch elsewhere is a valid pattern.
    if (!disabled('file__append_feed')) {
      server.tool(
        'file__append_feed',
        FILE_APPEND_FEED_DESC,
        {
          path: z.string().describe('Container-side path to the feed (e.g. /memory/letter.jsonl). Parent directory must exist and be on a writable mount.'),
          data: z.unknown().describe('Row content — any JSON-serializable value. Surfaced to humans/transports by convention.'),
          meta: z.unknown().optional().describe('Optional coordination metadata — agents-only by convention, not surfaced to humans.'),
        },
        async (args) => {
          const convKey = getConversationKey();
          if (!convKey) return textResult('No active conversation.', true);
          return handleFileAppendLog(args, { host: fileToolHost, conversationKey: convKey });
        },
      );
    }
  }

  // Watch tools (file__watch_feed / file__unwatch / file__list_watches) — same context prerequisites
  // as file__append_feed, plus (d) deps.getFileWatchService and (e) the channel is NOT single-shot.
  // Watch fires arrive as <cast:watch> tags injected into future turns; a single-shot conversation
  // ends after one turn and has no future turn for a fire to land on, so watches are omitted there.
  const getSvc = deps.getFileWatchService;
  if (
    fileToolHost
    && getConversationKey
    && ctx.channel
    && ctx.channel.idle_timeout !== null
    && fileToolChannel
    && fileToolParticipant
    && getSvc
  ) {
    if (!disabled('file__watch_feed')) {
      server.tool(
        'file__watch_feed',
        FILE_WATCH_FEED_DESC,
        {
          path: z.string().describe('Container-side path to a feed you want to watch (e.g. /memory/letter.jsonl). Must already exist — call file__append_feed first if needed.'),
          expiresIn: z.string().optional().describe('Optional auto-expiry. Format: number + unit (s|m|h|d), e.g. "60s", "5m", "2h", "7d". Max 30d.'),
        },
        async (args) => {
          const convKey = getConversationKey();
          if (!convKey) return textResult('No active conversation.', true);
          return handleFileWatchLog(args, {
            folder: ctx.agentFolder,
            conversationKey: convKey,
            channel: fileToolChannel,
            participant: fileToolParticipant,
            service: getSvc(),
            agentTz,
          });
        },
      );
    }

    if (!disabled('file__unwatch')) {
      server.tool(
        'file__unwatch',
        FILE_UNWATCH_DESC,
        {
          path: z.string().describe('Container-side path of the watch to drop (must match what was passed to file__watch_feed).'),
        },
        async (args) => {
          const convKey = getConversationKey();
          if (!convKey) return textResult('No active conversation.', true);
          return handleFileUnwatch(args, { conversationKey: convKey, service: getSvc() });
        },
      );
    }

    if (!disabled('file__list_watches')) {
      server.tool(
        'file__list_watches',
        FILE_LIST_WATCHES_DESC,
        {},
        async () => {
          const convKey = getConversationKey();
          if (!convKey) return textResult('No active conversation.', true);
          return handleFileListWatches({ conversationKey: convKey, service: getSvc(), agentTz });
        },
      );
    }
  }

  // conversation__end — agent-requested conversation end with cooldown.
  // Gated on persistent channels: single-shot conversations end automatically
  // and have nothing to release. Asymmetric pair with the handler-time
  // `isExpired` guard in `requestConversationEnd` — MCP can't un-register
  // mid-session, so dynamic state (cleanup turn) is rejected at handler time
  // while static state (single-shot) is omitted at registration.
  if (
    deps.onEndConversation
    && getConversationKey
    && ctx.channel?.idle_timeout !== null
    && !disabled('conversation__end')
  ) {
    registerConversationEndTool(server, {
      getConversationKey,
      onEndConversation: deps.onEndConversation,
    });
  }

  // Push tools only register when the runtime has wired both `deliverToChannel`
  // and a participant/channel context — that pair stamps a user-agent actor.
  // Agent-level sockets (no conversation) and console sockets construct their
  // own actor at their registration site, not here.
  const pushToChannelEnabled = deps.deliverToChannel && !disabled('conversation__push_to_channel') && ctx.participant && ctx.channelName;
  const pushToParticipantEnabled = deps.deliverToChannel && !disabled('conversation__push_to_participant') && ctx.participant && ctx.channelName;

  if (pushToChannelEnabled) {
    const userActor: LocalPushActor = {
      kind: 'user-agent',
      agentId: ctx.agentId,
      channel: ctx.channelName!,
      participant: ctx.participant!,
      callerQualifier: ctx.callerQualifier,
    };
    registerPushToChannelTool(server, {
      actor: userActor,
      deliverToChannel: deps.deliverToChannel!,
      deliverToAgent: deps.deliverToAgent,
      resolveAgentByLabel: deps.resolveAgentByLabel,
    });
  }

  if (pushToParticipantEnabled) {
    const deliverToChannel = deps.deliverToChannel!;
    const userActor: Extract<LocalPushActor, { kind: 'user-agent' }> = {
      kind: 'user-agent',
      agentId: ctx.agentId,
      channel: ctx.channelName!,
      participant: ctx.participant!,
      callerQualifier: ctx.callerQualifier,
    };
    server.tool(
      'conversation__push_to_participant',
      `Push a turn into another participant's conversation on this agent. The target participant's runner sees it as a new turn (intra-agent only — no target_agent option). Delivery is asynchronous and at-most-once: the tool returns once the turn is queued, not after the target processes it. If delivery fails, a cast:rejection notice referencing the returned id arrives on a later turn.`,
      {
        target_participant: z.string().describe('Target participant identity as returned by agent__list_participants (e.g. `u:abc@srv`)'),
        channel: z.string().describe('Target channel name. For sharded channels, use "name~qualifier" to address a specific sub-conversation.'),
        text: z.string().describe('Message content for the target participant conversation'),
      },
      async (args) => handlePushToParticipant({
        actor: userActor,
        args,
        deliverToChannel,
      }),
    );
  }

  // Request management tools — available when agentDb and channel context exist
  const reqDb = agentDb;
  const reqCh = ctx.channelName;
  const reqPart = ctx.participant;
  const hasRequestContext = reqDb && reqCh && reqPart;
  if (hasRequestContext && !disabled('request__list')) {
    server.tool(
      'request__list',
      'List open requests for the current channel and participant. Shows both inbound (queries you received) and outbound (queries you sent), with status and age.',
      {},
      async () => {
        const { inbound, outbound } = reqDb.listRequests(reqCh, reqPart);
        if (inbound.length === 0 && outbound.length === 0) {
          return textResult('No requests found for this context.');
        }
        const lines: string[] = [];
        if (outbound.length > 0) {
          lines.push('## Outbound (queries you sent)');
          for (const r of outbound) {
            lines.push(`- [${r.status}] ${r.request_id} → ${r.target_agent} (${r.target_channel}) — ${roughTimeAgo(new Date(r.created_at).getTime())}`);
          }
        }
        if (inbound.length > 0) {
          lines.push('## Inbound (queries you received)');
          for (const r of inbound) {
            lines.push(`- [${r.status}] ${r.request_id} from ${r.from_agent} — ${roughTimeAgo(new Date(r.created_at).getTime())}`);
          }
        }
        return textResult(lines.join('\n'));
      },
    );
  }

  if (hasRequestContext && !disabled('request__close')) {
    const routeRejection = deps.routeRejection;
    server.tool(
      'request__close',
      'Close a request by ID. Closing an outbound request means "I no longer need this answer." Closing an inbound request means "I am declining this" and sends a rejection back to the requester.',
      { request_id: z.string().describe('The request ID to close') },
      async (args) => {
        // Check outbound first
        const outReq = reqDb.getOutboundRequest(args.request_id);
        if (outReq && outReq.status === 'open') {
          if (outReq.channel !== reqCh || outReq.participant !== reqPart) {
            return textResult(`Request ${args.request_id} belongs to a different context.`, true);
          }
          reqDb.updateRequestStatus('outbound', args.request_id, 'closed');
          return textResult(`Closed outbound request ${args.request_id}.`);
        }
        // Check inbound
        const inReq = reqDb.getInboundRequest(args.request_id);
        if (inReq && inReq.status === 'open') {
          if (inReq.channel !== reqCh || inReq.participant !== reqPart) {
            return textResult(`Request ${args.request_id} belongs to a different context.`, true);
          }
          reqDb.updateRequestStatus('inbound', args.request_id, 'closed');
          if (routeRejection) {
            await routeRejection(args.request_id, inReq.return_to_agent, inReq.return_to_channel, inReq.return_to_participant, 'Declined by agent.');
          }
          return textResult(`Closed inbound request ${args.request_id} and sent rejection.`);
        }
        return textResult(`Request ${args.request_id} not found or already closed.`, true);
      },
    );
  }

  if (hasRequestContext && !disabled('request__close_all')) {
    const routeRejection = deps.routeRejection;
    server.tool(
      'request__close_all',
      'Close all open requests for the current channel and participant. Sends rejections for all inbound requests.',
      {},
      async () => {
        const { closedInbound, closedOutboundCount } = reqDb.closeAllRequests(reqCh, reqPart);
        if (routeRejection) {
          for (const req of closedInbound) {
            await routeRejection(req.request_id, req.return_to_agent, req.return_to_channel, req.return_to_participant, 'Declined by agent (close all).');
          }
        }
        const total = closedInbound.length + closedOutboundCount;
        if (total === 0) return textResult('No open requests to close.');
        return textResult(`Closed ${closedInbound.length} inbound + ${closedOutboundCount} outbound requests.`);
      },
    );
  }

  registerAgentPeerTools(server, ctx, deps);

  // Discovery tools — registration is capability-wide (every conversation
  // cell, including peer cells, plus owner-context sockets); SCOPING lives in
  // the deps, which mirror the push verdict's caller standing
  // (`auth/conversation-context.ts`). A peer cell registers and sees exactly
  // its own rooms — the M1 roster-leak closure is scope, not absence.
  // Cell-side `disabled_tools` disarms a cell wholesale; room-side posture
  // (`show_co_participants`) hides a room's members from member-tier callers
  // everywhere — two different switches, both honored through the dep.
  const systemContext = isSystemContext(ctx.participant, ctx.agentId);
  const discoveryContext = Boolean(ctx.participant) || systemContext;

  if (deps.listChannelsFor && !disabled('agent__list_channels') && discoveryContext) {
    const listFn = deps.listChannelsFor;
    server.tool(
      'agent__list_channels',
      'List the channels (rooms) on this agent where you are placed — where conversation__push_to_participant can land. Sharded channels render as `name~*`; substitute a qualifier (e.g. `name~daily`) to address a sub-conversation.',
      {},
      async () => handleListChannels(listFn, toolCtx),
    );
  }

  if (deps.listRoomMembers && !disabled('agent__list_participants') && discoveryContext) {
    const listFn = deps.listRoomMembers;
    server.tool(
      'agent__list_participants',
      'List the members of a channel you are placed in — identities in the exact form conversation__push_to_participant accepts, with last-activity recency. Omit `channel` for the current channel (the agent itself and operator surfaces get the agent-wide registry).',
      {
        channel: z.string().optional().describe(
          'Channel name. Accepts `name~qualifier`; the qualifier is ignored — shards share the room\'s membership. Defaults to the current channel.',
        ),
      },
      async (args) => handleListParticipants(listFn, toolCtx, args.channel),
    );
  }

  if (ctx.messageLog) {
    registerMessageLogTools(server, {
      store: ctx.messageLog,
      participant: ctx.participant,
      toolPrefix: 'message_log__',
      agentTz,
      disabledTools,
    });
  }

  // --- Extension tools ---

  for (const ext of ctx.activeExtensions ?? []) {
    for (const tool of ext.tools) {
      if (disabled(tool.name)) continue;

      if (tool.approval?.enabled && deps.requestApproval && ctx.participant) {
        // Approval-gated tool: wrap handler with filter + requestApproval flow
        const approval = tool.approval;
        const requestApproval = deps.requestApproval;
        const approvalDb = agentDb;
        const filterCtx = {
          wasApproved: (tools: string[], match: (a: Record<string, unknown>) => boolean) => {
            const convKey = ctx.getConversationKey?.() ?? null;
            if (!convKey || !approvalDb) return false;
            return approvalDb.hasApprovalInConversation({ conversationKey: convKey, tools, argsMatch: match });
          },
        };
        server.tool(
          tool.name,
          tool.description,
          tool.schema,
          async (args) => {
            const typedArgs = args as Record<string, unknown>;

            let decision: 'approve' | 'skip' | 'block' = 'approve';
            if (approval.filter) {
              try { decision = approval.filter(typedArgs, filterCtx); } catch (err) {
                logger.warn({ tool: tool.name, err }, 'Approval filter threw — blocking');
                approvalDb?.logEvent('error', 'service', 'approval_filter_threw', `Approval filter threw for ${tool.name}`, {
                  context: { tool: tool.name, error: String(err) },
                });
                return textResult(`Tool call blocked: ${tool.name}`, true);
              }
            }

            if (decision === 'block') return textResult(`Tool call blocked: ${tool.name}`, true);

            if (decision === 'skip') {
              const callCtx = { ...resolveStagingContext(ctx), participant: ctx.participant ?? undefined };
              return ext.handle(tool.name, typedArgs, callCtx);
            }

            // 'approve' — request human approval
            let summary: string;
            let details: string | undefined;
            try {
              const preview = approval.preview(typedArgs);
              summary = preview.summary;
              details = preview.details;
            } catch (err) {
              logger.warn({ tool: tool.name, err }, 'Approval preview threw — using generic');
              summary = `Execute ${tool.name}`;
            }

            const { id: approvalId, pendingCount } = requestApproval({
              tool: tool.name,
              args: typedArgs,
              summary,
              details,
              participant: ctx.participant!,
              channel: ctx.channelName ?? undefined,
              conversationKey: ctx.getConversationKey?.() ?? undefined,
              expiresIn: approval.expiry,
            });

            const pendingNote = pendingCount > 1 ? ` (${pendingCount} pending approvals for this participant)` : '';
            return textResult(
              `Approval pending (${approvalId}): ${summary}.${pendingNote} ` +
              'An interactive approval prompt has been sent to the participant.',
            );
          },
        );
      } else {
        // Normal tool (no approval, approval disabled, or no participant)
        server.tool(
          tool.name,
          tool.description,
          tool.schema,
          async (args) => {
            const callCtx = { ...resolveStagingContext(ctx), participant: ctx.participant ?? undefined };
            return ext.handle(tool.name, args as Record<string, unknown>, callCtx);
          },
        );
      }
    }
  }

  // --- Approval tools ---

  registerApprovalTools(server, ctx);

  // --- Time tools ---

  registerTimeTools(server, ctx, agentTz);

  // --- pip tools (gated on pipConfig) ---

  registerPipTools(server, ctx);
}

// --- Socket server ---

interface SocketSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
}

/**
 * Start a host-side MCP server for a specific agent on a Unix domain socket.
 *
 * @returns cleanup function to close the server and remove the socket file
 */
export function startMcpSocketServer(
  socketPath: string,
  ctx: McpAgentContext,
  deps: McpServerDeps,
): { ready: Promise<void>; close: () => void; port?: number } {
  if (mcpTransport().mode === 'socket') {
    // Clean stale socket from prior crash
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
  }

  // Ensure parent directory exists (used for socket file in socket mode, still needed for path structure)
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });

  const sessions = new Map<string, SocketSession>();

  const httpServer = http.createServer(async (req, res) => {
    // Handle DELETE (session termination)
    if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined; // single-valued HTTP header
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (session) {
        sessions.delete(sessionId!);
        try { await session.transport.close(); } catch { /* already closed */ }
      }
      res.writeHead(200).end();
      return;
    }

    // Route to existing session
    const sessionId = req.headers['mcp-session-id'] as string | undefined; // single-valued HTTP header
    if (sessionId && sessions.has(sessionId)) {
      await sessions.get(sessionId)!.transport.handleRequest(req, res);
      return;
    }

    // New session (POST with initialize)
    if (req.method === 'POST') {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => generateId('session'),
      });

      const server = new McpServer({ name: 'cast', version: '1.0.0' });
      registerTools(server, ctx, deps);
      await server.connect(transport);
      await transport.handleRequest(req, res);

      // Store session after initialize is processed (sessionId is now set)
      if (transport.sessionId) {
        sessions.set(transport.sessionId, { transport, server });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
      }
      return;
    }

    res.writeHead(405).end();
  });

  let assignedPort: number | undefined;

  const transport = mcpTransport();
  const ready = new Promise<void>((resolve, reject) => {
    if (transport.mode === 'tcp') {
      httpServer.listen(0, transport.bindAddr, () => {
        const addr = httpServer.address() as AddressInfo;
        assignedPort = addr.port;
        logger.info({ port: assignedPort, agentFolder: ctx.agentFolder }, 'MCP TCP server listening');
        resolve();
      });
    } else {
      httpServer.listen(socketPath, () => {
        // Make socket accessible to all users (container runs agent as non-root 'node' user)
        try { fs.chmodSync(socketPath, 0o777); } catch { /* best effort */ }
        logger.info({ socketPath, agentFolder: ctx.agentFolder }, 'MCP socket server listening');
        resolve();
      });
    }
    httpServer.on('error', reject);
  });

  return {
    ready,
    get port() { return assignedPort; },
    close: () => {
      for (const session of sessions.values()) {
        session.transport.close().catch((err) => logger.debug({ err }, 'mcp-server transport close error'));
      }
      sessions.clear();
      httpServer.close();
      if (mcpTransport().mode === 'socket') {
        try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
      }
    },
  };
}
