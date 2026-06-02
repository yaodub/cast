/**
 * Console prompt assembly: shared overview + console manual + strategy header
 * + dynamic snapshot.
 *
 * Parallel to the 10-layer assembleSystemPrompt used by normal conversations,
 * but far simpler — most of the heavy framing lives in the on-disk manuals.
 * The per-console header comes from the strategy (no branches here).
 */
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import type { Host } from '../types.js';

import type { EventEntry } from '../agent/agent-db.js';
import { resolveManualsDir, type ConsoleName } from './index.js';
import { getConsoleStrategy } from './registry.js';
import { formatExtensionCatalog, getAggregatedExtensions } from './shared/extension-manuals.js';
import { formatTransportCatalog, getAggregatedTransports } from './shared/transport-manuals.js';
import type { AdminManual } from '@getcast/admin-schema/v1';

import { renderAdminManual } from './shared/page-manual.js';

/** Everything that varies session-to-session goes in the dynamic snapshot. */
export interface ConsoleContext {
  /** Manifest fields — name, description, status. */
  manifest: {
    name?: string;
    description?: string;
    template?: string;
    templateVersion?: string;
    status?: 'draft';
  };
  /** Non-secret config breadcrumbs — Claude can't see config/ so these are helpful. */
  model: string | undefined;
  /** Count of entries in `config/agent.json::modelOverrides` (0 when unset). */
  modelOverrideCount: number;
  owner: string;
  timezone: string | undefined;
  /** Current channel names (excludes console channels). */
  channels: string[];
  /** Service lifecycle status. */
  serviceStatus: 'idle' | 'starting' | 'running' | 'restarting' | 'stopped' | 'failed' | 'not-configured';
  /** Active conversation count at session start (soft signal). */
  activeConversations: number;
  /** Admin-UI route → purpose/sections map. Snapshotted at session open —
   *  edits to `pageManual` during a live session don't reach the bot until
   *  the next session. */
  adminManual?: AdminManual;
  /** Recent error/warn/info events for this agent. Populated only for
   *  agent-scope consoles (`design`, `configure`); server-scope consoles
   *  span multiple agents at tool-call time, so a snapshot for one specific
   *  agent isn't meaningful and is left undefined. */
  recentEvents?: EventEntry[];
  /** Required resource slots declared in capabilities.json with no host path
   *  bound in provisions.json. Surfaced in the snapshot so Configure leads
   *  every session with the gap until it's resolved. The runtime warn-and-skips
   *  a missing mount; this is not a crash, but the agent ships degraded. */
  missingRequiredResources?: string[];
}

function readManual(manualsDir: string, rel: string): string | null {
  const p = path.join(manualsDir, rel);
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

function formatManifest(m: ConsoleContext['manifest']): string {
  const lines = [
    `- **Name:** ${m.name ?? '(unset)'}`,
    `- **Description:** ${m.description ?? '(unset)'}`,
  ];
  if (m.template) {
    lines.push(`- **Template:** ${m.template}${m.templateVersion ? ` @ ${m.templateVersion}` : ''}`);
  }
  if (m.status) lines.push(`- **Lifecycle:** ${m.status}`);
  else lines.push(`- **Lifecycle:** ready`);
  return lines.join('\n');
}

function formatList(items: string[], empty: string): string {
  if (items.length === 0) return empty;
  return items.map((i) => `- ${i}`).join('\n');
}

function formatDynamicSnapshot(ctx: ConsoleContext): string {
  const activityNote = ctx.activeConversations > 0
    ? `\n  _Live traffic — config changes won't block, but expect some sessions to keep seeing old behavior until they refresh._`
    : '';
  const sections = [
    '# Dynamic snapshot',
    '',
    '## Agent',
    formatManifest(ctx.manifest),
    '',
    '## Runtime config (non-secret)',
    `- **Model:** ${ctx.model ?? '(server default)'}${ctx.modelOverrideCount > 0 ? ` (+${ctx.modelOverrideCount} override${ctx.modelOverrideCount > 1 ? 's' : ''})` : ''}`,
    `- **Owner:** ${ctx.owner}`,
    `- **Timezone:** ${ctx.timezone ?? '(server default)'}`,
    '',
    '## Channels',
    formatList(ctx.channels, '_No user-defined channels. The default channel always exists._'),
    '',
    '## Service',
    `- **Status:** ${ctx.serviceStatus}`,
    '',
    '## Activity',
    `- **Active conversations:** ${ctx.activeConversations}${activityNote}`,
  ];
  if (ctx.adminManual && Object.keys(ctx.adminManual).length > 0) {
    sections.push(
      '',
      '## Admin UI pages',
      '_Pass one of these as `target` (and optionally `within: <anchor>`) to `admin__navigate` to send the operator there. The UI maps the key to a route, drawer tab, or modal — you don\'t pick._',
      '',
      renderAdminManual(ctx.adminManual),
    );
  }
  const extensionCatalog = formatExtensionCatalog(getAggregatedExtensions());
  if (extensionCatalog) {
    sections.push(
      '',
      '## Extensions registered on this server',
      "_The name shown below is the literal key for `blueprint/props/capabilities.json → extensions[X]`. Copy it verbatim — don't convert to snake_case or abbreviate._",
      '',
      extensionCatalog,
    );
  }
  const transportCatalog = formatTransportCatalog(getAggregatedTransports());
  if (transportCatalog) {
    sections.push(
      '',
      '## Transports registered on this server',
      transportCatalog,
    );
  }
  if (ctx.missingRequiredResources && ctx.missingRequiredResources.length > 0) {
    const names = ctx.missingRequiredResources.map((n) => `\`${n}\``).join(', ');
    const count = ctx.missingRequiredResources.length;
    sections.push(
      '',
      '## Unprovisioned resource slots',
      `_${count} required resource slot${count === 1 ? '' : 's'} declared in \`blueprint/props/capabilities.json\` ` +
        `with no host path bound in \`config/provisions.json\`: ${names}. The agent spawns either way — ` +
        `the runtime warn-and-skips a missing mount — but \`/resources/<name>\` won't exist inside the container ` +
        `and reads will ENOENT. Lead with this on session open until the operator binds a host path under the ` +
        `agent's Settings → Provisions section in the admin UI._`,
    );
  }
  return sections.join('\n');
}

function formatRecentEvents(events: EventEntry[]): string {
  // Sort: errors first, then warns, then info; within each group newest-first.
  const order: Record<EventEntry['level'], number> = { error: 0, warn: 1, info: 2 };
  const sorted = [...events].sort((a, b) => order[a.level] - order[b.level] || b.ts.localeCompare(a.ts));
  return sorted.map((e) => {
    const conv = e.conversation_key ? ` (conv:${e.conversation_key.slice(0, 24)})` : '';
    return `- **${e.ts}** [${e.level}] [${e.component}] ${e.event_name} — ${e.message}${conv}`;
  }).join('\n');
}

export function assembleConsolePrompt(consoleName: ConsoleName, agent: Host, ctx: ConsoleContext): string {
  const strategy = getConsoleStrategy(consoleName);
  const manualsDir = resolveManualsDir();

  const overview = manualsDir ? readManual(manualsDir, 'console/overview.md') : null;
  const consoleManual = manualsDir ? readManual(manualsDir, `console/${consoleName}.md`) : null;

  if (!overview || !consoleManual) {
    logger.warn(
      { console: consoleName, manualsDir, agentFolder: agent.folder },
      'Console manual(s) missing — falling back to minimal prompt',
    );
  }

  const dynamic = formatDynamicSnapshot(ctx);

  return [
    overview ?? '_Console overview manual is missing on disk._',
    consoleManual ?? `_Console manual for "${consoleName}" is missing on disk._`,
    strategy.promptHeader,
    dynamic,
  ].join('\n\n---\n\n');
}
