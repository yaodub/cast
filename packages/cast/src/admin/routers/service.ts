/**
 * Service admin router — generic, declaration-driven surface for a per-agent
 * service's operator-owned files, mirroring the extensions' split:
 *
 *   manifest `secrets` → config/ext/service/secrets.json   (flat strings, maskable)
 *   manifest `config`  → config/ext/service/config.json    (typed settings)
 *   manifest `admin`   → permalink to the service-rendered page
 *                        (svc.admin() proxied at /agents/{folder}/admin/)
 *
 * Deliberately NOT per-service: the per-extension routers (email, calendar,
 * whatsapp) exist because first-party flows are bespoke (OAuth dances, IMAP
 * probes). Services are user-land — flat declarations drive this one shared
 * surface, and anything richer belongs on the service's own admin page.
 *
 * Writes never restart the service from here — AgentManager's watcher sees
 * the file change and restarts the service itself, the same single mechanism
 * that covers hand edits (see restartServiceForConfigChange).
 */
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import { ServiceManifestSchema, type ServiceManifest } from '@getcast/agent-schema/v1';
import { TRPCError } from '@trpc/server';

import { agentPath } from '../../config.js';
import { readSecretsJson, writeSecretsJson } from '../../lib/secrets-file.js';
import { SESSION_COOKIE, createSession } from '../service-page-access.js';
import { adminProcedure, aliasToFolder, maskSecret, router } from '../trpc.js';

const aliasInput = z.object({ alias: z.string() });

const SettingValue = z.union([z.string(), z.number(), z.boolean()]);

/** getConfig response contract. Validated on return — a parse failure here
 *  is a server bug, not a runtime data issue. */
/** Service lifecycle states (AgentService.status) plus `unknown` for when the
 *  agent's manager isn't loaded. Keep in sync with ServiceState in agent-service.ts. */
const SERVICE_STATUSES = ['idle', 'starting', 'running', 'restarting', 'stopped', 'failed', 'unknown'] as const;

const ServiceAdminResponseSchema = z.object({
  /** A runnable service exists on disk (stamped bundle or resolvable entry),
   *  independent of whether it declares anything operator-facing. The card
   *  renders on `present || declared` so a declaration-less service still gets
   *  a restart affordance. */
  present: z.boolean(),
  /** Live lifecycle status of the service process. */
  status: z.enum(SERVICE_STATUSES),
  /** False when the manifest declares nothing operator-facing — settings/secrets/admin sections are hidden. */
  declared: z.boolean(),
  /** Service-rendered admin page declared (manifest `admin: true`). */
  admin: z.boolean(),
  /** Declared credentials in manifest order. `value` is masked when `secret` is true. */
  secrets: z.array(z.object({
    key: z.string(),
    label: z.string(),
    secret: z.boolean(),
    required: z.boolean(),
    value: z.string(),
    set: z.boolean(),
  })),
  /** Declared settings in manifest order. `value` falls back to the declared default while unset. */
  config: z.array(z.object({
    key: z.string(),
    label: z.string(),
    type: z.enum(['string', 'number', 'boolean']),
    value: SettingValue,
    set: z.boolean(),
  })),
});

/** Read + validate blueprint/service/manifest.json. Read via fs, not the
 *  config-reader cache — blueprint/service/ is not a watched directory. */
function readServiceManifest(folder: string): ServiceManifest | null {
  const manifestPath = agentPath(folder, 'blueprint', 'service', 'manifest.json');
  try {
    return ServiceManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));
  } catch {
    return null;
  }
}

/** A service is present if a runnable entrypoint exists: the stamped bundle
 *  (blueprint/service/index.js) or a manifest `entry` whose file exists. Mirrors
 *  the resolution in AgentService.startService. */
function serviceExists(folder: string, manifest: ServiceManifest | null): boolean {
  const serviceDir = agentPath(folder, 'blueprint', 'service');
  if (fs.existsSync(path.join(serviceDir, 'index.js'))) return true;
  if (manifest?.entry) return fs.existsSync(path.resolve(serviceDir, manifest.entry));
  return false;
}

/** Type-directed empty value, shown when a setting is unset and undefaulted. */
function emptyFor(type: 'string' | 'number' | 'boolean'): string | number | boolean {
  return type === 'number' ? 0 : type === 'boolean' ? false : '';
}

/** Coerce an admin-form value to the declared type (forms ship numbers and
 *  booleans as strings depending on the widget). Returns null on mismatch. */
function coerceSetting(declared: 'string' | 'number' | 'boolean', value: string | number | boolean): string | number | boolean | null {
  if (declared === 'string') return typeof value === 'string' ? value : null;
  if (declared === 'number') {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
    return null;
  }
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return null;
}

export const serviceRouter = router({
  getConfig: adminProcedure.input(aliasInput).query(({ ctx, input }) => {
    const folder = aliasToFolder(ctx.deps, input.alias);
    const manifest = readServiceManifest(folder);
    const declaredSecrets = manifest?.secrets ?? {};
    const declaredConfig = manifest?.config ?? {};
    const admin = manifest?.admin ?? false;
    const present = serviceExists(folder, manifest);
    const status = ctx.deps.getManager(folder)?.serviceStatus ?? 'unknown';

    const declared = Object.keys(declaredSecrets).length > 0 || Object.keys(declaredConfig).length > 0 || admin;
    if (!declared) {
      return ServiceAdminResponseSchema.parse({ present, status, declared: false, admin: false, secrets: [], config: [] });
    }

    const rawSecrets = readSecretsJson(agentPath(folder, 'config', 'ext', 'service', 'secrets.json'));
    const secrets = Object.entries(declaredSecrets).map(([key, decl]) => {
      const stored = rawSecrets[key];
      const val = stored == null || stored === '' ? '' : String(stored);
      return {
        key,
        label: decl.label,
        secret: decl.secret ?? false,
        required: decl.required ?? false,
        value: val && decl.secret ? maskSecret(val) : val,
        set: val !== '',
      };
    });

    const rawConfig = readSecretsJson(agentPath(folder, 'config', 'ext', 'service', 'config.json'));
    const config = Object.entries(declaredConfig).map(([key, decl]) => {
      const stored = rawConfig[key];
      const set = stored != null && (typeof stored === 'string' || typeof stored === 'number' || typeof stored === 'boolean');
      return {
        key,
        label: decl.label,
        type: decl.type,
        value: set ? (stored as string | number | boolean) : decl.default ?? emptyFor(decl.type),
        set,
      };
    });

    return ServiceAdminResponseSchema.parse({ present, status, declared: true, admin, secrets, config });
  }),

  setConfig: adminProcedure
    .input(
      z.object({
        alias: z.string(),
        secrets: z.record(z.string(), z.string()).optional(),
        config: z.record(z.string(), SettingValue).optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const folder = aliasToFolder(ctx.deps, input.alias);
      const manifest = readServiceManifest(folder);
      const declaredSecrets = manifest?.secrets ?? {};
      const declaredConfig = manifest?.config ?? {};
      const serviceConfigDir = agentPath(folder, 'config', 'ext', 'service');

      // Validate both payloads fully before writing either file — a rejected
      // save must leave no partial state behind.
      const undeclaredSecrets = Object.keys(input.secrets ?? {}).filter((key) => !(key in declaredSecrets));
      if (undeclaredSecrets.length > 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Undeclared secret key(s): ${undeclaredSecrets.join(', ')} — declare them in blueprint/service/manifest.json first`,
        });
      }
      const coercedConfig: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries(input.config ?? {})) {
        const decl = declaredConfig[key];
        if (!decl) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Undeclared setting key(s): ${key} — declare them in blueprint/service/manifest.json first`,
          });
        }
        const coerced = coerceSetting(decl.type, value);
        if (coerced === null) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: `Setting "${key}" expects a ${decl.type}` });
        }
        coercedConfig[key] = coerced;
      }

      fs.mkdirSync(serviceConfigDir, { recursive: true });

      // Secrets: read-merge-write — blank means keep the stored value (the
      // form ships empty strings for untouched secret fields), and keys
      // outside the declared set (hand-added) are preserved untouched.
      if (input.secrets) {
        const secretsPath = agentPath(folder, 'config', 'ext', 'service', 'secrets.json');
        const merged: Record<string, unknown> = { ...readSecretsJson(secretsPath) };
        for (const [key, value] of Object.entries(input.secrets)) {
          if (value === '') continue;
          merged[key] = value;
        }
        writeSecretsJson(secretsPath, merged);
      }

      // Settings: values are visible in the form, so submitted values are
      // written verbatim (no blank-keeps); hand-added keys are preserved.
      if (input.config) {
        const configPath = agentPath(folder, 'config', 'ext', 'service', 'config.json');
        const merged: Record<string, unknown> = { ...readSecretsJson(configPath), ...coercedConfig };
        writeSecretsJson(configPath, merged);
      }

      return { ok: true };
    }),

  /**
   * Authorize the browser for the service-rendered admin page (manifest
   * `admin: true`): the response sets a path-scoped, httpOnly cookie session
   * (see service-page-access.ts), so the returned URL opens directly — no
   * credential ever rides a URL.
   */
  adminPageUrl: adminProcedure.input(aliasInput).mutation(({ ctx, input }) => {
    const folder = aliasToFolder(ctx.deps, input.alias);
    if (!readServiceManifest(folder)?.admin) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'This agent\'s service declares no admin page' });
    }
    ctx.res.cookie(SESSION_COOKIE, createSession(folder), {
      path: `/agents/${folder}/admin`,
      httpOnly: true,
      sameSite: 'lax',
    });
    return { url: `/agents/${encodeURIComponent(folder)}/admin/` };
  }),
});
