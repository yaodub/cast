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

import type { ToolResult } from '@getcast/extension-schema';

import { agentPath } from '../config.js';
import type { Bus } from '../gateway/bus.js';
import { approvalAckPkt, approvalRequestPkt } from '../gateway/packets.js';
import type { AgentExtensions } from '../extensions/registry.js';
import { escapeXml, formatMessages } from '../lib/format.js';
import { conversationKeyToPath } from '../lib/utils.js';
import { logger } from '../logger.js';
import { DEFAULT_APPROVAL_EXPIRY } from '../types.js';

import type { AgentDb, ApprovalRow } from './agent-db.js';
import type { AgentService } from './agent-service.js';

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
}

export class ApprovalHandler {
  constructor(private deps: ApprovalDeps) {}

  /**
   * Generate an approval ID, persist the pending row, and route the request
   * packet to the participant. Shared between the MCP tool path and the
   * service-IPC path so they can't drift.
   */
  createRequest(data: {
    tool: string;
    args: Record<string, unknown>;
    summary: string;
    details?: string;
    participant: string;
    channel?: string;
    conversationKey?: string;
    expiresIn?: number;
  }): string {
    const approvalId = randomBytes(4).toString('hex');
    const expiresIn = data.expiresIn ?? DEFAULT_APPROVAL_EXPIRY;
    const pkt = approvalRequestPkt(
      this.deps.agentId, data.participant, data.summary,
      approvalId, data.details, expiresIn,
    );
    this.deps.agentDb.insertApproval({
      id: approvalId,
      tool: data.tool,
      args: data.args,
      summary: data.summary,
      details: data.details,
      participant: data.participant,
      channel: data.channel,
      conversationKey: data.conversationKey,
      expiresAt: pkt.expiresAt,
    });
    this.deps.bus.routeMessage(this.deps.agentId, data.participant, { pkt });
    return approvalId;
  }

  async handleResponse(
    from: string,
    response: { id: string; decision: 'approved' | 'rejected'; reason?: string },
  ): Promise<void> {
    const row = this.deps.agentDb.getApproval(response.id);
    if (!row) {
      logger.warn({ approvalId: response.id, from }, 'Approval response for unknown ID');
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
      this.deps.agentDb.updateApprovalStatus(row.id, 'expired');
      const ack = approvalAckPkt(this.deps.agentId, from, row.id, 'expired', row.summary);
      this.deps.bus.routeMessage(this.deps.agentId, from, { pkt: ack });
      this.notifyOutcome(row, `Approval for "${row.summary}" has expired.`);
      logger.info({ approvalId: row.id }, 'Approval expired on user action');
      return;
    }

    if (response.decision === 'approved') {
      this.deps.agentDb.updateApprovalStatus(row.id, 'approved', response.reason);
      const ack = approvalAckPkt(this.deps.agentId, from, row.id, 'approved', row.summary);
      this.deps.bus.routeMessage(this.deps.agentId, from, { pkt: ack });

      try {
        const result = await this.executeApprovedTool(row.tool, JSON.parse(row.args), row);
        const resultText = result.content.map((c) => c.text).join('\n');
        this.notifyOutcome(row, `Approval granted for "${row.summary}". Result:\n${resultText}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.error({ approvalId: row.id, tool: row.tool, err }, 'Approved tool re-invocation failed');
        this.notifyOutcome(row, `Approval granted for "${row.summary}", but execution failed: ${errMsg}`);
      }
      logger.info({ approvalId: row.id, tool: row.tool }, 'Approval granted');
    } else {
      this.deps.agentDb.updateApprovalStatus(row.id, 'rejected', response.reason);
      const ack = approvalAckPkt(this.deps.agentId, from, row.id, 'rejected', row.summary, response.reason);
      this.deps.bus.routeMessage(this.deps.agentId, from, { pkt: ack });
      this.notifyOutcome(row, `Approval rejected for "${row.summary}"${response.reason ? ': ' + response.reason : ''}`);
      logger.info({ approvalId: row.id, tool: row.tool }, 'Approval rejected');
    }
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
