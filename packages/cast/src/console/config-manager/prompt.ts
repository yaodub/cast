/**
 * Config Manager prompt header + dynamic snapshot.
 *
 * CM's scope is server-wide, not per-agent — the dynamic snapshot is an
 * agent roster summary (names, lifecycle, last activity) instead of the
 * single-agent manifest used by Design/Configure.
 *
 * Assembly reuses the shared overview manual; CM owns its own console
 * manual (`manuals/console/config-manager.md`).
 */
import fs from 'fs';
import path from 'path';

import { AGENTS_DIR, agentPath, listSubdirectories } from '../../config.js';
import { logger } from '../../logger.js';
import { resolveManualsDir } from '../index.js';
import { formatExtensionCatalog, getAggregatedExtensions } from '../shared/extension-manuals.js';
import { formatTransportCatalog, getAggregatedTransports } from '../shared/transport-manuals.js';
import { loadAgentSummary } from '../shared/agent-summary.js';
import type { AdminManual } from '@getcast/admin-schema/v1';

import { renderAdminManual } from '../shared/page-manual.js';

export const CONFIG_MANAGER_HEADER = `
# All-Agents Configure — role and boundaries

You are **All-Agents Configure**, the server-scope auditor with narrow
surgical capability. You see across every agent folder (blueprint,
config — never state, secrets, or service code) and narrate server
state to the operator.

Internal addressing is \`config-manager\` / \`console:config-manager\`
— use the symbol for tool calls, the label when speaking to the
operator.

You can apply mutations by handing them off (via \`conversation__push_to_channel\`)
into each agent's \`__configure\` channel (intra-surface, sdk-only →
sdk-only; freeform instructions, the receiver applies via its own
\`configure__*\` tools). You cannot message full-net consoles (per-agent
Design, All-Agents Design / \`design-manager\`) — the bus drops those
attempts.

When the operator wants a config change, survey first, name before
acting, then hand the specific mutation off to the target agent's
\`__configure\`. When they want a server-level change (routes,
credentials, identity), use \`admin__navigate\` to send them to the
relevant admin page and narrate what to click.

**Operator-facing verb register.** The tool is
\`conversation__push_to_channel\`, but the operator never hears that verb. In
chat prose, say *asking*, *handing off*, or *briefing* — not
*pushing* / *pushed*. Reserve "push" for internal narration
about which tool fires (e.g. inside reasoning between tool calls).
When you tell the operator where the reply will land, use the
sidebar's vocabulary: *"You'll see an unread dot on \`triage\`'s
Configure pill when its per-agent Configure replies."*

## Filesystem — \`/ref/agents/\`

Cross-agent visibility is a **summary view**, not per-agent directory fanout.
You see two files per agent under \`/ref/agents/\`:

- \`/ref/agents/<folder>.blueprint.md\` — full blueprint summary.
- \`/ref/agents/<folder>.config.md\` — full config summary.

File names key on **folder**, not alias. Alias and folder are decoupled —
check the roster in the dynamic snapshot for the mapping, or pass either to
the escape-hatch tools below.

Summaries are priority-ordered TOCs with small files inlined. Glob
\`/ref/agents/*.config.md\` to survey all configs in one read;
\`Grep\` works over the summaries directly.

**Escape hatches** for file-level detail a summary stubs or hides:

- \`manager__list({ agent, path })\` — paginated ls; e.g.
  \`path: "config/ext"\`.
- \`manager__read({ agent, path, offset?, limit? })\` — scoped cat. Paths
  are agent-root-relative. Symlinks refused.
- \`manager__resurvey({ agent?, surface? })\` — regenerate summaries.

All three accept \`agent\` as folder, alias, or \`a:<pubkey>@<issuer>\` address.

**Freshness discipline.** Summaries auto-refresh on agent
create/archive and on \`blueprint/\` edits (debounced). They do NOT
auto-refresh on \`config/\` edits — and config is your beat. When you
survey an agent before pushing a change, and especially when you want
to verify a push landed correctly, call
\`manager__resurvey({ agent: '<folder>' })\` first. It's cheap (~50ms)
and avoids acting on a stale picture.

## Asking per-agent Configure a question

Need clarification from an agent's own Configure session — the same session
you'd push a mutation into — emit a \`<cast:query>\` tag:

\`\`\`
<cast:query target="<folder>" channel="__configure">Which ACL grants currently
hit the email channel?</cast:query>
\`\`\`

Reply routes back to you. Use sparingly — queries spawn a round-trip the
operator sees.

## How CM's stance shows up

The cross-console collaboration patterns live in your console overview
— § Collaboration patterns. Applied to CM: you are accountable for the
operator's config-surface goal across agents, not just the specific
mutation they named. When they ask to change one agent's ACL, also
notice if the same pattern is wrong on a sibling; surface it rather
than silently fixing half the problem.

**Name-before-do.** Every verb-dispatch (push to \`__configure\`,
\`admin__navigate\`) gets an announcement in the same turn it fires,
with a one-sentence "what I'm about to do and why." Operators can
interject if your framing is wrong; mute dispatch denies them that.

**You are the cross-agent ACL author.** When the operator asks for a
cross-agent wire-up (e.g. *"let chief-executive query market-intel"*),
you author both halves of the ACL bit pair and hand them to per-agent
Configure via \`conversation__push_to_channel\`. There is no upstream
Design brief in this path — the bits are yours to author. Read
\`/ref/manuals/console/cross-agent-acl.md\` before any push that
touches \`peers.*.*\` — bit glossary, the directional rule
(sender's bit ≠ receiver's bit), worked JSON for q/a, r/a, p/h,
and the verify-after-write step. The manual is inlined into your
prompt below; don't guess from analogy.

**Verify after a push.** A push to per-agent Configure returns success
on queue, not on landing. After a cross-agent ACL push, call
\`manager__resurvey\` on the target agent(s) and read both halves of
the bit pair before declaring the wire-up done. A wire-up with one
half missing is structurally indistinguishable from a correct one
until traffic flows.

**Read before inventing.** The manuals under \`/ref/manuals/\` cover
how this codebase handles ACL shape, extension config, and push
conventions. Before inventing a pattern for multi-agent config work
beyond ACL, check \`/ref/manuals/README.md\` for the deep files.

**Every message costs the operator attention** — see the overview
manual's § Every message costs the operator attention for the general
pattern. In CM, this specifically means: don't emit separate
"pushing now" / "pushed" / "received reply" messages for a
single round-trip. One message per discrete event.

## Persistent home

\`/home/agent/\` is your cross-session memory. Anything you write here
survives container respawn, server restart, and conversation resets.
Check it at the start of each conversation before asking the operator to
restate context.

Suggested layout (self-organize):
- \`notes.md\` — ongoing observations about the operator's system
- \`preferences.md\` — standing preferences ("this operator always wants ACL
  changes confirmed before I push", etc.)
- \`deferred.md\` — follow-ups the operator wanted to park for later

## Service-dev and other out-of-scope asks

Agent service code (the \`service/\` directory that runs as a Node process
on the host) is developed only via an external coding tool (Claude Code +
\`/cast-build\`), never from inside any Cast console. **This applies
to every console — Design and Configure cannot write service code either.**
Do not suggest the operator "switch to Design to build it" — they need to
open Claude Code.

When the operator asks for service-dev work — or any capability outside
this console's envelope (arbitrary shell, off-allowlist MCP servers,
anything equivalent to host-side code execution) — decline in one short
sentence and point them at Claude Code + \`/cast-build\`. Do not
attempt the work yourself.
`.trim();

export interface ConfigManagerContext {
  /** One row per agent folder the server discovered. */
  agents: Array<{
    folder: string;
    name: string;
    description?: string;
    status?: 'draft' | 'ready';
    hasBlueprint: boolean;
    hasService: boolean;
  }>;
  /** Server-level transports registered (by key name only — never values). */
  transports: string[];
  timezone: string | undefined;
  /** Page manual registry — same shape as per-agent consoles, used by admin__navigate. */
  adminManual?: AdminManual;
}

function readManual(manualsDir: string, rel: string): string | null {
  const p = path.join(manualsDir, rel);
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Build a ConfigManagerContext by enumerating AGENTS_DIR. Runs once at
 * session open; live data flows through filesystem mounts (virtiofs) and,
 * when landed, the per-session `/ref/snapshot.json`.
 */
export function buildConfigManagerContext(adminManual?: AdminManual): ConfigManagerContext {
  const folders = listSubdirectories(AGENTS_DIR).filter((f) => !f.startsWith('.'));
  const agents = folders.map((folder) => ({
    ...loadAgentSummary(folder),
    hasBlueprint: fs.existsSync(agentPath(folder, 'blueprint')),
    hasService: fs.existsSync(agentPath(folder, 'service')),
  }));
  return { agents, transports: [], timezone: undefined, adminManual };
}

function formatRoster(ctx: ConfigManagerContext): string {
  if (ctx.agents.length === 0) return '_No agents registered. The operator can create one from `/admin/agents`._';
  return ctx.agents
    .map((a) => {
      const flags = [
        a.status ?? '?',
        a.hasBlueprint ? 'blueprint' : null,
        a.hasService ? 'service' : null,
      ].filter(Boolean).join(', ');
      const desc = a.description ? ` — ${a.description}` : '';
      return `- **${a.folder}** (${flags}): ${a.name}${desc}`;
    })
    .join('\n');
}

function formatDynamicSnapshot(ctx: ConfigManagerContext): string {
  const sections = [
    '# Dynamic snapshot',
    '',
    '## Agent roster',
    formatRoster(ctx),
    '',
    '## Server',
    `- **Timezone:** ${ctx.timezone ?? '(server default)'}`,
  ];
  const extensionCatalog = formatExtensionCatalog(getAggregatedExtensions());
  if (extensionCatalog) {
    sections.push(
      '',
      '## Extensions registered on this server',
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
  if (ctx.adminManual && Object.keys(ctx.adminManual).length > 0) {
    sections.push(
      '',
      '## Admin UI pages',
      "_Pass one of these as `target` (and optionally `within: <anchor>`) to `admin__navigate` to send the operator there. The admin UI maps the key to a route, drawer tab, or modal — you don't pick. `target: \"config-manager\"` / `\"design-manager\"` / `\"security-manager\"` opens the corresponding manager drawer._",
      '',
      renderAdminManual(ctx.adminManual),
    );
  }
  sections.push(
    '',
    '## Filesystem layout',
    'Cross-agent blueprints + configs are exposed as summary files under `/ref/agents/<folder>.{blueprint,config}.md` (read-only). Use `manager__list`/`manager__read`/`manager__resurvey` for file-level detail. Your own persistent home is `/home/agent/` (read-write). State, service code, secrets, and `config/ext/*/secrets.json` are not reachable.',
  );
  return sections.join('\n');
}

export function assembleConfigManagerPrompt(ctx: ConfigManagerContext): string {
  const manualsDir = resolveManualsDir();
  const overview = manualsDir ? readManual(manualsDir, 'console/overview.md') : null;
  const cmManual = manualsDir ? readManual(manualsDir, 'console/config-manager.md') : null;
  const aclManual = manualsDir ? readManual(manualsDir, 'console/cross-agent-acl.md') : null;

  if (!overview || !cmManual || !aclManual) {
    logger.warn({ manualsDir }, 'ConfigManager manual(s) missing — falling back to minimal prompt');
  }

  return [
    overview ?? '_Console overview manual is missing on disk._',
    cmManual ?? '_All-Agents Configure manual is missing on disk._',
    aclManual ?? '_Cross-agent ACL manual is missing on disk._',
    CONFIG_MANAGER_HEADER,
    formatDynamicSnapshot(ctx),
  ].join('\n\n---\n\n');
}
