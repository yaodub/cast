/**
 * Agent router — list, detail, config mutations, ACL.
 *
 * Thin wrappers over AgentManager and config files.
 */
import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { AgentConfigSchema, AgentManifestSchema, ProvisionsSchema, isUnlocked } from '@getcast/agent-schema/v1';

import type { AgentManager } from '../../agent/agent-manager.js';
import { AgentDb } from '../../agent/agent-db.js';
import { resourcePathEscapesAgentsTree } from '../../container/container-mounts.js';
import { AclSchema, revokeAclEdge, getOwner, setOwner as setAclOwner } from '../../auth/acl.js';
import { appendChangelog } from '../../lib/audit-log.js';
import { generateOwnerClaimCode } from '../../lib/owner-claims-store.js';
import { AGENTS_DIR, agentPath, listSubdirectories, readCapabilities, readProvisions, OWNER_CLAIM_TTL_MS } from '../../config.js';
import { ChannelJsonSchema, DEFAULT_CHANNEL_JSON } from '../../conversations/types.js';
import { logger } from '../../logger.js';
import { readJson, readParsed, readText } from '../../lib/config-reader.js';
import { generateId, writeAtomic } from '../../lib/utils.js';
import { agentUpdateConfigInput, agentUpdateProvisionsInput } from '../schemas.js';
import { aliasToFolder, publicProcedure, adminProcedure, router } from '../trpc.js';
import type { AdminDeps } from '../trpc.js';
import { AgentCreateError, createAgentScratch } from '../agent-create.js';
import { buildReviewRequestMessage, setLifecycle } from '../../console/shared/lifecycle.js';

const aliasInput = z.object({ alias: z.string() });

/** Resolve alias → folder, then look up the live AgentManager for that folder. */
function requireManager(deps: Pick<AdminDeps, 'bus' | 'getManager'>, alias: string): { mgr: AgentManager; folder: string } {
  const folder = aliasToFolder(deps, alias);
  const mgr = deps.getManager(folder);
  if (!mgr) throw new TRPCError({ code: 'NOT_FOUND', message: `Agent "${alias}" not found` });
  return { mgr, folder };
}

export const agentRouter = router({
  /** List all agents with basic status. Open endpoint (no auth). */
  list: publicProcedure.query(({ ctx }) => {
    const entities = ctx.deps.bus.listEntities({ type: 'agent' });
    return entities.map((entity) => {
      const mgr = ctx.deps.getManager(entity.folderPath);
      const config = readJson(agentPath(entity.folderPath, 'config', 'agent.json'));
      const parsed = config ? AgentConfigSchema.safeParse(config) : null;
      const manifestRaw = readJson(agentPath(entity.folderPath, 'manifest.json'));
      const manifest = manifestRaw ? AgentManifestSchema.safeParse(manifestRaw) : null;
      return {
        alias: entity.label,
        address: entity.id,
        description: entity.description ?? null,
        model: parsed?.success ? parsed.data.model ?? null : null,
        modelOverrideCount: parsed?.success ? parsed.data.modelOverrides?.length ?? 0 : 0,
        activeConversations: mgr ? mgr.currentActiveCount : 0,
        status: manifest?.success ? manifest.data.status ?? null : null,
      };
    });
  }),

  /** Agent detail — config, channels, conversations. Admin-gated. */
  get: adminProcedure.input(aliasInput).query(({ ctx, input }) => {
    const { mgr, folder } = requireManager(ctx.deps, input.alias);
    const config = readJson(agentPath(folder, 'config', 'agent.json'));
    const parsed = AgentConfigSchema.parse(config ?? {});

    // Read manifest — status: 'draft' surfaces the draft/ready lifecycle bit
    const manifestRaw = readJson(agentPath(folder, 'manifest.json'));
    const manifest = manifestRaw ? AgentManifestSchema.safeParse(manifestRaw) : null;
    const status = manifest?.success ? manifest.data.status ?? null : null;

    // Read channel configs. Each channel.json is parsed against the canonical
    // ChannelJsonSchema so the wire shape matches what callers expect (defaults
    // applied, types narrowed). A bad channel.json on disk surfaces here as a
    // server error rather than as a silent unknown blob downstream.
    const channelsDir = agentPath(folder, 'blueprint', 'channels');
    const channels = fs.existsSync(channelsDir)
      ? listSubdirectories(channelsDir).map((name) => {
          const channelConfig = readParsed(
            agentPath(folder, 'blueprint', 'channels', name, 'channel.json'),
            ChannelJsonSchema,
            DEFAULT_CHANNEL_JSON,
          );
          return { name, config: channelConfig };
        })
      : [];

    // Raw blueprint files surfaced for the Blueprint tab. Untyped on the
    // wire — the UI renders them as JSON for the operator to read.
    const capabilitiesRaw = readJson(agentPath(folder, 'blueprint', 'props', 'capabilities.json'));

    return {
      alias: input.alias,
      address: mgr.agentId,
      description: ctx.deps.bus.getMetadata(mgr.agentId)?.description ?? null,
      config: parsed,
      channels,
      blueprintPath: agentPath(folder, 'blueprint'),
      manifest: manifestRaw,
      capabilities: capabilitiesRaw,
      activeConversations: mgr.currentActiveCount,
      status,
    };
  }),

  /** Update agent config. Writes to config/agent.json. */
  updateConfig: adminProcedure
    .input(agentUpdateConfigInput)
    .mutation(({ ctx, input }) => {
      const folder = aliasToFolder(ctx.deps, input.alias);
      const configPath = agentPath(folder, 'config', 'agent.json');
      const existing = readParsed(configPath, AgentConfigSchema, AgentConfigSchema.parse({}));

      // Merge input fields. `undefined` = leave alone (filtered out of spread); `null` = remove
      // (only `backup` is nullable in the input schema).
      const { alias: _, backup, ...rest } = input;
      const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      const merged = { ...existing, ...defined };
      if (backup === null) delete merged.backup;
      else if (backup !== undefined) merged.backup = backup;

      const validated = AgentConfigSchema.parse(merged);
      writeAtomic(configPath, JSON.stringify(validated, null, 2));
      return validated;
    }),

  /**
   * Get ACL for an agent — the single ACL store `config/acl.json`. It holds
   * ALL live grants: operator-authored peers and runtime owner-approved edges
   * alike (the acl-edge approval writes granted edges into `allowed`). The Access
   * tab renders this one source — every grant lives here.
   *
   * Edits happen via the agent's Configure channel (chat), the owner-approval
   * flow at runtime, or by hand-editing `acl.json`.
   */
  getAcl: adminProcedure.input(aliasInput).query(({ ctx, input }) => {
    const folder = aliasToFolder(ctx.deps, input.alias);
    const aclPath = agentPath(folder, 'config', 'acl.json');
    const raw = readJson(aclPath);
    return AclSchema.parse(raw ?? {});
  }),

  /**
   * Pending approvals visible to the operator for this agent — the per-agent
   * operator inbox. Redundancy over detection: the
   * operator sees every approval whose controller is NOT the conversing
   * participant — both operator-sentinel rows AND rows routed to a human owner.
   * Owner-directed rows also land in the owner's own conversation; whichever
   * surface answers first resolves the row, and the loser sees it drop on the
   * next poll (first-responder-wins, enforced by the pending-status guard in
   * the approval handler). Participant-deciding tool-call rows (controller =
   * participant) stay out of the operator inbox.
   *
   * Shaped for the Access-tab section: the human `summary`, the subject
   * identity, the controller it's routed to (for labeling), the type, and the
   * requested bit parsed out of the acl-edge `payload`.
   */
  listPendingApprovals: adminProcedure.input(aliasInput).query(({ ctx, input }) => {
    const folder = aliasToFolder(ctx.deps, input.alias);
    const dbPath = agentPath(folder, 'state', 'agent.db');
    if (!fs.existsSync(dbPath)) return [];
    const db = new AgentDb(dbPath);
    try {
      return db.approvals.listPendingApprovals()
        .filter((row) => (row.controller ?? row.participant) !== row.participant)
        .map((row) => {
          // acl-edge rows carry `{ bit, ... }` in payload; tool-call rows don't.
          let bit: string | null = null;
          if (row.payload) {
            try { bit = (JSON.parse(row.payload) as { bit?: string }).bit ?? null; } catch { /* leave null */ }
          }
          return {
            id: row.id,
            type: row.type,
            summary: row.summary,
            // The actual content the requester is trying to send (the held
            // message / request body) — surfaced so the operator decides on
            // what was said, not just the framing summary. Rendered in full.
            details: row.details ?? null,
            participant: row.participant,
            // Who this approval is routed to: the `operator` sentinel, or a human
            // owner identity. The card labels it so the operator knows whether
            // they're the primary decider or a backstop over the owner.
            controller: row.controller ?? 'operator',
            channel: row.channel,
            bit,
            createdAt: row.created_at,
          };
        });
    } finally {
      db.close();
    }
  }),

  /**
   * Fleet-wide count of operator-visible pending approvals, keyed by alias — for
   * the admin sidebar badge. Same filter as listPendingApprovals (controller is
   * not the conversing participant — operator-sentinel plus owner-directed rows),
   * aggregated so the sidebar renders one poll, not one query per row. Aliases
   * with zero pending are omitted (the badge reads `count > 0`). Admin-gated: the
   * public `agent.list` must not leak request counts.
   */
  pendingApprovalCounts: adminProcedure.query(({ ctx }) => {
    const counts: Record<string, number> = {};
    for (const entity of ctx.deps.bus.listEntities({ type: 'agent' })) {
      const dbPath = agentPath(entity.folderPath, 'state', 'agent.db');
      if (!fs.existsSync(dbPath)) continue;
      const db = new AgentDb(dbPath);
      try {
        const n = db.approvals.listPendingApprovals()
          .filter((row) => (row.controller ?? row.participant) !== row.participant).length;
        if (n > 0) counts[entity.label] = n;
      } finally {
        db.close();
      }
    }
    return counts;
  }),

  /**
   * Answer an operator-routed approval from the Access-tab inbox. Routes the
   * decision through the same path as a transport answer
   * (`gateway.ingestApprovalResponse`), with an `admin:` operator handle — which
   * `isAuthorizedAnswerer` accepts as the god-mode backstop. `tier` ('once' /
   * 'always') is honored because the controller (operator) differs from the
   * conversing participant; 'always' writes the grant/tombstone into acl.json,
   * which trips the file watcher and refreshes `getAcl` on its own.
   */
  respondApproval: adminProcedure
    .input(z.object({
      alias: z.string(),
      id: z.string().min(1),
      decision: z.enum(['approved', 'rejected']),
      tier: z.enum(['once', 'always']),
    }))
    .mutation(({ ctx, input }) => {
      const { mgr } = requireManager(ctx.deps, input.alias);
      const from = `admin:${ctx.session.token.slice(0, 8)}`;
      ctx.deps.gateway.ingestApprovalResponse(from, mgr.agentId, {
        id: input.id,
        decision: input.decision,
        tier: input.tier,
      });
      return { ok: true };
    }),

  /**
   * Plain-remove a granted edge from `config/acl.json` `allowed` — the Access-tab
   * revoke affordance for both user and agent-peer rows. The peer returns to
   * *askable* (it may request again); this does not tombstone. Operator action,
   * not chat-driven (revoking access is not something the agent does on the
   * operator's behalf).
   */
  revokeAclEdge: adminProcedure
    .input(z.object({ alias: z.string(), peer: z.string().min(1), channel: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      const folder = aliasToFolder(ctx.deps, input.alias);
      revokeAclEdge(folder, input.peer, input.channel);
      appendChangelog(folder, {
        actor: 'local', action: 'access_revoked', peer: input.peer, channel: input.channel,
      });
      return { ok: true };
    }),

  /**
   * Current owner + any outstanding owner-claim, for the Access-tab owner panel.
   * `owner` is the resolved owner identity (`operator` sentinel when unbound).
   * `active` is the live (pending, unexpired) claim code the operator can still
   * hand out, or null. Re-surfacing the code lets a reload show the outstanding
   * claim rather than minting a fresh one.
   */
  ownerClaim: adminProcedure.input(aliasInput).query(({ ctx, input }) => {
    const folder = aliasToFolder(ctx.deps, input.alias);
    const owner = getOwner(ctx.deps.bus, folder) ?? 'operator';
    const dbPath = agentPath(folder, 'state', 'agent.db');
    if (!fs.existsSync(dbPath)) return { owner, active: null };
    const db = new AgentDb(dbPath);
    try {
      const row = db.ownerClaims.activeClaim();
      return { owner, active: row ? { code: row.code, expiresAt: row.expires_at } : null };
    } finally {
      db.close();
    }
  }),

  /**
   * Mint a one-time owner-claim code. The operator hands the
   * returned code to the intended human owner out-of-band; they redeem it by
   * messaging the agent `/claim <code>`, which binds their transport-
   * authenticated identity as owner. One-active-per-agent (a new mint supersedes
   * any un-redeemed predecessor) and time-scoped (`OWNER_CLAIM_TTL_MS`). The code
   * is the capability — direct recognition-only owner writes are deliberately not
   * offered (a name is not verification); the only non-claim write is reverting
   * to the operator sentinel via `setOwner`.
   */
  mintOwnerClaim: adminProcedure.input(aliasInput).mutation(({ ctx, input }) => {
    const folder = aliasToFolder(ctx.deps, input.alias);
    const dbPath = agentPath(folder, 'state', 'agent.db');
    const db = new AgentDb(dbPath);
    try {
      const code = generateOwnerClaimCode();
      const expiresAt = new Date(Date.now() + OWNER_CLAIM_TTL_MS).toISOString();
      db.ownerClaims.mint(code, expiresAt);
      return { code, expiresAt };
    } finally {
      db.close();
    }
  }),

  /**
   * Event log for this agent — errors, warnings, and lifecycle markers from
   * `state/agent.db`. Returns `{ events, total, truncated }`. `total` is the
   * unbounded count under the same filters; `truncated` is `events.length < total`.
   */
  events: adminProcedure
    .input(z.object({
      alias: z.string(),
      limit: z.number().int().positive().max(500).optional(),
      level: z.enum(['error', 'warn', 'info']).optional(),
      component: z.enum(['agent', 'backup', 'container', 'conversation', 'scheduler', 'service']).optional(),
      since: z.string().optional(),
      conversationKey: z.string().optional(),
    }))
    .query(({ ctx, input }) => {
      const folder = aliasToFolder(ctx.deps, input.alias);
      const dbPath = agentPath(folder, 'state', 'agent.db');
      if (!fs.existsSync(dbPath)) return { events: [], total: 0, truncated: false };
      const limit = input.limit ?? 100;
      const queryOpts = {
        level: input.level,
        component: input.component,
        since: input.since,
        conversationKey: input.conversationKey,
      };
      const db = new AgentDb(dbPath);
      try {
        const events = db.readEvents({ ...queryOpts, limit });
        const total = db.countEvents(queryOpts);
        return { events, total, truncated: events.length < total };
      } finally {
        db.close();
      }
    }),

  /** Wipe the event log for this agent. Returns the count of rows deleted. */
  clearEvents: adminProcedure.input(aliasInput).mutation(({ ctx, input }) => {
    const folder = aliasToFolder(ctx.deps, input.alias);
    const dbPath = agentPath(folder, 'state', 'agent.db');
    if (!fs.existsSync(dbPath)) return { deleted: 0 };
    const db = new AgentDb(dbPath);
    try {
      return { deleted: db.clearEvents() };
    } finally {
      db.close();
    }
  }),

  /** Active conversations (no message content). */
  conversations: adminProcedure.input(aliasInput).query(({ ctx, input }) => {
    const { folder } = requireManager(ctx.deps, input.alias);
    const statePath = agentPath(folder, 'state', 'conversations.jsonl');
    if (!fs.existsSync(statePath)) return [];
    const ConvLineSchema = z.object({
      conversationKey: z.string(),
      channelName: z.string(),
      participant: z.string().nullable(),
      lastActive: z.string(),
      status: z.string(),
    });
    const lines = fs.readFileSync(statePath, 'utf-8').split('\n').filter(Boolean);
    return lines.flatMap((line) => {
      const parsed = ConvLineSchema.safeParse((() => { try { return JSON.parse(line); } catch { return null; } })());
      if (!parsed.success) return [];
      const e = parsed.data;
      if (e.status !== 'active') return [];
      return [{ conversationKey: e.conversationKey, channel: e.channelName, participant: e.participant, lastActive: e.lastActive, status: e.status }];
    });
  }),

  // -------------------------------------------------------------------------
  // Provisions — capabilities slots + operator-filled values
  // -------------------------------------------------------------------------

  /** Read capabilities + provisions merged view for the admin UI. */
  getProvisions: adminProcedure.input(aliasInput).query(({ ctx, input }) => {
    const folder = aliasToFolder(ctx.deps, input.alias);
    const caps = readCapabilities(folder);
    const provisions = readProvisions(folder);

    // Resources: slot declarations + current provisions
    const resources = Object.entries(caps.resources).map(([name, slot]) => {
      const prov = provisions.resources[name];
      const provPath = typeof prov === 'string' ? prov : prov?.path ?? null;
      const provAccess = typeof prov === 'object' && prov !== null ? prov.access : undefined;
      return {
        name,
        description: slot.description ?? null,
        access: slot.access,
        required: slot.required,
        provisionedPath: provPath,
        provisionedAccess: provAccess ?? null,
      };
    });

    // Pip
    const pip = caps.pip ? {
      allowedPackages: caps.pip.allowed_packages,
      extraPackagesUnlocked: isUnlocked(caps.pip.extra_packages),
      extraPackages: provisions.pip?.extra_packages ?? [],
    } : null;

    // Additional disabled tools
    const additionalDisabledTools = {
      unlocked: isUnlocked(caps.additional_disabled_tools),
      values: provisions.additional_disabled_tools,
    };

    return { resources, pip, additionalDisabledTools };
  }),

  /** Update provisions.json — operator-fillable deployment values. */
  updateProvisions: adminProcedure
    .input(agentUpdateProvisionsInput)
    .mutation(({ ctx, input }) => {
      const folder = aliasToFolder(ctx.deps, input.alias);
      const caps = readCapabilities(folder);
      const provisionsPath = agentPath(folder, 'config', 'provisions.json');
      const existing = readParsed(provisionsPath, ProvisionsSchema, ProvisionsSchema.parse({}));

      // Resources: validate against declared slots
      if (input.resources) {
        const res: Record<string, string> = {};
        for (const [name, resourcePath] of Object.entries(input.resources)) {
          if (!caps.resources[name]) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: `Resource "${name}" not declared in capabilities` });
          }
          if (resourcePath !== null) {
            const escape = resourcePathEscapesAgentsTree(resourcePath);
            if (escape) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: `Resource "${name}": ${escape}. Agent folders are private and cannot be mounted into another agent.`,
              });
            }
            res[name] = resourcePath;
          }
        }
        existing.resources = res;
      }

      // Pip extra packages: only if unlocked
      if (input.pipExtraPackages !== undefined) {
        if (!caps.pip || !isUnlocked(caps.pip.extra_packages)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'pip.extra_packages is locked by the blueprint author' });
        }
        existing.pip = { extra_packages: input.pipExtraPackages };
      }

      // Additional disabled tools: only if unlocked
      if (input.additionalDisabledTools !== undefined) {
        if (!isUnlocked(caps.additional_disabled_tools)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'additional_disabled_tools is locked by the blueprint author' });
        }
        existing.additional_disabled_tools = input.additionalDisabledTools;
      }

      fs.mkdirSync(agentPath(folder, 'config'), { recursive: true });
      writeAtomic(provisionsPath, JSON.stringify(existing, null, 2));
      return { ok: true };
    }),

  /** Restart agent service process — bypasses crash-recovery backoff. */
  restartService: adminProcedure
    .input(aliasInput)
    .mutation(async ({ ctx, input }) => {
      const { mgr } = requireManager(ctx.deps, input.alias);
      await mgr.restartService();
      return { ok: true };
    }),

  /** Read schedule.txt entries (read-only display). */
  getSchedule: adminProcedure.input(aliasInput).query(({ ctx, input }) => {
    const folder = aliasToFolder(ctx.deps, input.alias);
    const raw = readText(agentPath(folder, 'blueprint', 'props', 'schedule.txt'));
    if (!raw) return [];
    return raw.split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const parts = line.split(/\s+/);
        if (parts.length < 7) return { raw: line, cron: null, channel: null, message: null };
        return {
          raw: line,
          cron: parts.slice(0, 5).join(' '),
          channel: parts[5] ?? null,
          message: parts.slice(6).join(' '),
        };
      });
  }),

  // -------------------------------------------------------------------------
  // Agent lifecycle — create, finalize, archive, setOwner
  // -------------------------------------------------------------------------

  /**
   * Create an agent. Writes a minimal `status: 'draft'` scaffold and
   * registers it with the server so it's live immediately. The UI
   * redirects the operator to the new agent's Design tab to compose it.
   */
  create: adminProcedure
    .input(z.object({ name: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      try {
        createAgentScratch(input.name);
      } catch (err) {
        if (err instanceof AgentCreateError) {
          const code = err.code === 'ALREADY_EXISTS' ? 'CONFLICT' : 'BAD_REQUEST';
          throw new TRPCError({ code, message: err.message });
        }
        throw err;
      }

      const result = await ctx.deps.discoverAndRegisterAgent(input.name);
      if (!result.ok) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Agent written but discovery failed: ${result.reason}`,
        });
      }

      // `discoverAndRegisterAgent` above already called bus.register, which
      // fires the `registered` lifecycle event for server-scope consoles.
      return { alias: input.name, address: result.agentAuth.address };
    }),

  /**
   * Validate a security-review request and return the canonical prompt text
   * for the client to send through the regular SM chat path. The UI calls
   * `smChat.send(text)` on success so the operator's message lands in the
   * IndexedDB transcript via `writeEcho` and is immediately visible in the
   * SM chat panel — symmetric with how `<HelpButton/>` posts to a manager
   * chat and how operator-typed messages appear. SM is still the gate:
   * `manifest.status` is NOT mutated here. The agent stays in draft until
   * SM calls `security__finalize_agent` (after the operator approves in
   * the SM chat), or until the operator takes the Settings → Lifecycle
   * override via `setLifecycle`.
   *
   * Idempotent in spirit: re-requesting just hands back another primed
   * message. The client should debounce to avoid spamming SM.
   */
  requestReview: adminProcedure
    .input(aliasInput)
    .mutation(({ ctx, input }) => {
      const { folder } = requireManager(ctx.deps, input.alias);
      const manifestPath = agentPath(folder, 'manifest.json');
      const raw = readJson(manifestPath);
      if (!raw) throw new TRPCError({ code: 'NOT_FOUND', message: 'manifest.json missing' });
      const manifest = AgentManifestSchema.parse(raw);
      if (manifest.status !== 'draft') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Agent "${input.alias}" is not in draft — nothing to review.`,
        });
      }

      const changeId = generateId('review');
      const text = buildReviewRequestMessage(folder, changeId);
      return { ok: true, changeId, text };
    }),

  /**
   * Mechanical lifecycle override — flips `manifest.status` directly without
   * routing through Security Manager. This is the escape hatch behind
   * Settings → Lifecycle:
   *   - `status: 'ready'` finalizes a draft (skips SM review).
   *   - `status: 'draft'` pulls a live agent back to draft.
   *
   * Audit row carries `via: 'manual_override'` so the trail distinguishes
   * override flips from reviewed flips (`via: 'sm_review'`) and Design's
   * unilateral reverts (`via: 'design_revert'`).
   */
  setLifecycle: adminProcedure
    .input(z.object({ alias: z.string(), status: z.enum(['draft', 'ready']) }))
    .mutation(({ ctx, input }) => {
      const { folder } = requireManager(ctx.deps, input.alias);
      const result = setLifecycle(folder, input.status, {
        actor: 'operator',
        via: 'manual_override',
      });
      if ('error' in result) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error });
      }
      return { ok: true, from: result.from, to: result.to, noop: result.noop };
    }),

  /**
   * Archive an agent: stop the running manager, zip `mnt/agents/{folder}/`
   * to `mnt/.trash/{folder}-{ISO8601}.zip`, remove the live folder, and
   * emit an `agent-registry.changed` event so server-scope consoles
   * invalidate their runners. Reversible via terminal unzip + server
   * restart. Not a hard delete — the zip stays under `mnt/.trash/`.
   */
  archive: adminProcedure
    .input(aliasInput)
    .mutation(async ({ ctx, input }) => {
      const { folder } = requireManager(ctx.deps, input.alias);
      const folderPath = agentPath(folder);

      if (!fs.existsSync(folderPath)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: `Folder not found: ${folder}` });
      }

      const trashDir = path.resolve(AGENTS_DIR, '..', '.trash');
      fs.mkdirSync(trashDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const zipPath = path.join(trashDir, `${folder}-${stamp}.zip`);

      await ctx.deps.unregisterAgent(folder);

      try {
        await new Promise<void>((resolve, reject) => {
          const out = fs.createWriteStream(zipPath);
          const zip = archiver('zip', { zlib: { level: 9 } });
          out.on('close', () => resolve());
          out.on('error', reject);
          zip.on('error', reject);
          zip.pipe(out);
          zip.directory(folderPath, folder);
          void zip.finalize();
        });
      } catch (err) {
        logger.error({ folder, err }, 'Archive zip failed');
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: `zip failed: ${String(err)}` });
      }

      fs.rmSync(folderPath, { recursive: true, force: true });

      // The unregisterAgent above called bus.unregister, which fires the
      // `deregistered` lifecycle event for server-scope consoles.
      logger.info({ folder, zipPath }, 'Agent archived');
      return { ok: true, zipPath };
    }),

  /**
   * Set the ACL owner identity. Operator action, never chat-driven (that would
   * be a prompt-injection surface). In practice the Access-tab panel calls this
   * only to revert to the `operator` sentinel — binding a *human* owner goes
   * through the verification loop (`mintOwnerClaim` + `/claim` redeem), because a
   * recognized name is not a verified identity. Reverting also unpins the owner
   * conversation (`approval_channel` → null) so a stale pin can't linger.
   */
  setOwner: adminProcedure
    .input(z.object({ alias: z.string(), owner: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      const { folder } = requireManager(ctx.deps, input.alias);
      setAclOwner(folder, input.owner, null);
      return { ok: true, owner: input.owner };
    }),
});
