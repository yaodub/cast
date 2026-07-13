/**
 * SpawnHooks construction for AgentManager-owned ConversationRunners.
 *
 * The hooks are how a runner reports back to its owning agent: session id,
 * outbound output/request/response packets, typing events, lifecycle phases.
 * Lives in its own file so AgentManager stays focused on state ownership and
 * orchestration; the per-event branching belongs here.
 */
import { z } from 'zod';

import { aclVerdict, canEmit, checkAcl, getPeerChannels, hasBit } from '../auth/acl.js';
import {
  deriveChannelContract,
  renderContractForRejection,
} from '../auth/channel-contract.js';
import type { Bus } from '../gateway/bus.js';
import type { ConversationPkt, PreviewPkt } from '../gateway/packets.js';
import { escapeXml, formatMessages } from '../lib/format.js';
import { generateId } from '../lib/utils.js';
import { logger } from '../logger.js';
import { buildLifecycleEvtData } from '../conversations/lifecycle-render.js';

import type { AgentDb } from './agent-db.js';
import type { ApprovalHandler } from './approval-handler.js';
import {
  ALREADY_PENDING_NOTICE,
  mintCorrelationCode,
  pendingNotice,
  recordBounce,
} from './agent-bus-handler.js';
import type { SpawnHooks } from './conversation-runner.js';
import type { AgentChannel } from '../conversations/types.js';
import type { AgentStateStore } from './state-store.js';
import type { ConversationView } from '../conversations/conversation.js';

const StringArraySchema = z.array(z.string()).catch([]);

function parseStringArray(json: string): string[] {
  try { return StringArraySchema.parse(JSON.parse(json)); } catch { return []; }
}

/**
 * Compute the upstream set for a (channel, participant) context.
 * Union of: self + from_agent from each open inbound request + their upstream_sets.
 */
export function computeUpstreamSet(
  agentDb: AgentDb,
  selfId: string,
  channel: string,
  participant: string,
): Set<string> {
  const set = new Set<string>([selfId]);
  for (const req of agentDb.getOpenInboundRequests(channel, participant)) {
    set.add(req.from_agent);
    for (const id of parseStringArray(req.upstream_set)) {
      set.add(id);
    }
  }
  return set;
}

/** Format a system feedback message for undelivered output. Wrapped in <messages> for SDK compatibility. */
export function systemUndelivered(reason: string, droppedText: string, timezone?: string): string {
  const body = `<system>\n${reason}\n<message>${escapeXml(droppedText)}</message>\n</system>`;
  return formatMessages(
    [
      {
        id: '',
        address: '',
        sender: 'system',
        sender_name: 'system',
        content: body,
        timestamp: new Date().toISOString(),
      },
    ],
    timezone,
  );
}

/**
 * Format a system feedback message for output that failed validation (malformed
 * cast tags or size violation). Pushed to the agent via `runner.deliver()` so
 * the next turn sees the rejection and can self-correct.
 *
 * Truncates the dropped raw payload (first 500 + last 500 bytes when >1KB) so
 * a 50KB malformed dump doesn't burn the agent's context window when echoed back.
 */
export function systemFormatError(reasons: string[], droppedRaw: string, timezone?: string): string {
  const reasonList = reasons.map((r) => `- ${r}`).join('\n');
  let shownPayload: string;
  if (droppedRaw.length > 1000) {
    const truncated = droppedRaw.length - 1000;
    shownPayload = `${droppedRaw.slice(0, 500)}…[${truncated} bytes truncated]…${droppedRaw.slice(-500)}`;
  } else {
    shownPayload = droppedRaw;
  }
  const body = `<system>\nOutput rejected. Errors:\n${reasonList}\n\nYour output (${droppedRaw.length > 1000 ? 'first 500 + last 500 bytes shown' : 'shown in full'}):\n<message>${escapeXml(shownPayload)}</message>\n\nResend with valid format. For long content, write to /staging/out/ and reference the file in a short message.\n</system>`;
  return formatMessages(
    [
      {
        id: '',
        address: '',
        sender: 'system',
        sender_name: 'system',
        content: body,
        timestamp: new Date().toISOString(),
      },
    ],
    timezone,
  );
}

export interface SpawnHookDeps {
  agentId: string;
  folder: string;
  bus: Bus;
  agentDb: AgentDb;
  store: AgentStateStore;
  /** Returns the timezone effective at hook-firing time (mutable on AgentManager). */
  getTimezone: () => string;
  /** Approval handler, for the outbound containment gate — raises an
   *  owner-directed acl-edge approval on an askable outbound reach. Function form
   *  because the handler is initialized after the hook deps are first shaped.
   *  Optional: console managers (operator-trust authoring surfaces) have no
   *  per-agent approval handler, so an askable outbound edge there hard-denies
   *  as before rather than raising. */
  getApprovals?: () => ApprovalHandler;
}

/**
 * A held outbound cross-agent request. On an askable containment edge
 * the would-be request is stashed in the owner approval's payload and re-emitted
 * verbatim (`emitOutboundRequest`) once the owner grants `q`/`r`. `channel` /
 * `qualifier` address the TARGET; `returnTo*` are the sender's own cell (where
 * the answer lands, and where a decline notice is delivered).
 */
export const HeldOutboundRequestSchema = z.object({
  target: z.string(),
  kind: z.enum(['query', 'request']),
  text: z.string(),
  requestId: z.string(),
  channel: z.string(),
  qualifier: z.string().optional(),
  returnToChannel: z.string(),
  returnToParticipant: z.string(),
  returnToQualifier: z.string().optional(),
  upstreamSet: z.array(z.string()),
});
export type HeldOutboundRequest = z.infer<typeof HeldOutboundRequestSchema>;

/**
 * Record + route an outbound cross-agent request — the shared emit tail used by
 * the granted path and by the owner-grant re-emit. Idempotent on the
 * caller's `requestId` (minted once at hold/emit time so the re-emit reuses it).
 */
export function emitOutboundRequest(
  deps: Pick<SpawnHookDeps, 'agentId' | 'bus' | 'agentDb'>,
  held: HeldOutboundRequest,
): void {
  deps.agentDb.recordOutboundRequest({
    requestId: held.requestId,
    targetAgent: held.target,
    targetChannel: held.channel,
    channel: held.returnToChannel,
    participant: held.returnToParticipant,
    kind: held.kind,
  });
  // Fire-and-forget: awaiting would deadlock the sender's outputChain.
  deps.bus
    .routeMessage(deps.agentId, held.target, {
      type: 'request' as const,
      kind: held.kind,
      text: held.text,
      requestId: held.requestId,
      channel: held.channel,
      returnToAgent: deps.agentId,
      returnToChannel: held.returnToChannel,
      returnToParticipant: held.returnToParticipant,
      returnToQualifier: held.returnToQualifier,
      upstreamSet: held.upstreamSet,
      routing: { channel: held.channel, qualifier: held.qualifier },
    })
    .catch((err) => {
      logger.error(
        { agentId: deps.agentId, target: held.target, requestId: held.requestId, kind: held.kind, err },
        `Outbound ${held.kind} routing failed`,
      );
    });
}

/**
 * Per-spawn ctx shape that `buildSpawnHooks` reads from the host's typed
 * spawn-context. Both `AgentSpawnContext` and `ConsoleSpawnContext` extend
 * this — the helper requires `TCtx extends SpawnHookCtxFields` so the view's
 * ctx narrows correctly. J.6e dropped the structural `SpawnHookCtx` shim;
 * the helper now reads from a `ConversationView<TCtx>` directly.
 */
export interface SpawnHookCtxFields {
  readonly channelName: string;
  readonly participant?: string;
  readonly qualifier?: string;
  readonly channel: AgentChannel;
}

/**
 * Resolve a `<cast:query target="...">` value to a canonical bus address.
 * Accepts three documented forms:
 *   - "agent:alias"  — explicit prefix; resolved via label lookup
 *   - "alias"        — bare alias; resolved via boundary resolver
 *   - "a:guid@idp"   — already canonical; passes through
 * Returns the original input if no entity is registered (downstream lookup
 * then misses loudly — same as the alias-not-registered ACL case).
 */
function resolveAgentAddress(bus: Bus, addr: string): string {
  if (addr.startsWith('agent:')) {
    return bus.resolveByLabel(addr.slice('agent:'.length)) ?? addr;
  }
  return bus.resolveAddress(addr) ?? addr;
}

function handleSessionId(
  deps: SpawnHookDeps,
  conv: ConversationView<SpawnHookCtxFields>,
  sessionId: string,
): void {
  const ctx = expectCtx(conv);
  const existing = deps.store.getActiveConversation(conv.key);
  if (existing) {
    deps.store.updateCcSessionId(conv.key, sessionId);
  } else {
    deps.store.upsertConversation(conv.key, {
      channelName: ctx.channelName,
      participant: ctx.participant ?? null,
      qualifier: ctx.qualifier ?? null,
      ccSessionId: sessionId,
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      ttl: ctx.channel.idle_timeout,
      status: 'active',
      summary: null,
    });
  }
}

/** Push framework-injected feedback (ACL rejection, validation hint,
 *  lifecycle notice) back into the conversation. `kind: 'system'` keeps the
 *  streamer on its current streamId so retry seals update the same bubble. */
function deliverSystem(conv: ConversationView<SpawnHookCtxFields>, text: string): void {
  void conv.deliver(text, { kind: 'system' });
}

function expectCtx(conv: ConversationView<SpawnHookCtxFields>): SpawnHookCtxFields {
  const ctx = conv.ctx;
  if (ctx === undefined) {
    throw new Error(
      `agent-spawn-hooks: missing ctx on conversation ${conv.scope}/${conv.key}`,
    );
  }
  return ctx;
}

/** One durable trace per (conversation, channel, recipient) for denied preview
 *  streams. Keyed on the conversation view object so entries die with the
 *  conversation — no unbounded growth, no explicit cleanup. */
const previewDenyTraced = new WeakMap<object, Set<string>>();

/** Silent-deny ACL gate for preview frames — same `o`-bit check as
 *  `handleOutboundOutput` but skips the `systemUndelivered` notice on deny
 *  (frame spam: the eventual seal fires the conversation-facing notice once).
 *  The DENY itself still leaves one durable message_log row, because the
 *  "eventual seal" is a behavioral assumption, not a guarantee — a turn that
 *  streams previews to a denied recipient and never seals to them would
 *  otherwise vanish without a trace anywhere. */
function handleOutboundPreview(
  deps: SpawnHookDeps,
  conv: ConversationView<SpawnHookCtxFields>,
  pkt: PreviewPkt,
  channel: string,
  conversationKey: string,
): void {
  if (pkt.to === deps.agentId) return;
  const { bits } = checkAcl(deps.bus, deps.folder, pkt.to, channel);
  if (!hasBit(bits, 'o')) {
    // Honor the channel's log_messages opt-out — same gate that controls the
    // runner-side message_log injection.
    const ctx = conv.ctx;
    if (ctx && ctx.channel.log_messages !== false) {
      const seen = previewDenyTraced.get(conv) ?? new Set<string>();
      const dedupKey = `${channel}|${pkt.to}`;
      if (!seen.has(dedupKey)) {
        seen.add(dedupKey);
        previewDenyTraced.set(conv, seen);
        logger.debug(
          { agentFolder: deps.folder, to: pkt.to, channel },
          'Outbound preview stream blocked (ACL — no o bit); durable trace written',
        );
        // Hand-wrapped `<cast:system>` to match deliver()'s framework-kind log
        // convention — the provenance signal audit queries key on.
        deps.agentDb.messages.logInbound(
          ctx.participant ?? deps.agentId,
          'system',
          `<cast:system>Preview stream to ${pkt.to} on channel "${channel}" was dropped (no outbound conversation permitted).</cast:system>`,
          channel,
          conversationKey,
        );
      }
    }
    return;
  }
  void deps.bus.routeMessage(pkt.from, pkt.to, { pkt, channel, conversationKey });
}

async function handleOutboundOutput(
  deps: SpawnHookDeps,
  conv: ConversationView<SpawnHookCtxFields>,
  pkt: ConversationPkt,
  channel: string,
  conversationKey: string,
): Promise<void> {
  // Self-addressed: output has no external recipient (e.g. service-initiated work).
  if (pkt.to === deps.agentId) return;

  const { bits } = checkAcl(deps.bus, deps.folder, pkt.to, channel);
  if (!hasBit(bits, 'o')) {
    logger.info(
      { agentFolder: deps.folder, to: pkt.to },
      'Outbound message blocked (ACL — no o bit)',
    );
    // Three rejection shapes, in priority order:
    //   1. Peer-channel contract is structured-only (a/q/r) — render it via
    //      channel-contract so the agent sees the exact envelopes that *are*
    //      deliverable here. This is the case that produces the loop bug
    //      when the agent emits prose alongside a valid envelope; the
    //      contract block in the prompt teaches the contract up-front and
    //      this rejection echoes the same vocabulary.
    //   2. Peer not in ACL — "stop addressing this peer."
    //   3. Peer in ACL but no `o` anywhere — read-only contact.
    //   4. Peer in ACL with `o` on other channels — redirect.
    // Keep aligned with `renderContractForPrompt` in `auth/channel-contract.ts`.
    const contract = deriveChannelContract(bits);
    const hasAnyStructured =
      contract.send.query || contract.send.request || contract.receive.structuredInbound;
    let detail: string;
    if (hasAnyStructured) {
      detail = renderContractForRejection(contract);
    } else {
      const peerChannels = getPeerChannels(deps.bus, deps.folder, pkt.to);
      const sendChannels = peerChannels
        ?.filter((c) => c.bits.includes('o'))
        .map((c) => c.name) ?? [];
      detail = peerChannels === undefined
        ? `${pkt.to} is not in your ACL — do not retry, this contact is not authorized for outbound from this agent`
        : sendChannels.length === 0
          ? `no outbound conversation is permitted to ${pkt.to} on any channel — this contact path is not authorized; do not retry`
          : `no outbound conversation on channel "${channel}" — you can send to ${pkt.to} on: ${sendChannels.join(', ')}`;
    }
    deliverSystem(
      conv,
      systemUndelivered(
        `Message to ${pkt.to} was not delivered. ${detail}`,
        pkt.text,
        deps.getTimezone(),
      ),
    );
    return;
  }
  await deps.bus.routeMessage(pkt.from, pkt.to, {
    pkt,
    channel,
    conversationKey,
  });
}

async function handleOutboundRequest(
  deps: SpawnHookDeps,
  conv: ConversationView<SpawnHookCtxFields>,
  kind: 'query' | 'request',
  rawTarget: string,
  channel: string,
  text: string,
  qualifier?: string,
): Promise<void> {
  const target = resolveAgentAddress(deps.bus, rawTarget);
  const ctx = expectCtx(conv);
  const participant = ctx.participant ?? deps.agentId;
  const verbCap = kind === 'query' ? 'Query' : 'Request';

  const rejectRequest = (reason: string) => {
    deps.agentDb.recordOutboundRequest({
      requestId: generateId('req'),
      targetAgent: target,
      targetChannel: channel,
      channel: ctx.channelName,
      participant,
      kind,
      status: 'rejected',
    });
    deliverSystem(
      conv,
      systemUndelivered(
        `${verbCap} to ${rawTarget} was not delivered (${reason}).`,
        text,
        deps.getTimezone(),
      ),
    );
  };

  // Resolve the target + cycle-check BEFORE the containment gate: a
  // missing target or a cycle is a hard structural failure, and we must not raise
  // an owner approval for an edge that would then be rejected anyway.
  const handler = deps.bus.resolve(target);
  if (!handler) {
    logger.warn(
      { agentFolder: deps.folder, target: rawTarget },
      'Request target not found on bus',
    );
    rejectRequest('agent not found');
    return;
  }

  const upstreamSet = computeUpstreamSet(
    deps.agentDb,
    deps.agentId,
    ctx.channelName,
    participant,
  );
  if (upstreamSet.has(target)) {
    logger.info(
      {
        agentFolder: deps.folder,
        target: rawTarget,
        upstreamSet: [...upstreamSet],
      },
      'Outbound request blocked (cycle detected)',
    );
    rejectRequest('would create a cycle');
    return;
  }

  // The would-be request, built once: emitted now (granted) or held in the
  // owner-approval payload and re-emitted on grant (askable). `requestId` is
  // minted here so a hold reuses the same id on re-emit.
  const held: HeldOutboundRequest = {
    target, kind, text, requestId: generateId('req'), channel, qualifier,
    returnToChannel: ctx.channelName, returnToParticipant: participant,
    returnToQualifier: ctx.qualifier, upstreamSet: [...upstreamSet],
  };

  // Three-state containment gate under the q ⊇ r hierarchy:
  // `<cast:query>` needs `q`; `<cast:request>` needs `r` OR `q`. granted → emit;
  // askable (no grant, no tombstone) → hold + raise an owner-directed approval;
  // rejected (explicit tombstone, or no acl.json) → hard deny, as before.
  const requiredBit: 'q' | 'r' = kind === 'query' ? 'q' : 'r';
  const { bits } = checkAcl(deps.bus, deps.folder, target, channel);
  if (canEmit(bits, kind)) {
    emitOutboundRequest(deps, held);
    logger.info(
      { agentFolder: deps.folder, target, requestId: held.requestId, channel, kind },
      `Outbound ${kind} sent`,
    );
    return;
  }

  const approvals = deps.getApprovals?.();
  if (approvals && aclVerdict(deps.bus, deps.folder, target, channel, requiredBit) === 'askable') {
    raiseOutboundContainmentApproval(deps, approvals, conv, held, requiredBit, rawTarget);
    return;
  }

  // Rejected (or askable with no approval handler — console scope) — keep the
  // informative reach detail (the agent's own grants; no leak).
  logger.info(
    { agentFolder: deps.folder, target, channel, kind, requiredBit },
    `Outbound ${kind} blocked (ACL — rejected)`,
  );
  const peerChannels = getPeerChannels(deps.bus, deps.folder, target);
  const reachableChannels = peerChannels
    ?.filter((c) => canEmit(c.bits, kind))
    .map((c) => c.name) ?? [];
  const detail = peerChannels === undefined
    ? `${rawTarget} is not in your ACL`
    : reachableChannels.length === 0
      ? `no \`${requiredBit}\` bit for ${rawTarget} on any channel`
      : `no \`${requiredBit}\` bit on channel "${channel}" — you can ${kind} ${rawTarget} on: ${reachableChannels.join(', ')}`;
  rejectRequest(detail);
}

/**
 * Hold an askable outbound request and raise an owner-directed acl-edge approval
 * for the containment edge `this-agent → target` — the sender-side
 * mirror of the receiver's `raiseAclEdgeApproval`. Routes to THIS agent's owner
 * (`approver: 'owner'`); on grant `resolveAclEdge` re-emits the held request and
 * (on always) persists the `q`/`r` grant. Dedups per outbound edge so a
 * re-emitting agent doesn't stack approvals; notices land in the agent's own
 * conversation, since here the agent is its own originator.
 */
export function raiseOutboundContainmentApproval(
  deps: SpawnHookDeps,
  approvals: ApprovalHandler,
  conv: ConversationView<SpawnHookCtxFields>,
  held: HeldOutboundRequest,
  bit: 'q' | 'r',
  displayTarget: string,
): void {
  const pendingId = approvals.pendingAclEdge(held.target, held.channel, ['q', 'r']);
  if (pendingId) {
    // A decision for this edge is already in flight — one owner-grant covers the
    // edge, not each request. Inform the agent once, then go silent.
    if (recordBounce(`aclout:${pendingId}`) === 1) {
      deliverSystem(conv, systemUndelivered(ALREADY_PENDING_NOTICE, held.text, deps.getTimezone()));
    }
    return;
  }
  const ref = mintCorrelationCode();
  const verb = held.kind === 'query' ? 'query' : 'send a request to';
  approvals.createRequest({
    type: 'acl-edge',
    approver: 'owner',
    participant: held.target,
    channel: held.channel,
    summary: `This agent (ref ${ref}) wants to ${verb} ${displayTarget} on "${held.channel}".`,
    details: held.text,
    payload: JSON.stringify({ bit, ref, held }),
  });
  // Held-notice into the agent's own conversation so its turn completes (the real
  // outcome arrives later: a re-emitted request on grant, or a decline notice).
  deliverSystem(conv, systemUndelivered(pendingNotice(ref), held.text, deps.getTimezone()));
}

async function handleOutboundResponse(
  deps: SpawnHookDeps,
  requestId: string,
  text: string,
): Promise<void> {
  const req = deps.agentDb.getInboundRequest(requestId);
  if (!req || req.status !== 'open') {
    logger.warn(
      { agentFolder: deps.folder, requestId },
      'Response for unknown or closed request — dropped',
    );
    return;
  }

  deps.agentDb.updateRequestStatus('inbound', requestId, 'fulfilled');

  // Fire-and-forget: awaiting would deadlock the sender's outputChain.
  deps.bus
    .routeMessage(deps.agentId, req.return_to_agent, {
      type: 'response' as const,
      text,
      requestId,
      originChannel: req.return_to_channel,
      originParticipant: req.return_to_participant,
      originQualifier: req.return_to_qualifier ?? undefined,
      routing: {
        channel: req.return_to_channel,
        qualifier: req.return_to_qualifier ?? undefined,
        replyTo: req.return_to_participant,
      },
    })
    .catch((err) => {
      logger.error(
        { agentFolder: deps.folder, requestId, err },
        'Response routing failed',
      );
    });
  logger.info(
    { agentFolder: deps.folder, requestId, target: req.return_to_agent },
    'Response routed',
  );
}

/** Build the SpawnHooks for a single Conversation spawn cycle, reading
 *  per-conversation context directly from the typed `ConversationView`.
 *  J.6e — replaces the duck-typed `SpawnHookCtx` shim with a typed view
 *  parameter; hosts pass `conv` straight through from
 *  `BuildSpawnHooks<TCtx>`. The `TCtx extends SpawnHookCtxFields`
 *  constraint type-checks at the call site. */
export function buildSpawnHooks<TCtx extends SpawnHookCtxFields>(
  deps: SpawnHookDeps,
  conv: ConversationView<TCtx>,
): SpawnHooks {
  // Internally the helpers consume the structural-fields view; widen the
  // typed view once at the boundary.
  const fc = conv as unknown as ConversationView<SpawnHookCtxFields>;
  return {
    onSessionId: (id) => handleSessionId(deps, fc, id),
    onOutput: (pkt, ch, key) =>
      handleOutboundOutput(deps, fc, pkt, ch, key),
    onPreview: (pkt, ch, key) =>
      handleOutboundPreview(deps, fc, pkt, ch, key),
    onTyping: (evt) => deps.bus.routeEvent(evt),
    onLifecycle: (phase, active, extras) => {
      const ctx = fc.ctx;
      if (!ctx || !ctx.participant) return;
      deps.bus.routeEvent({
        from: deps.agentId,
        to: ctx.participant,
        type: 'lifecycle',
        data: buildLifecycleEvtData(phase, active, ctx.channelName, extras),
      });
    },
    onRequest: (kind, target, ch, text, qualifier) =>
      handleOutboundRequest(deps, fc, kind, target, ch, text, qualifier),
    onResponse: (id, text) => handleOutboundResponse(deps, id, text),
    logEvent: (level, component, eventName, message, opts) =>
      deps.agentDb.logEvent(level, component, eventName, message, opts),
  };
}
