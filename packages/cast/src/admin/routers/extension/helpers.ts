/**
 * Shared helpers for extension admin routers.
 *
 * Config reading (with lock metadata), config writing (respects locks),
 * secret masking, and the generic connect procedure.
 */
import fs from 'fs';
import { z } from 'zod';

import { agentPath, readCapabilities } from '../../../config.js';
import { readParsed } from '../../../lib/config-reader.js';
import { readSecretsJson } from '../../../lib/secrets-file.js';
import { getRegisteredExtensions } from '../../../extensions/registry.js';
import { type LockableField } from '../../lib/field-schema.js';
import { aliasToFolder, adminProcedure, router } from '../../trpc.js';

export { aliasToFolder, maskSecret } from '../../trpc.js';
export { LockableFieldSchema, SecretFieldSchema, type LockableField, type SecretField } from '../../lib/field-schema.js';

/**
 * Extension config override file shape — heterogeneous per extension.
 * Each extension's runtime merges this against its own `configSchema`; at this
 * layer we guarantee only that it's a JSON object. Values are `unknown` because
 * the shape is structurally unknowable without knowing which extension owns it.
 */
const ExtensionOverrideSchema = z.record(z.string(), z.unknown());

// ---------------------------------------------------------------------------
// Config read / write
// ---------------------------------------------------------------------------

/**
 * Read extension config with lock metadata.
 *
 * Reads author config from capabilities.json (locked-by-default) and operator
 * overrides from config/ext/{name}/config.json. Returns per-field value + locked flag.
 *
 * Fields declared by the extension's zod configSchema but not mentioned in
 * capabilities.json are returned as locked at the schema default — the runtime
 * silently ignores operator overrides for those keys (see mergeExtensionConfig),
 * so the admin UI must reflect that they aren't operator-editable.
 */
export function readExtensionConfig(
  folder: string,
  extName: string,
): Record<string, LockableField<unknown>> {
  const authorConfig = readCapabilities(folder).extensions[extName] ?? {};

  const overridePath = agentPath(folder, 'config', 'ext', extName, 'config.json');
  const overrides = readParsed(overridePath, ExtensionOverrideSchema, {});

  const fields: Record<string, LockableField<unknown>> = {};
  for (const [key, raw] of Object.entries(authorConfig)) {
    if (key === 'enabled' || key === 'channel') continue;
    if (raw && typeof raw === 'object' && 'unlocked' in raw && 'value' in raw) {
      fields[key] = { value: overrides[key] ?? (raw as { value: unknown }).value, locked: false };
    } else {
      fields[key] = { value: raw, locked: true };
    }
  }

  const def = getRegisteredExtensions().get(extName);
  if (def) {
    const parsed = def.configSchema.safeParse({});
    if (parsed.success) {
      for (const [key, value] of Object.entries(parsed.data as Record<string, unknown>)) {
        if (!(key in fields)) fields[key] = { value, locked: true };
      }
    }
  }

  return fields;
}

/**
 * Write operator config overrides for an extension. Persists only the unlocked
 * subset of `updates` to the override file; locked keys are dropped.
 *
 * Locked keys are the blueprint author's domain: the runtime merge
 * (`mergeExtensionConfig`) always resolves a locked field to the author value
 * regardless of the override file, so persisting one here is dead weight.
 * Dropping rather than rejecting is also what keeps callers honest — a
 * partial-update input schema with `.default()` fields re-materializes omitted
 * locked keys (a blueprint-locked section the form deliberately didn't send),
 * so a locked key routinely lands in `updates` even when the operator changed
 * nothing. Rejecting on its mere presence turned every such save into a spurious
 * "field is locked" error. This is the single chokepoint for the override file,
 * so enforcing "unlocked-only" here makes the invariant hold for every extension
 * without per-router vigilance.
 */
export function writeExtensionConfig(
  folder: string,
  extName: string,
  updates: Record<string, unknown>,
): void {
  const fields = readExtensionConfig(folder, extName);
  const overridePath = agentPath(folder, 'config', 'ext', extName, 'config.json');
  const existing = readParsed(overridePath, ExtensionOverrideSchema, {});
  for (const [key, value] of Object.entries(updates)) {
    if (fields[key]?.locked) continue;
    existing[key] = value;
  }
  fs.mkdirSync(agentPath(folder, 'config', 'ext', extName), { recursive: true });
  fs.writeFileSync(overridePath, JSON.stringify(existing, null, 2));
}


// ---------------------------------------------------------------------------
// Generic connect procedure
// ---------------------------------------------------------------------------

export const sharedRouter = router({
  /**
   * List extensions enabled for an agent (from capabilities.json), each
   * tagged with whether the server knows the extension. Unknown entries
   * (typos, stale references, or extensions that haven't been installed
   * on this server) still surface so the UI can flag them — silent
   * omission would hide broken config from the operator.
   */
  listEnabled: adminProcedure
    .input(z.object({ alias: z.string() }))
    .query(({ ctx, input }) => {
      const folder = aliasToFolder(ctx.deps, input.alias);
      const registered = getRegisteredExtensions();
      return Object.entries(readCapabilities(folder).extensions)
        .filter(([, cfg]) => cfg.enabled)
        .map(([name]) => ({ name, registered: registered.has(name) }));
    }),

  /**
   * Generic connect — parses the agent's secrets via the extension's schema
   * and hands a typed `{ secrets, privateDir }` context to the extension's
   * connect hook. Storage format (secrets.json) is a server-side concern;
   * the extension never reads the secrets file directly. `privateDir` is the
   * extension's per-agent runtime dir (`<agent>/ext/<name>/`) — extensions
   * use it only to inspect runtime artifacts, not credentials.
   *
   * `secretOverrides` carries unsaved form values so the test reflects what the
   * operator is editing, not just what's on disk. Blank overrides keep the saved
   * value (the same "blank means keep existing" rule the save form follows).
   */
  connect: adminProcedure
    .input(z.object({
      alias: z.string(),
      extension: z.string(),
      secretOverrides: z.record(z.string(), z.string()).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const def = getRegisteredExtensions().get(input.extension);
      if (!def?.connect) return { ok: true, message: 'No connection test available', state: null };
      const folder = aliasToFolder(ctx.deps, input.alias);
      const secretsPath = agentPath(folder, 'config', 'ext', input.extension, 'secrets.json');
      const raw = readSecretsJson(secretsPath);
      for (const [key, value] of Object.entries(input.secretOverrides ?? {})) {
        if (value !== '') raw[key] = value;
      }
      const parsed = def.secretsSchema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
        return { ok: false, message: `Invalid credentials: ${issues}`, state: null };
      }
      const privateDir = agentPath(folder, 'ext', input.extension);
      return def.connect({ secrets: parsed.data, privateDir });
    }),
});
