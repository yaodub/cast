/**
 * ApprovalHandler — manages the approve/reject lifecycle for agent tool calls
 * that require operator confirmation.
 *
 * Holds: nothing per-handler (DB row is the source of truth). Keeps approvals
 * out of agent-manager.ts so the request → record → response → execute flow
 * has its own home.
 */
import path from 'path';
import { randomBytes } from 'crypto';

import { z } from 'zod';

import type { ToolResult } from '@getcast/extension-schema';

import { agentPath } from '../config.js';
import { extractIdentity, isExtAddress, isOperatorTier } from '../auth/address.js';
import { getOwner, getOwnerConversation, grantAclEdge, tombstoneAclEdge } from '../auth/acl.js';
import { grantUserPush, tombstoneUserPush } from '../auth/user-push-store.js';
import type { IdentityProvider } from '../auth/identity.js';
import type { LogHostEventFn } from '../server/host-activity-log.js';
import type { Bus } from '../gateway/bus.js';
import { approvalAckPkt, approvalRequestPkt } from '../gateway/packets.js';
import type { AgentExtensions } from '../extensions/registry.js';
import { appendChangelog } from '../lib/audit-log.js';
import { escapeXml, formatMessages } from '../lib/format.js';
import { conversationKeyToPath, parseJsonSafe } from '../lib/utils.js';
import { logger } from '../logger.js';
import { DEFAULT_APPROVAL_EXPIRY } from '../types.js';

import type { AgentDb, ApprovalRow } from './agent-db.js';
import type { AgentService } from './agent-service.js';

/** Carry for an `acl-edge` approval (2B): which edge is being decided and the
 *  held inbound request to resume on grant. `held` is opaque here (the bus-handler
 *  owns its shape and re-validates it on resume); this layer only forwards it. */
const AclEdgePayloadSchema = z.object({
  bit: z.string().optional(),
  /** The short correlation code surfaced to the owner + requester.
   *  Carried for audit; the resolution itself doesn't consume it. */
  ref: z.string().optional(),
  held: z.unknown().optional(),
});

/** Payload carry for a `user-push` approval: the `(channel, pusher,
 *  pushee)` edge the PUSHEE is deciding plus the held push to replay on grant.
 *  `held` is opaque here (agent-manager re-validates it as a `HeldLocalPush`). */
const UserPushPayloadSchema = z.object({
  channel: z.string(),
  pusher: z.string(),
  pushee: z.string(),
  held: z.unknown().optional(),
});

export interface ApprovalDeps {
  agentId: string;
  folder: string;
  bus: Bus;
  agentDb: AgentDb;
  service: AgentService;
  extensions: AgentExtensions;
  /** Returns the timezone effective at outcome-emission time (mutable on AgentManager). */
  getTimezone: () => string;
  /**
   * Re-injects an approval outcome (system message) back into the agent's
   * normal routing flow so the conversation that triggered the approval sees
   * the result.
   */
  routeOutcome: (row: { participant: string; channel: string | null }, formatted: string) => void;
  /**
   * Resume an owner-granted acl-edge: deliver the held inbound request into the
   * receiver's conversation (2B). `held` is the opaque payload carry — the
   * bus-handler re-validates it. Absent only in degenerate/test configs.
   */
  deliverHeldRequest?: (held: unknown) => void;
  /** Route a rejection back to the sender of a held inbound request the owner declined (2B). */
  rejectHeldRequest?: (held: unknown, reason: string) => void;
  /**
   * Resume an owner-granted OUTBOUND containment edge: re-emit the
   * held outbound request now that the agent holds `q`/`r` toward the target.
   * The outbound mirror of `deliverHeldRequest`; `resolveAclEdge` routes here
   * instead when the edge bit is `q`/`r`. Absent only in degenerate/test configs.
   */
  reEmitHeldRequest?: (held: unknown) => void;
  /**
   * The agent's own outbound reach was declined by its owner — deliver a system
   * notice back into the agent's own conversation (not a rejection to a remote
   * sender, since the agent is its own originator). The outbound counterpart of
   * `rejectHeldRequest`.
   */
  declineHeldRequest?: (held: unknown, reason: string) => void;
  /**
   * Resume an owner-granted PUSH containment edge: re-emit the held
   * cross-agent push now that the agent holds `p` toward the target. The push
   * analogue of `reEmitHeldRequest`; `resolveAclEdge` routes here when the edge
   * bit is `p`. Absent only in degenerate/test configs.
   */
  reEmitHeldPush?: (held: unknown) => void;
  /**
   * The agent's own push route was declined by its owner — deliver a system notice
   * back into the sender's own cell. The push counterpart of `declineHeldRequest`.
   */
  declineHeldPush?: (held: unknown, reason: string) => void;
  /**
   * A pushee approved a user↔user push: replay the held local push into
   * the pushee's conversation. `held` is re-validated as a `HeldLocalPush`.
   */
  deliverHeldUserPush?: (held: unknown) => void;
  /**
   * A pushee declined (or let lapse) a user↔user push — echo a rejection back into
   * the pusher's own cell so its "held" turn resolves.
   */
  declineHeldUserPush?: (held: unknown, reason: string) => void;
  /**
   * Resolves an answerer's transport handle to its identity for the
   * approval-answerer auth check. Optional: absent only in
   * degenerate/test configs, where the check fails open with a warning.
   */
  idp?: IdentityProvider;
  /** Surfaces a dropped (forged/misrouted) approval response to the operator's host-events view. */
  logHostEvent?: LogHostEventFn;
}

export class ApprovalHandler {
  constructor(private deps: ApprovalDeps) {}

  /**
   * Generate an approval ID, persist the pending row, and route the request
   * packet to the participant. Shared between the MCP tool path and the
   * service-IPC path so they can't drift.
   */
  createRequest(data: {
    /** Present for `tool-call` approvals; omitted for `acl-edge` (no tool). */
    tool?: string;
    args?: Record<string, unknown>;
    summary: string;
    details?: string;
    participant: string;
    /** Approval shape — 'tool-call' (default), 'acl-edge' (reactive ACL grant, 2B),
     *  or 'user-push' (pushee-decided user↔user push consent, 2B.3). */
    type?: 'tool-call' | 'acl-edge' | 'user-push';
    /** Type-specific carry, serialized. For `acl-edge`: the held inbound-request
     *  reference + the edge being decided, so the resolution can resume + persist. */
    payload?: string;
    /** Who decides this approval: 'participant' (default) or 'owner' (owner-approves
     *  — routes to the agent's owner + the tiered four-option path). */
    approver?: 'participant' | 'owner';
    /** Explicit controller override (the answerer-auth key). Normally derived from
     *  `approver`; defaults to the conversing participant. */
    controller?: string;
    channel?: string;
    conversationKey?: string;
    expiresIn?: number;
  }): string {
    const approvalId = randomBytes(4).toString('hex');
    const expiresIn = data.expiresIn ?? DEFAULT_APPROVAL_EXPIRY;
    // Owner-approves routes the decision to the agent's owner; otherwise the
    // conversing participant decides (today's default). The controller is both
    // the answerer-auth key and the routing target for the request packet. Only
    // resolve the owner when the caller didn't already supply a controller —
    // resolution reads acl.json via the watcher, so skip it when not needed.
    const ownerLookup = data.approver === 'owner' && data.controller === undefined;
    const owner = ownerLookup ? getOwner(this.deps.bus, this.deps.folder) : null;
    const controller = data.controller ?? owner ?? data.participant;
    // Owner-directed approvals land in the owner's pinned conversation when an
    // `approval_channel` is set (2A.6); otherwise route as before (no channel →
    // a default-resolved conversation, 2A.4 behavior). Additive.
    const approvalChannel = ownerLookup
      ? getOwnerConversation(this.deps.bus, this.deps.folder)?.channel
      : undefined;
    // Owner-directed approvals carry the tiered four-option (once/always) path;
    // participant tool-call approvals stay two-option. A `user-push` approval is
    // participant-decided (the pushee) but tiered too — the pushee chooses allow-
    // once (this push only) vs allow-always (a standing per-edge grant).
    const tiered = data.approver === 'owner' || data.type === 'user-push';
    const pkt = approvalRequestPkt(
      this.deps.agentId, controller, data.summary,
      approvalId, data.details, expiresIn, tiered,
    );
    this.deps.agentDb.approvals.insertApproval({
      id: approvalId,
      tool: data.tool,
      args: data.args,
      summary: data.summary,
      details: data.details,
      participant: data.participant,
      type: data.type,
      controller,
      channel: data.channel,
      conversationKey: data.conversationKey,
      expiresAt: pkt.expiresAt,
      payload: data.payload,
    });
    // Route the request to the controller. The 'operator' sentinel has no
    // conversation to land in (its approvals surface via the deferred admin
    // view), so skip its route; real owners + participants route normally.
    if (controller !== 'operator') {
      this.deps.bus.routeMessage(
        this.deps.agentId, controller,
        approvalChannel ? { pkt, channel: approvalChannel } : { pkt },
      );
    }
    return approvalId;
  }

  /**
   * The pending `acl-edge` approval id already deciding edge `(participant,
   * channel)`, or null — the reactive gate's dedup key (2B). Delegates to the
   * store; lives here because the gate reaches approvals only through this
   * handler (`getApprovals()`).
   */
  pendingAclEdge(participant: string, channel: string, bits?: string[]): string | null {
    return this.deps.agentDb.approvals.pendingAclEdge(participant, channel, bits);
  }

  /** The pending `user-push` approval id already deciding `(channel, pusher →
   *  pushee)`, or null — the 2B.3 reactive gate's dedup key. Delegates to the store. */
  pendingUserPush(channel: string, pusher: string, pushee: string): string | null {
    return this.deps.agentDb.approvals.pendingUserPush(channel, pusher, pushee);
  }

  async handleResponse(
    from: string,
    response: { id: string; decision: 'approved' | 'rejected'; reason?: string; tier?: 'once' | 'always' },
  ): Promise<void> {
    const row = this.deps.agentDb.approvals.getApproval(response.id);
    if (!row) {
      logger.warn({ approvalId: response.id, from }, 'Approval response for unknown ID');
      return;
    }
    // Answerer authentication. Only the approval's controller — or the
    // operator (god-mode backstop) — may decide it. The controller is the dedicated
    // `controller` column, set at createRequest: it defaults to the conversing
    // participant for today's inline tool-call approvals, and the owner-approves
    // model (2A.4) sets it to the agent's owner. An unauthorized answerer is dropped
    // silently (no ack, no stale event: leak nothing to a forger) and surfaced to the
    // operator. (`?? row.participant` covers in-flight rows created before the
    // controller column was populated.)
    const controller = row.controller ?? row.participant;
    // Tiers (once/always) are honored only for owner-directed approvals — where the
    // controller (the owner) differs from the conversing participant. A participant
    // answering their own approval can't set a standing grant (self-exemption).
    const tier = controller !== row.participant ? response.tier : undefined;
    if (!this.isAuthorizedAnswerer(from, controller, row.type)) {
      logger.warn(
        { approvalId: row.id, from, routedTo: controller },
        'Approval response from unauthorized answerer — dropped',
      );
      this.deps.logHostEvent?.(
        'warn', 'approval', 'approval_answerer_mismatch',
        `Dropped approval response for "${row.summary}" from unauthorized sender`,
        { fromAddr: from, toAddr: controller, context: { approvalId: row.id } },
      );
      return;
    }
    if (row.status !== 'pending') {
      logger.info({ approvalId: response.id, status: row.status }, 'Approval already resolved');
      this.deps.bus.routeEvent({
        from: this.deps.agentId, to: from, type: 'approval_stale',
        data: { approvalId: row.id, status: row.status, summary: row.summary },
      });
      return;
    }

    // Soft expiry check
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      this.deps.agentDb.approvals.updateApprovalStatus(row.id, 'expired');
      const ack = approvalAckPkt(this.deps.agentId, from, row.id, 'expired', row.summary);
      this.deps.bus.routeMessage(this.deps.agentId, from, { pkt: ack });
      this.notifyOutcome(row, `Approval for "${row.summary}" has expired.`);
      logger.info({ approvalId: row.id }, 'Approval expired on user action');
      return;
    }

    const decision = response.decision;
    this.deps.agentDb.approvals.updateApprovalStatus(row.id, decision, response.reason, tier);
    const ack = approvalAckPkt(this.deps.agentId, from, row.id, decision, row.summary, response.reason, tier);
    this.deps.bus.routeMessage(this.deps.agentId, from, { pkt: ack });

    // Dispatch the outcome by approval type. `acl-edge` (reactive ACL grant, 2B)
    // persists/withdraws the edge; `tool-call` re-invokes the held tool.
    if (row.type === 'acl-edge') {
      this.resolveAclEdge(row, decision, tier, response.reason, from);
      logger.info({ approvalId: row.id, type: row.type, decision, tier }, 'Resolved acl-edge approval');
      return;
    }

    if (row.type === 'user-push') {
      this.resolveUserPush(row, decision, tier, response.reason);
      logger.info({ approvalId: row.id, type: row.type, decision, tier }, 'Resolved user-push approval');
      return;
    }

    if (decision === 'rejected') {
      this.notifyOutcome(row, `Approval rejected for "${row.summary}"${response.reason ? ': ' + response.reason : ''}`);
      logger.info({ approvalId: row.id, tool: row.tool }, 'Approval rejected');
      return;
    }

    if (row.tool === null || row.args === null) {
      logger.error({ approvalId: row.id }, 'Approved tool-call approval missing tool/args');
      this.notifyOutcome(row, `Approval granted for "${row.summary}", but the request was malformed (no tool to run).`);
      return;
    }
    const reasonNote = response.reason ? ` (${response.reason})` : '';
    try {
      const result = await this.executeApprovedTool(row.tool, JSON.parse(row.args), row);
      const resultText = result.content.map((c) => c.text).join('\n');
      this.notifyOutcome(row, `Approval granted for "${row.summary}"${reasonNote}. Result:\n${resultText}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ approvalId: row.id, tool: row.tool, err }, 'Approved tool re-invocation failed');
      this.notifyOutcome(row, `Approval granted for "${row.summary}"${reasonNote}, but execution failed: ${errMsg}`);
    }
    logger.info({ approvalId: row.id, tool: row.tool }, 'Approval granted');
  }

  /**
   * Resolve an `acl-edge` approval (single-store reactive ACL, 2B). On allow-always
   * the granted edge persists straight into acl.json (`allowed`); on reject-always a
   * tombstone persists into acl.json (`rejected`) so the edge stops being re-asked.
   * One store — there is no separate reactive file. The once tiers and the held-
   * request resume/reject are wired in the gate step (2B step 5).
   */
  private resolveAclEdge(row: ApprovalRow, decision: 'approved' | 'rejected', tier?: string, reason?: string, answerer?: string): void {
    const edge = parseJsonSafe(row.payload ?? '', AclEdgePayloadSchema);
    const peer = extractIdentity(row.participant);
    const channel = row.channel ?? 'default';
    const bit = edge?.bit ?? 'a';
    // Outbound containment edges (`q`/`r`, 2B.5) resume by RE-EMITTING the held
    // request now that the agent holds reach; inbound access edges (`a`/`io`, 2B)
    // resume by DELIVERING the held request into this agent's conversation. The
    // edge bit discriminates the two held-carry shapes + their resume paths.
    const isOutbound = bit === 'q' || bit === 'r';
    // A `p` (push containment) edge is outbound too, but its held carry is
    // a push (re-emitted via `emitPush`), not a request — discriminate separately.
    const isPush = bit === 'p';
    // An `io` edge (first-contact conversation message) has no return rail: the
    // agent's reply is free prose gated on standing `o` (agent-spawn-hooks.ts).
    // Approving `once` would resume the held message but write no grant, so the
    // reply bounces on outbound — the broken state the `io` approval card drops.
    // Enforce the invariant server-side: an approved `io` edge ALWAYS writes the
    // standing grant (coerce a stray `once` from a forged/stale client). `a`/`q`/`r`/`p`
    // keep `once` — q/r answers ride the request return rail (exempt from `o`); a `p`
    // push is a one-way delivery with no reply from the sender that needs standing.
    const effectiveTier = decision === 'approved' && bit === 'io' ? 'always' : tier;
    if (decision === 'approved') {
      // allow-always persists a standing grant; once lets only this request through.
      if (effectiveTier === 'always') {
        grantAclEdge(this.deps.folder, peer, channel, bit);
        appendChangelog(this.deps.folder, {
          actor: answerer ?? 'owner', action: 'access_granted', peer, channel, bit, via: 'approval',
        });
      }
      if (edge?.held !== undefined) {
        if (isPush) this.deps.reEmitHeldPush?.(edge.held);
        else if (isOutbound) this.deps.reEmitHeldRequest?.(edge.held);
        else this.deps.deliverHeldRequest?.(edge.held);
      }
    } else {
      // reject-always tombstones the edge (stop re-asking); once declines this one.
      if (effectiveTier === 'always') {
        tombstoneAclEdge(this.deps.folder, peer, channel, bit);
        appendChangelog(this.deps.folder, {
          actor: answerer ?? 'owner', action: 'access_blocked', peer, channel, bit, via: 'approval',
        });
      }
      if (edge?.held !== undefined) {
        if (isPush) this.deps.declineHeldPush?.(edge.held, reason ?? 'Push declined.');
        else if (isOutbound) this.deps.declineHeldRequest?.(edge.held, reason ?? 'Outreach declined.');
        else this.deps.rejectHeldRequest?.(edge.held, reason ?? 'Request declined.');
      }
    }
  }

  /**
   * Resolve a `user-push` approval — the pushee's in-band consent for a
   * user↔user push. Unlike `acl-edge`, the grant persists to the per-agent user-push
   * store (not acl.json). No io-invariant: a push is a one-way delivery, so `once`
   * legitimately delivers the single turn and persists nothing; `always` persists
   * the standing `(channel, pusher → pushee)` grant. On reject-always the edge is
   * tombstoned so the pusher is never re-asked; on either reject the pusher's held
   * turn is declined back into its own cell.
   */
  private resolveUserPush(row: ApprovalRow, decision: 'approved' | 'rejected', tier?: string, reason?: string): void {
    const edge = parseJsonSafe(row.payload ?? '', UserPushPayloadSchema);
    if (!edge) {
      logger.error({ approvalId: row.id }, 'user-push: malformed payload, cannot resolve');
      return;
    }
    if (decision === 'approved') {
      if (tier === 'always') grantUserPush(this.deps.folder, edge.channel, edge.pusher, edge.pushee);
      if (edge.held !== undefined) this.deps.deliverHeldUserPush?.(edge.held);
    } else {
      if (tier === 'always') tombstoneUserPush(this.deps.folder, edge.channel, edge.pusher, edge.pushee);
      if (edge.held !== undefined) this.deps.declineHeldUserPush?.(edge.held, reason ?? 'Push declined by the recipient.');
    }
  }

  /**
   * Answerer authentication for handleResponse.
   *
   * The approval was routed to `routedTo` — its controller (the conversing
   * participant for inline tool-call approvals; the agent's owner under the
   * owner-approves model). Only that identity, or the operator (god-mode
   * backstop), may decide it. `from` arrives unresolved on the thin approval
   * path — a raw transport handle (`tg:`/`slack:`), a bare identity (email/web),
   * or an operator handle (`cli:`/`admin:`) — so resolve it to an identity and
   * compare bare-to-bare.
   */
  private isAuthorizedAnswerer(from: string, routedTo: string, type?: string): boolean {
    // G4: an `ext:*` principal is a fire-and-forget injection origin,
    // not a responding entity — it can never authorize an approval. Hard-deny
    // before the identity compare so a synthesized ext `from` (or an approval
    // mis-routed to an ext participant) cannot self-authorize. An ext-origin
    // turn's approvals route to the operator instead (3b).
    if (isExtAddress(from) || isExtAddress(routedTo)) return false;
    // 2B.3: a `user-push` approval is the PUSHEE's own in-band call — there is no
    // operator backstop (decision 4: "your conversation is yours"). Skip the
    // operator god-mode shortcut so only the routed controller (the pushee) can
    // answer it; every other approval type keeps operator override.
    if (type !== 'user-push' && isOperatorTier(from)) return true;
    if (!this.deps.idp) {
      logger.warn({ from }, 'Approval answerer unvalidated: no identity provider (failing open)');
      return true;
    }
    const answerer = this.deps.idp.resolve(from)?.id ?? from;
    return extractIdentity(answerer) === extractIdentity(routedTo);
  }

  /**
   * Format an approval-outcome system message and route it through deps.routeOutcome
   * so the originating conversation sees the result.
   */
  notifyOutcome(row: { participant: string; channel: string | null }, text: string): void {
    const formatted = formatMessages([{
      id: '',
      address: this.deps.agentId,
      sender: 'system',
      sender_name: 'system',
      content: `<system>${escapeXml(text)}</system>`,
      timestamp: new Date().toISOString(),
    }], this.deps.getTimezone());
    this.deps.routeOutcome(row, formatted);
  }

  private async executeApprovedTool(
    toolName: string,
    args: Record<string, unknown>,
    row: ApprovalRow,
  ): Promise<ToolResult> {
    // Try host-side extensions first
    for (const ext of this.deps.extensions.instances) {
      const tool = ext.tools.find((t) => t.name === toolName);
      if (tool) {
        const convKey = row.conversation_key;
        let base: string;
        if (convKey) {
          base = path.join(agentPath(this.deps.folder, 'staging'), conversationKeyToPath(convKey));
        } else {
          base = path.join(agentPath(this.deps.folder, 'staging'), '_agent');
        }
        const callCtx = {
          stagingDir: path.join(base, 'in'),
          stagingOutDir: path.join(base, 'out'),
          participant: row.participant,
        };
        return ext.handle(toolName, args, callCtx);
      }
    }

    // Try service process (IPC re-invocation)
    if (this.deps.service.executeApprovedTool(row.id, toolName, args)) {
      // Result arrives asynchronously via onApprovalToolResult callback
      return { content: [{ type: 'text', text: 'Tool re-invocation dispatched to service process.' }] };
    }

    throw new Error(`Tool "${toolName}" not found in any active extension or service`);
  }
}
