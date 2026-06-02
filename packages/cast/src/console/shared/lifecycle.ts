/**
 * Shared lifecycle writer — the single path that mutates `manifest.status`.
 *
 * Three callers converge here:
 *   - `agent.setLifecycle` tRPC (mechanical override, both directions)
 *   - `security__finalize_agent` SM tool (review path, draft→ready only)
 *   - `design__revert_to_draft` MCP tool (one-way ready→draft)
 *
 * Audit metadata distinguishes them via the `via` field.
 *
 * Conversational entry points (`agent.requestReview`, `design__request_review`)
 * do not call this helper — they push a primed message to SM via
 * `gateway.ingestInbound`. SM is the only caller for the review-driven flip.
 */
import fs from 'fs';

import { AgentManifestSchema, type AgentManifest } from '@getcast/agent-schema/v1';

import { agentPath } from '../../config.js';
import { writeAtomic } from '../../lib/utils.js';

import { appendChangelog } from './audit-log.js';

export type LifecycleStatus = 'draft' | 'ready';

export type LifecycleVia = 'sm_review' | 'manual_override' | 'design_revert';

export interface SetLifecycleOptions {
  /** Audit-log actor. `'local'` for admin-UI mutations; SM/Design participant id otherwise. */
  actor: string;
  /** Path classification — distinguishes reviewed flip vs. override vs. revert. */
  via: LifecycleVia;
  /** Operator identity when the flip originated from a review request. */
  requested_by?: string;
  /** Free-form reason — populated by Design revert and the SM tool's posture summary. */
  reason?: string;
  /** SM's posture summary when `via === 'sm_review'`. */
  posture_summary?: string;
}

export interface SetLifecycleResult {
  from: LifecycleStatus;
  to: LifecycleStatus;
  noop: boolean;
}

export function readManifestRaw(
  agentFolder: string,
): { raw: Record<string, unknown>; manifest: AgentManifest } | { error: string } {
  const p = agentPath(agentFolder, 'manifest.json');
  if (!fs.existsSync(p)) return { error: 'manifest.json not found' };
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf-8'));
    const manifest = AgentManifestSchema.parse(raw);
    return { raw, manifest };
  } catch (err) {
    return { error: `invalid manifest.json: ${String(err)}` };
  }
}

export function writeManifestRaw(agentFolder: string, raw: Record<string, unknown>): void {
  const p = agentPath(agentFolder, 'manifest.json');
  // Atomic write: rename-into-place produces a clean mtime event the
  // FileWatcher picks up so the admin UI's draft pill refreshes promptly.
  writeAtomic(p, JSON.stringify(raw, null, 2) + '\n');
}

/**
 * Transition manifest.status. Idempotent — calling with the current state
 * returns `noop: true` without writing the file or appending changelog.
 */
export function setLifecycle(
  agentFolder: string,
  target: LifecycleStatus,
  opts: SetLifecycleOptions,
): SetLifecycleResult | { error: string } {
  const result = readManifestRaw(agentFolder);
  if ('error' in result) return result;

  const current: LifecycleStatus = result.manifest.status === 'draft' ? 'draft' : 'ready';
  if (current === target) {
    return { from: current, to: target, noop: true };
  }

  if (target === 'ready') {
    const { status: _drop, ...rest } = result.raw;
    writeManifestRaw(agentFolder, rest);
  } else {
    writeManifestRaw(agentFolder, { ...result.raw, status: 'draft' });
  }

  appendChangelog(agentFolder, {
    actor: opts.actor,
    action: 'set_lifecycle',
    from: current,
    to: target,
    via: opts.via,
    ...(opts.requested_by ? { requested_by: opts.requested_by } : {}),
    ...(opts.reason ? { reason: opts.reason } : {}),
    ...(opts.posture_summary ? { posture_summary: opts.posture_summary } : {}),
  });

  return { from: current, to: target, noop: false };
}

/**
 * Trigger marker the server synthesizes when the operator clicks "Request
 * review" (or Design's LLM calls `design__request_review`). The body is just
 * the recognizer header — SM's system prompt and practitioner manual carry
 * the workflow, so the prime does not repeat it. Both ingestion paths (admin
 * tRPC `agent.requestReview` and `design__request_review` MCP) consume this
 * same string.
 *
 * SM is the gate — it must call `security__finalize_agent` to actually flip
 * the agent live; without that call, status stays `draft`.
 */
export function buildReviewRequestMessage(folder: string, changeId: string): string {
  return `[Review request — agent: ${folder}, change_id: ${changeId}]`;
}
