/**
 * System Prompt Assembly — builds the complete system prompt for an agent conversation.
 *
 * Pure function module. Reads files from the agent's directory tree and returns
 * a fully assembled prompt string. No side effects, no state.
 *
 * Prompt layers (in order):
 *   [1] Cast protocol           — server-generated infrastructure contract
 *   [2] Profile prompt          — filesystem conventions from profile
 *   [3] Profile skills          — behavioral guidance from profile (e.g. standard)
 *   [4] prompt.md               — core persona and behavior (blueprint/identity/)
 *   [5] whoami.md               — structured identity facts (blueprint/identity/)
 *   [6] peers.md                — peer relationships (blueprint/identity/)
 *   [7] skills.md               — behavioral guidance (blueprint/identity/)
 *   [7.5] channel-contract     — ACL-derived wire contract for this addressee,
 *                                 emitted only when non-default (no `o` bit, or
 *                                 structured envelopes available alongside `o`)
 *   [8] channel prompt.md       — per-channel instructions (blueprint/channels/{name}/)
 *   [9] agent-context.md        — dynamic context from agent service (service/shared/)
 *  [10] <conversation-context>  — per-conversation routing facts
 */
import { extractIdentity, isParticipantAddress } from '../auth/address.js';
import type { ChannelContract } from '../auth/channel-contract.js';
import { renderContractForPrompt } from '../auth/channel-contract.js';
import { agentPath } from '../config.js';
import { readText } from '../lib/config-reader.js';
import type { AgentChannel } from '../conversations/types.js';
import { escapeXml } from '../lib/format.js';
import { getProfile } from '../profiles/index.js';
import { roughTimeAgo, toZonedIso } from '../lib/utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PromptAssemblyOpts {
  agentFolder: string;
  /** Agent display name (from host registry). */
  agentName: string;
  /** Participant address — bare identity or surface (e.g. "u:a7f3k@srv", "cli:alice"). */
  participant: string;
  /** Resolved channel definition. */
  channel: AgentChannel;
  /** Channel name (e.g. "default", "scratch"). */
  channelName: string;
  /** Container network isolation mode from config/agent.json. */
  containerNetwork?: string;
  /** Profile name (default 'standard'). */
  profileName?: string;
  /** Recent sessions for this participant (newest first, stops after first with summary). */
  previousSessions?: { lastActive: string; summary: string | null }[];
  /** Other participants active on this channel in the recent window (ambient awareness). */
  otherChannelParticipants?: { name: string; lastActive: string }[];
  /** Whether more channel participants exist beyond the capped list. */
  moreChannelParticipants?: boolean;
  /** User-chosen display name (from identity resolution). */
  declaredName?: string;
  /** Extension prompt sections (from active extension instances). */
  extensionPromptSections?: string[];
  /** IANA timezone for the agent (e.g. "America/New_York"). */
  timezone?: string;
  /** Operator-configured resource mounts (name → access mode, optional description from capabilities). */
  resources?: { name: string; access: string; description?: string }[];
  /** Whether pip tools are available for this agent. */
  hasPip?: boolean;
  /** Operational projection of the active channel's ACL bits toward the
   *  addressee, computed by the caller via `deriveChannelContract`. When
   *  present and non-default-conversational, an extra layer teaches the
   *  agent what envelopes are deliverable. Keep aligned with the bounce
   *  message in `agent/agent-spawn-hooks.ts` — both renderings live in
   *  `auth/channel-contract.ts`. */
  channelContract?: ChannelContract;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Assemble the complete system prompt for an agent conversation. */
export function assembleSystemPrompt(opts: PromptAssemblyOpts): string {
  const layers: string[] = [];

  // Layer 1: Cast protocol (server-generated)
  layers.push(buildProtocolLayer(opts));

  // Layer 2–3: Profile (prompt + skills)
  const profile = getProfile(opts.profileName ?? 'standard');
  if (profile.prompt) {
    layers.push(wrapTag('agent-profile', profile.prompt));
  }
  if (profile.skills) {
    layers.push(wrapTag('agent-profile-skills', profile.skills));
  }
  // Persistent-only: single-shot conversations self-close, so closure guidance
  // is noise. Cleanup-turn spawns are defended at handler time in
  // `AgentManager.requestConversationEnd` via the `isExpired` guard — gating
  // here would require threading runner state into assembly time, which
  // happens before runner creation. Console prompts skip this layer entirely
  // (they use `assembleConsolePrompt`, not this assembler).
  if (opts.channel.idle_timeout !== null && profile.proactiveClosure) {
    layers.push(wrapTag('agent-profile-closure', profile.proactiveClosure));
  }

  // Layer 4: blueprint/identity/prompt.md
  pushFileLayer(layers, opts.agentFolder, 'blueprint', 'identity', 'prompt.md');

  // Layer 5: blueprint/identity/whoami.md
  const whoami = readAgentFile(opts.agentFolder, 'blueprint', 'identity', 'whoami.md');
  if (whoami) {
    layers.push(wrapTag('agent-identity', whoami));
  }

  // Layer 6: blueprint/identity/peers.md
  const peers = readAgentFile(opts.agentFolder, 'blueprint', 'identity', 'peers.md');
  if (peers) {
    layers.push(wrapTag('agent-peers', peers));
  }

  // Layer 7: blueprint/identity/skills.md
  const skillsContent = readAgentFile(opts.agentFolder, 'blueprint', 'identity', 'skills.md');
  if (skillsContent) {
    layers.push(wrapTag('agent-skills', skillsContent));
  }

  // Layer 7.5: Channel contract (ACL-derived) — teaches the wire contract
  // before any per-channel author content. Only rendered when the channel
  // is not the default conversational mode (otherwise `null` is returned
  // and nothing is added).
  if (opts.channelContract) {
    const contractPrompt = renderContractForPrompt(opts.channelContract);
    if (contractPrompt) {
      layers.push(wrapTag('channel-contract', contractPrompt));
    }
  }

  // Layer 8: blueprint/channels/{name}/prompt.md (channel-specific instructions)
  const channelPrompt = readAgentFile(opts.agentFolder, 'blueprint', 'channels', opts.channelName, 'prompt.md');
  if (channelPrompt) {
    layers.push(wrapTag('channel-instructions', channelPrompt));
  }

  // Layer 9: shared/ext/service/agent-context.md (service-written, may not exist)
  const serviceContext = readAgentFile(opts.agentFolder, 'shared', 'ext', 'service', 'agent-context.md');
  if (serviceContext) {
    layers.push(wrapTag('service-context', serviceContext));
  }

  // Layer 10: Conversation context (server-generated)
  layers.push(buildConversationContext(opts));

  return layers.join('\n\n');
}

// ---------------------------------------------------------------------------
// Layer builders
// ---------------------------------------------------------------------------

function buildProtocolLayer(opts: PromptAssemblyOpts): string {
  const lines = [
    '<cast-protocol>',
    '',
    '## Directory Layout',
    '',
    '| Path | Purpose | Access |',
    '|------|---------|--------|',
    '| `/home/agent` | Your working directory (CWD) | read-write |',
    '| `/identity` | Your identity (system prompt, skills) | read-only |',
    '| `/memory` | Persistent memory (survives across conversations) | read-write |',
    '| `/assets` | Static reference data (databases, docs) | read-only |',
    '| `/shared` | Dynamic context from agent service | read-only |',
    '| `/attachments` | All received and sent files (content-addressed, persistent) | read-only |',
    '| `/staging/out` | Write files here to send them back | write |',
  ];

  // Operator-configured resource mounts
  for (const res of opts.resources ?? []) {
    const purpose = res.description ?? 'Operator-provided resource';
    lines.push(`| \`/resources/${res.name}\` | ${purpose} | ${res.access === 'rw' ? 'read-write' : 'read-only'} |`);
  }

  const effectiveNetworkMode = opts.containerNetwork ?? 'sdk-only';
  lines.push(
    '',
    '## Network Access',
    '',
  );
  if (effectiveNetworkMode === 'none') {
    lines.push('You have no network access. All operations must be local.');
  } else if (effectiveNetworkMode === 'sdk-only') {
    lines.push(
      'Direct network access is not available — only Anthropic API endpoints are reachable.',
      'Do not attempt to use curl, wget, or any direct HTTP requests.',
      'Use the **WebSearch** tool for web lookups (it works server-side via the SDK).',
    );
  } else {
    lines.push(`Network mode: \`${effectiveNetworkMode}\`.`);
  }

  // Python packages (conditional on pip config)
  if (opts.hasPip) {
    lines.push(
      '',
      '## Python Packages',
      '',
      'Use the `pip__install` tool to install packages — there is no pip binary in the container.',
      'Installed packages live in `/home/agent/.python-packages/` and persist across conversations.',
      'PYTHONPATH is preconfigured — `import <package>` works in any Python script after installation.',
    );
  }

  // Extension prompt sections (each extension owns its own prompt contribution)
  for (const section of opts.extensionPromptSections ?? []) {
    lines.push('', section);
  }

  lines.push('', '</cast-protocol>');
  return lines.join('\n');
}

function buildConversationContext(opts: PromptAssemblyOpts): string {
  const lines = [
    '<conversation-context>',
  ];

  if (!isParticipantAddress(opts.participant)) {
    throw new Error(
      `Invalid participant address: "${opts.participant}" — expected a bare identity (u:…@issuer), an agent (a:…@issuer), or an operator/console surface`,
    );
  }
  // Transport-blind: the agent sees only the bare identity. The handle is a
  // gateway-local delivery concern (resolved at the boundary), never ferried inward.
  const identity = extractIdentity(opts.participant);
  const nameAttr = opts.declaredName ? ` declared-name="${escapeXml(opts.declaredName)}"` : '';
  lines.push(`  <participant id="${escapeXml(identity)}"${nameAttr} />`);

  lines.push(
    `  <channel name="${escapeXml(opts.channelName)}" />`,
    `  <agent name="${escapeXml(opts.agentName)}" />`,
  );

  // Time block: ISO-with-offset in the agent's tz, weekday-prefixed for human readability.
  const tz = opts.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  lines.push(`  <time timezone="${escapeXml(tz)}">${toZonedIso(new Date(), tz, { weekday: true })}</time>`);

  if (opts.previousSessions?.length) {
    for (const session of opts.previousSessions) {
      const ago = roughTimeAgo(new Date(session.lastActive).getTime());
      if (session.summary) {
        lines.push(`  <previous-session last-active="${ago}">`);
        lines.push(`    ${escapeXml(session.summary)}`);
        lines.push('  </previous-session>');
      } else {
        lines.push(`  <previous-session last-active="${ago}" summary="unavailable" />`);
      }
    }
  } else {
    lines.push('  <previous-session first-time="true" />');
  }

  if (opts.channel.show_co_participants === false) {
    // Co-participant awareness disabled for this channel — emit an explicit
    // marker rather than nothing, so the agent reads "I can't see who else is
    // here, by policy" instead of inferring it's the only participant.
    lines.push('  <other-participants visibility="disabled" />');
  } else if (opts.otherChannelParticipants?.length) {
    const listed = opts.otherChannelParticipants
      .map((p) => `${escapeXml(p.name)} (${p.lastActive})`)
      .join(', ');
    const suffix = opts.moreChannelParticipants ? ', …more' : '';
    lines.push(`  <other-participants>${listed}${suffix}</other-participants>`);
  }

  lines.push('</conversation-context>');
  return lines.join('\n');
}


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip HTML comments (<!-- ... -->) from text. */
function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

/** Read a file from the agent's directory tree. Returns null if missing or empty. */
function readAgentFile(agentFolder: string, ...segments: string[]): string | null {
  const filePath = agentPath(agentFolder, ...segments);
  const raw = readText(filePath);
  if (!raw) return null;
  const content = stripComments(raw).trim();
  return content || null;
}

/** Read a file and push it directly to the layers array (no wrapping tag). */
function pushFileLayer(layers: string[], agentFolder: string, ...segments: string[]): void {
  const content = readAgentFile(agentFolder, ...segments);
  if (content) layers.push(content);
}

/** Wrap content in an XML tag. */
function wrapTag(tag: string, content: string): string {
  return `<${tag}>\n${content}\n</${tag}>`;
}


