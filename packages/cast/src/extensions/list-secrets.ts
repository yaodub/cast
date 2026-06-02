/**
 * `listExtensionSecrets` — redacted view of extension secrets for the Configure
 * console. Returns `{ extension, key, isSet }[]` — key names only, never values.
 *
 * Consumed by `configure__list_extension_secrets`. Host-side only (agent
 * containers never see secret values; Configure has no `ext/` mount).
 */
import { z } from 'zod';

import { agentPath } from '../config.js';
import { readJson } from '../lib/config-reader.js';
import { logger } from '../logger.js';

import { getRegisteredExtensions } from './registry.js';
import type { ExtensionSecretStatus } from '../console/strategy.js';

/**
 * Extract the top-level key names from a Zod schema if it's a ZodObject.
 * Non-object schemas (or schemas we can't introspect) contribute zero keys.
 */
function extractKeyNames(schema: z.ZodType<unknown>): string[] {
  if (schema instanceof z.ZodObject) {
    return Object.keys(schema.shape);
  }
  return [];
}

/**
 * List all extension secrets for an agent. For each registered extension with a
 * non-empty `secretsSchema`, returns one entry per declared key with an
 * `isSet` flag indicating whether the key is present in `config/ext/<name>/secrets.json`.
 *
 * Never returns secret values. Never throws — read errors are logged and the
 * offending extension contributes zero entries.
 */
export function listExtensionSecrets(agentFolder: string): ExtensionSecretStatus[] {
  const results: ExtensionSecretStatus[] = [];
  const extensions = getRegisteredExtensions();

  for (const [extName, def] of extensions) {
    let keys: string[];
    try {
      keys = extractKeyNames(def.secretsSchema as z.ZodType<unknown>);
    } catch (err) {
      logger.warn({ extension: extName, err }, 'Failed to introspect extension secretsSchema');
      continue;
    }
    if (keys.length === 0) continue;

    const secretsPath = agentPath(agentFolder, 'config', 'ext', extName, 'secrets.json');
    const raw = readJson(secretsPath);
    const parsed: Record<string, unknown> =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};

    for (const key of keys) {
      const value = parsed[key];
      const isSet = value !== undefined && value !== null && value !== '';
      results.push({ extension: extName, key, isSet });
    }
  }

  return results;
}
