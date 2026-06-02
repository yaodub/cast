/**
 * Extension Framework — server-side registry, config merge, and per-agent activation.
 *
 * Types and utilities come from @getcast/extension-schema (portable).
 * This module provides the server-specific glue: registration, config merge
 * (locked-by-default), per-agent activation, and server lifecycle hooks.
 *
 * Lifecycle:
 *   Server start  → startExtensions() calls def.onServerStart(log)
 *   Agent load    → activateExtensionsForAgent() calls def.create(ctx)
 *   Tool call     → instance.handle() with per-conversation ToolCallContext
 *   Server stop   → stopExtensions() calls def.onServerStop(log)
 */
import fs from 'fs';

import { z } from 'zod';

import { agentPath, readCapabilities } from '../config.js';
import { readJson, readParsed, readText } from '../lib/config-reader.js';
import { logger } from '../logger.js';

// Re-export types from @getcast/extension-schema for server-internal consumers.
// Extensions import from @getcast/extension-schema directly.
export type {
  ToolParamSchema,
  ToolDefinition,
  ToolCallContext,
  ToolResult,
  ExtensionInstance,
  ExtensionContext,
  ExtensionDefinition,
  Logger,
} from '@getcast/extension-schema';
export { textResult, noopLogger } from '@getcast/extension-schema';

import type { ExtensionContext, ExtensionDefinition, ExtensionInstance } from '@getcast/extension-schema';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry = new Map<string, ExtensionDefinition<any, any, any>>();

/** Register an extension definition. Called explicitly at startup. */
export function registerExtension<TConfig, TSecrets, TInstance extends ExtensionInstance>(
  def: ExtensionDefinition<TConfig, TSecrets, TInstance>,
): void {
  if (registry.has(def.name)) {
    throw new Error(`Extension "${def.name}" is already registered`);
  }
  registry.set(def.name, def);
}

/** Get all registered extension definitions. */
export function getRegisteredExtensions(): ReadonlyMap<string, ExtensionDefinition<unknown, unknown, ExtensionInstance>> {
  return registry;
}

// ---------------------------------------------------------------------------
// Config merge (locked-by-default)
// ---------------------------------------------------------------------------

interface UnlockedValue {
  unlocked: true;
  value: unknown;
}

function isUnlockedValue(v: unknown): v is UnlockedValue {
  return (
    typeof v === 'object' &&
    v !== null &&
    'unlocked' in v &&
    (v as Record<string, unknown>).unlocked === true &&
    'value' in v
  );
}

/**
 * Merge author config (from capabilities.json) with operator overrides (from ext/{name}/config.json).
 *
 * Rules:
 *   - Bare values in author config are locked (author wins, operator cannot override).
 *   - `{ unlocked: true, value: ... }` in author config allows operator override.
 *   - Operator can only override keys the author declared.
 *   - `enabled` and `channel` are always stripped (framework concerns, not config).
 *
 * Drift signals (operator overrides a locked key, operator declares a key the
 * author didn't) route through `options.onWarning` if provided; otherwise they
 * hit the server log. Validation passes a collector so the report can surface
 * them instead of dropping them into stdout.
 */
export function mergeExtensionConfig(
  authorConfig: Record<string, unknown>,
  operatorConfig: Record<string, unknown>,
  options?: { onWarning?: (key: string, reason: 'locked' | 'undeclared') => void },
): Record<string, unknown> {
  const warn = options?.onWarning
    ?? ((key, reason) => {
      const msg = reason === 'locked'
        ? 'Operator tried to override locked extension config key — author value used'
        : 'Operator extension config key not declared by author — ignored';
      logger.warn({ key }, msg);
    });

  const merged: Record<string, unknown> = {};

  for (const [key, authorVal] of Object.entries(authorConfig)) {
    if (key === 'enabled' || key === 'channel') continue; // Framework concerns, not config

    if (isUnlockedValue(authorVal)) {
      // Unlocked — operator wins if they provided a value
      if (key in operatorConfig) {
        merged[key] = operatorConfig[key];
      } else {
        merged[key] = authorVal.value;
      }
    } else {
      // Locked (bare value) — author wins
      if (key in operatorConfig) warn(key, 'locked');
      merged[key] = authorVal;
    }
  }

  for (const key of Object.keys(operatorConfig)) {
    if (!(key in authorConfig)) warn(key, 'undeclared');
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Per-agent activation
// ---------------------------------------------------------------------------


/**
 * Read operator config overrides for an extension. Returns an empty object if
 * the file is missing or malformed. Values are `unknown` because the shape is
 * structurally unknowable here — each extension's configSchema validates the
 * merged result downstream in `mergeExtensionConfig`.
 */
const OperatorConfigSchema = z.record(z.string(), z.unknown());
function readOperatorConfig(
  agentFolder: string,
  extName: string,
): Record<string, unknown> {
  return readParsed(agentPath(agentFolder, 'config', 'ext', extName, 'config.json'), OperatorConfigSchema, {});
}

/**
 * Read secrets from config/ext/{name}/secrets.json and parse through the extension's secretsSchema.
 * Returns parsed result or an error string on failure.
 */
function readSecrets<TSecrets>(
  agentFolder: string,
  extName: string,
  schema: z.ZodType<TSecrets>,
): { data: TSecrets } | { error: string } {
  const raw = readJson(agentPath(agentFolder, 'config', 'ext', extName, 'secrets.json')) ?? {};

  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join(', ');
    return { error: `secrets validation failed: ${issues}` };
  }
  return { data: result.data };
}

/**
 * Activate a single extension: merge config, validate, instantiate, start.
 * Returns the instance or null on failure (logged).
 */
function activateSingleExtension(
  agentFolder: string,
  extName: string,
  authorConfig: Record<string, unknown>,
  makeDeliver?: (extName: string, channel?: string) => ExtensionContext['deliver'],
): ExtensionInstance | null {
  const extChannel = typeof authorConfig.channel === 'string'
    ? authorConfig.channel
    : undefined;

  const def = registry.get(extName);
  if (!def) {
    logger.warn({ agentFolder, extension: extName }, 'Unknown extension — skipped');
    return null;
  }

  const operatorConfig = readOperatorConfig(agentFolder, extName);
  const mergedConfig = mergeExtensionConfig(authorConfig, operatorConfig);

  const configResult = def.configSchema.safeParse(mergedConfig);
  if (!configResult.success) {
    const issues = configResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    logger.warn({ agentFolder, extension: extName, issues }, 'Extension config validation failed — skipped');
    return null;
  }

  const secretsResult = readSecrets(agentFolder, extName, def.secretsSchema);
  if ('error' in secretsResult) {
    logger.warn({ agentFolder, extension: extName, error: secretsResult.error }, 'Extension secrets validation failed — skipped');
    return null;
  }

  const privateDir = agentPath(agentFolder, 'ext', extName);
  const sharedDir = agentPath(agentFolder, 'shared', 'ext', extName);
  fs.mkdirSync(privateDir, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });

  if (!extChannel) {
    logger.info({ agentFolder, extension: extName }, 'Extension has no channel configured — subscription features unavailable');
  }

  try {
    const instance: ExtensionInstance = def.create({
      agentFolder,
      config: configResult.data,
      secrets: secretsResult.data,
      privateDir,
      sharedDir,
      hasChannel: !!extChannel,
      deliver: makeDeliver?.(extName, extChannel) ?? (() => Promise.resolve({ ok: true, result: null })),
      log: logger.child({ extension: extName }),
    });

    if (instance.tools.length > 0) {
      logger.info({ agentFolder, extension: extName, tools: instance.tools.map((t) => t.name) }, 'Extension activated');
      if (instance.onAgentStart) {
        instance.onAgentStart().catch((err) => {
          logger.warn({ agentFolder, extension: instance.name, err }, 'Extension onAgentStart failed');
        });
      }
      return instance;
    }
    logger.info({ agentFolder, extension: extName }, 'Extension has no tools — skipped');
    return null;
  } catch (err) {
    logger.warn({ agentFolder, extension: extName, err }, 'Extension create() threw — skipped');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Per-agent extension manager (activation + hot-reload)
// ---------------------------------------------------------------------------

/**
 * Per-agent extension lifecycle manager.
 *
 * Owns the active extension instances. Provides activate() for initial load
 * and onConfigChanged() for watcher-driven hot-reload.
 * AgentManager holds one of these — all extension file-layout knowledge stays here.
 */
export class AgentExtensions {
  private _instances: readonly ExtensionInstance[] = [];

  constructor(
    private agentFolder: string,
    private makeDeliver?: (extName: string, channel?: string) => ExtensionContext['deliver'],
  ) {}

  /** Current active instances. Returns an immutable snapshot — safe to hold across ticks. */
  get instances(): readonly ExtensionInstance[] { return this._instances; }

  /** Initial activation — load all enabled extensions. */
  activate(): void {
    const results: ExtensionInstance[] = [];
    const authorExtensions = readCapabilities(this.agentFolder).extensions;
    for (const [extName, authorConfig] of Object.entries(authorExtensions)) {
      if (!authorConfig.enabled) continue;
      const instance = activateSingleExtension(this.agentFolder, extName, authorConfig, this.makeDeliver);
      if (instance) results.push(instance);
    }
    this._instances = results;
  }

  /**
   * React to a file change under ext/. Called by AgentManager's watcher subscription.
   *
   * - capabilities.json changed → full reload (extensions added/removed)
   * - config/ext/{name}/config.json or secrets.json changed → reload that single extension
   */
  onConfigChanged(filePath: string): void {
    if (filePath.endsWith('capabilities.json')) {
      // Guard against wiping active extensions on a mid-edit parse failure.
      // readCapabilities silently returns EMPTY_CAPS on invalid JSON/schema,
      // which would stopAll() and activate nothing.
      const raw = readText(filePath);
      if (raw !== null && raw.trim().length > 0) {
        try {
          JSON.parse(raw);
        } catch {
          logger.warn(
            { agentFolder: this.agentFolder, filePath },
            'capabilities.json changed but failed to parse — skipping reload to preserve active extensions',
          );
          return;
        }
      }
      logger.info({ agentFolder: this.agentFolder }, 'capabilities.json changed — reloading all extensions');
      this.stopAll();
      this.activate();
      return;
    }

    // Extract extension name from path: .../config/ext/{name}/{config,secrets}.json
    const extConfigDir = agentPath(this.agentFolder, 'config', 'ext');
    if (!filePath.startsWith(extConfigDir)) return;
    const relative = filePath.slice(extConfigDir.length + 1); // strip extConfigDir + separator
    const extName = relative.split('/')[0];
    if (!extName) return;

    const basename = relative.split('/').pop();
    if (basename !== 'config.json' && basename !== 'secrets.json') return;

    const existing = this._instances.find((e) => e.name === extName);
    const caps = readCapabilities(this.agentFolder);
    const authorConfig = caps.extensions[extName];

    logger.info(
      { agentFolder: this.agentFolder, extension: extName, file: basename },
      'Extension config changed — reloading',
    );

    if (existing) {
      this.stopOne(existing);
    }

    if (!authorConfig?.enabled) {
      // Extension disabled or removed — just remove from instances
      if (existing) {
        this._instances = this._instances.filter((e) => e.name !== extName);
        logger.info({ agentFolder: this.agentFolder, extension: extName }, 'Extension disabled — removed');
      }
      return;
    }

    const newInstance = activateSingleExtension(this.agentFolder, extName, authorConfig, this.makeDeliver);
    if (existing) {
      // Replace in-place, preserving order
      this._instances = this._instances.map((e) => e.name === extName ? newInstance! : e).filter(Boolean) as ExtensionInstance[];
    }
    if (newInstance && !existing) {
      this._instances = [...this._instances, newInstance];
    }
  }

  /** Stop all extension instances. */
  stopAll(): void {
    for (const ext of this._instances) this.stopOne(ext);
  }

  private stopOne(ext: ExtensionInstance): void {
    try { ext.onAgentStop?.(); } catch (err) {
      logger.warn({ agentFolder: this.agentFolder, extension: ext.name, err }, 'Extension onAgentStop failed');
    }
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

/**
 * Call onServerStart() for all registered extension definitions. Called once at
 * server startup. Returns the name + first-line reason for every extension
 * whose onServerStart rejected, so the caller can surface them loudly in the
 * boot banner. A rejection is logged and recorded but never aborts startup —
 * one extension failing must not take down the server.
 */
export async function startExtensions(): Promise<Array<{ name: string; reason: string }>> {
  const failed: Array<{ name: string; reason: string }> = [];
  for (const [name, def] of registry) {
    if (def.onServerStart) {
      try {
        await def.onServerStart(logger.child({ extension: name }));
        logger.info({ extension: name }, 'Extension started');
      } catch (err) {
        const reason = (err instanceof Error ? err.message : String(err)).split('\n')[0]!;
        failed.push({ name, reason });
        logger.error(
          { extension: name, err },
          'Extension onServerStart failed',
        );
      }
    }
  }
  return failed;
}

/** Call onServerStop() for all registered extension definitions. Called once at server shutdown. */
export async function stopExtensions(): Promise<void> {
  for (const [name, def] of registry) {
    if (def.onServerStop) {
      try {
        await def.onServerStop(logger.child({ extension: name }));
      } catch (err) {
        logger.error({ extension: name, err }, 'Extension onServerStop failed');
      }
    }
  }
}
