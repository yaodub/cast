/**
 * Shared agent blueprint validator. Consumed by `design__validate` and
 * `configure__validate` so a single body of checks covers every per-agent file
 * the runtime parses, plus the cross-file invariants the runtime relies on.
 *
 * Runtime parity is the contract: every problem reported here corresponds to
 * a failure or silent fallback that would happen on next agent activation. The
 * schemas used here are the same schemas the runtime uses — strict where the
 * shape is fully owned by Cast (manifest stays passthrough for provenance),
 * inner extension blobs validated via the registered extension's own
 * `configSchema` because each extension owns its blob shape.
 *
 * Severity:
 *   - `problems` — will fail at runtime or ship a silently degraded agent
 *   - `warnings` — suspicious, runtime tolerates (unknown keys, optional slots
 *     unset, orphan provisions)
 *   - `passes`   — informational, one line per check that ran cleanly
 */
import fs from 'fs';
import path from 'path';

import { z } from 'zod';

import {
  AgentConfigSchema,
  AgentManifestSchema,
  CapabilitiesSchema,
  McpServerSecretsSchema,
  ProvisionsSchema,
  isUnlocked,
  type Capabilities,
  type McpServerSecrets,
  type Provisions,
} from '@getcast/agent-schema/v1';

import { AclSchema } from '../../auth/acl.js';
import { agentPath } from '../../config.js';
import { ChannelJsonSchema } from '../../conversations/types.js';
import { CHANNEL_NAME_RE } from '../../conversations/parse-channel.js';
import { getRegisteredExtensions, mergeExtensionConfig } from '../../extensions/registry.js';

export interface ValidationIssue {
  file: string;
  message: string;
}

export interface ValidationReport {
  problems: ValidationIssue[];
  warnings: ValidationIssue[];
  passes: string[];
}

interface Acc {
  problems: ValidationIssue[];
  warnings: ValidationIssue[];
  passes: string[];
}

export function validateAgentBlueprint(folder: string): ValidationReport {
  const acc: Acc = { problems: [], warnings: [], passes: [] };

  checkManifest(folder, acc);
  checkIdentityFiles(folder, acc);
  const channels = checkChannels(folder, acc);
  const caps = checkCapabilities(folder, acc);
  checkAgentConfig(folder, channels, acc);
  checkAclConfig(folder, acc);
  checkProvisions(folder, caps, acc);
  if (caps) checkExtensions(folder, caps, channels, acc);
  const mcpSecrets = checkMcpSecretsFile(folder, acc);
  if (caps) checkMcpServers(caps, mcpSecrets, acc);

  return acc;
}

// ---------------------------------------------------------------------------
// Per-file checks
// ---------------------------------------------------------------------------

function checkManifest(folder: string, acc: Acc): void {
  const file = 'manifest.json';
  const p = agentPath(folder, 'manifest.json');
  if (!fs.existsSync(p)) {
    acc.problems.push({ file, message: 'missing' });
    return;
  }
  try {
    const parsed = AgentManifestSchema.parse(JSON.parse(fs.readFileSync(p, 'utf-8')));
    acc.passes.push(`${file} — schema ok (name=${parsed.name})`);
  } catch (err) {
    acc.problems.push({ file, message: prettify(err) });
  }
}

function checkIdentityFiles(folder: string, acc: Acc): void {
  for (const fname of ['whoami.md', 'prompt.md']) {
    const file = `blueprint/identity/${fname}`;
    const p = agentPath(folder, 'blueprint', 'identity', fname);
    if (!fs.existsSync(p)) {
      acc.problems.push({ file, message: 'missing' });
      continue;
    }
    if (fs.readFileSync(p, 'utf-8').trim().length === 0) {
      acc.problems.push({ file, message: 'empty (runtime skips empty identity files)' });
      continue;
    }
    acc.passes.push(`${file} — ok`);
  }
}

/**
 * Walk `blueprint/channels/`. Returns the set of channels that parsed cleanly
 * — used downstream for cross-ref checks (`modelOverrides[].channel`,
 * `extensions[*].channel`). Always includes `default` since the runtime
 * guarantees that channel exists even when no directory is present.
 */
function checkChannels(folder: string, acc: Acc): Set<string> {
  const channels = new Set<string>(['default']);
  const channelsDir = agentPath(folder, 'blueprint', 'channels');
  if (!fs.existsSync(channelsDir)) return channels;

  for (const entry of fs.readdirSync(channelsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const file = `blueprint/channels/${entry.name}/channel.json`;
    if (!CHANNEL_NAME_RE.test(entry.name)) {
      acc.problems.push({
        file: `blueprint/channels/${entry.name}/`,
        message: `invalid channel name (must match ${CHANNEL_NAME_RE})`,
      });
      continue;
    }
    const jsonPath = path.join(channelsDir, entry.name, 'channel.json');
    if (!fs.existsSync(jsonPath)) {
      acc.problems.push({ file, message: 'missing channel.json' });
      continue;
    }
    try {
      ChannelJsonSchema.parse(JSON.parse(fs.readFileSync(jsonPath, 'utf-8')));
      channels.add(entry.name);
      acc.passes.push(`${file} — ok`);
    } catch (err) {
      acc.problems.push({ file, message: prettify(err) });
    }
  }
  return channels;
}

function checkCapabilities(folder: string, acc: Acc): Capabilities | null {
  const file = 'blueprint/props/capabilities.json';
  const p = agentPath(folder, 'blueprint', 'props', 'capabilities.json');
  if (!fs.existsSync(p)) {
    acc.passes.push(`${file} — (none — no extensions)`);
    return null;
  }
  try {
    const parsed = CapabilitiesSchema.parse(JSON.parse(fs.readFileSync(p, 'utf-8')));
    const e = Object.keys(parsed.extensions).length;
    const m = Object.keys(parsed.mcp_servers).length;
    acc.passes.push(`${file} — schema ok (${e} extension${plural(e)}, ${m} mcp server${plural(m)})`);
    return parsed;
  } catch (err) {
    acc.problems.push({ file, message: prettify(err) });
    return null;
  }
}

function checkAgentConfig(folder: string, channels: Set<string>, acc: Acc): void {
  const file = 'config/agent.json';
  const p = agentPath(folder, 'config', 'agent.json');
  if (!fs.existsSync(p)) {
    acc.passes.push(`${file} — (none)`);
    return;
  }
  let parsed;
  try {
    parsed = AgentConfigSchema.parse(JSON.parse(fs.readFileSync(p, 'utf-8')));
  } catch (err) {
    acc.problems.push({ file, message: prettify(err) });
    return;
  }
  acc.passes.push(`${file} — schema ok`);

  for (const [i, entry] of (parsed.modelOverrides ?? []).entries()) {
    if (!channels.has(entry.channel)) {
      acc.problems.push({
        file,
        message: `modelOverrides[${i}].channel "${entry.channel}" does not exist in blueprint/channels/ — runtime silently drops this override`,
      });
    }
  }
}

function checkAclConfig(folder: string, acc: Acc): void {
  const file = 'config/acl.json';
  const p = agentPath(folder, 'config', 'acl.json');
  if (!fs.existsSync(p)) {
    acc.passes.push(`${file} — (none)`);
    return;
  }
  try {
    AclSchema.parse(JSON.parse(fs.readFileSync(p, 'utf-8')));
    acc.passes.push(`${file} — schema ok`);
  } catch (err) {
    acc.problems.push({ file, message: prettify(err) });
  }
}

function checkProvisions(folder: string, caps: Capabilities | null, acc: Acc): void {
  const file = 'config/provisions.json';
  const p = agentPath(folder, 'config', 'provisions.json');
  let parsed: Provisions | null = null;
  if (fs.existsSync(p)) {
    try {
      parsed = ProvisionsSchema.parse(JSON.parse(fs.readFileSync(p, 'utf-8')));
      acc.passes.push(`${file} — schema ok`);
    } catch (err) {
      acc.problems.push({ file, message: prettify(err) });
      return;
    }
  }

  if (!caps) return;

  const provResources = parsed?.resources ?? {};

  // Required resource slots have provisions
  for (const [name, slot] of Object.entries(caps.resources)) {
    if (!slot.required) continue;
    const prov = provResources[name];
    const hasPath = typeof prov === 'string' ? prov.length > 0 : !!prov?.path;
    if (!hasPath) {
      acc.problems.push({
        file,
        message: `required resource slot "${name}" not provisioned (declared in capabilities.json with required=true)`,
      });
    }
  }

  // Orphan provisions
  for (const name of Object.keys(provResources)) {
    if (!(name in caps.resources)) {
      acc.warnings.push({ file, message: `resource "${name}" provisioned but not declared in capabilities.json` });
    }
  }

  // Resource access escalation
  for (const [name, prov] of Object.entries(provResources)) {
    const slot = caps.resources[name];
    if (!slot) continue;
    const provAccess = typeof prov === 'string' ? undefined : prov.access;
    if (provAccess === 'rw' && slot.access === 'ro') {
      acc.problems.push({ file, message: `resource "${name}" access escalated (slot is ro, provision is rw)` });
    }
  }

  // pip.extra_packages requires unlock + no wildcards
  if (parsed?.pip?.extra_packages.length) {
    if (!caps.pip || !isUnlocked(caps.pip.extra_packages)) {
      acc.problems.push({ file, message: 'pip.extra_packages provided but capabilities does not unlock it' });
    }
    for (const pkg of parsed.pip.extra_packages) {
      if (pkg.includes('*')) {
        acc.problems.push({ file, message: `pip extra_packages "${pkg}" contains wildcard — must be exact package name` });
      }
    }
  }

  // additional_disabled_tools requires unlock
  if (parsed && parsed.additional_disabled_tools.length > 0) {
    if (!isUnlocked(caps.additional_disabled_tools)) {
      acc.problems.push({ file, message: 'additional_disabled_tools provided but capabilities does not unlock it' });
    }
  }
}

/**
 * For every extension declared in capabilities.json:
 *   - registered on this server (problem if not)
 *   - merged author+operator config passes the extension's `configSchema` (problem)
 *   - merge drift (locked-key override, undeclared operator key) → warning
 *   - strict-reparse of the merged blob → unknown-key warnings (LLM typo signal)
 *   - secrets.json passes `secretsSchema` when extension is enabled (problem)
 *   - `channel` reference points at a real channel (warning)
 */
function checkExtensions(
  folder: string,
  caps: Capabilities,
  channels: Set<string>,
  acc: Acc,
): void {
  const registered = getRegisteredExtensions();
  const knownList = Array.from(registered.keys()).sort().join(', ') || '(none)';

  for (const [name, authorCfg] of Object.entries(caps.extensions)) {
    const capsField = `blueprint/props/capabilities.json: extensions.${name}`;

    const def = registered.get(name);
    if (!def) {
      acc.problems.push({ file: capsField, message: `extension not registered on this server (known: ${knownList})` });
      continue;
    }

    // Channel reference (warning — runtime tolerates by disabling subscription features)
    const ch = (authorCfg as Record<string, unknown>).channel;
    if (typeof ch === 'string' && !channels.has(ch)) {
      acc.warnings.push({
        file: capsField,
        message: `channel "${ch}" does not exist in blueprint/channels/ — extension subscription features will be unavailable`,
      });
    }

    // Merge author + operator override, capturing drift warnings
    const overrideFile = `config/ext/${name}/config.json`;
    const operatorCfg = readOperatorOverride(agentPath(folder, 'config', 'ext', name, 'config.json'));
    const merged = mergeExtensionConfig(
      authorCfg as Record<string, unknown>,
      operatorCfg,
      {
        onWarning: (key, reason) => {
          acc.warnings.push({
            file: overrideFile,
            message: reason === 'locked'
              ? `key "${key}" override ignored — author config has it locked`
              : `key "${key}" not declared in capabilities.json — ignored`,
          });
        },
      },
    );

    // Schema parse — this is the runtime gate; failures here mean the
    // extension would silently skip activation. (The web-fetch `fetch_mode:
    // 'banana'` case lands here.)
    const result = def.configSchema.safeParse(merged);
    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      acc.problems.push({ file: capsField, message: `config invalid: ${issues}` });
    } else {
      acc.passes.push(`${capsField} — config ok`);
      // Strict re-parse — surfaces unknown keys the default-strip parse silently drops
      for (const unknownKey of unknownKeysAgainstStrictObject(def.configSchema, merged)) {
        acc.warnings.push({ file: capsField, message: `unknown config key "${unknownKey}"` });
      }
    }

    // Secrets — only inspected when extension is enabled
    if ((authorCfg as { enabled?: boolean }).enabled) {
      validateExtensionSecrets(folder, name, def.secretsSchema, acc);
    }
  }
}

function validateExtensionSecrets(
  folder: string,
  extName: string,
  schema: z.ZodType<unknown>,
  acc: Acc,
): void {
  const file = `config/ext/${extName}/secrets.json`;
  const p = agentPath(folder, 'config', 'ext', extName, 'secrets.json');

  // Not entered yet. If the schema requires fields, this is the normal
  // Design→Configure deferral — a warning (non-blocking), not a runtime-fatal
  // problem. If the schema requires nothing, an empty config is fine.
  if (!fs.existsSync(p)) {
    if (schemaRequiresAnyField(schema)) {
      acc.warnings.push({
        file,
        message: `extension enabled but secrets not entered yet — Configure's job; runtime skips activation until they're set`,
      });
    } else {
      acc.passes.push(`${file} — (none required)`);
    }
    return;
  }

  // Present — parse and schema-check. Failures here are runtime-fatal.
  let raw: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch (err) {
    acc.problems.push({ file, message: `invalid JSON: ${String(err)}` });
    return;
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    acc.problems.push({ file, message: `secrets invalid: ${issues}` });
    return;
  }

  acc.passes.push(`${file} — ok`);
}

function checkMcpSecretsFile(folder: string, acc: Acc): McpServerSecrets | null {
  const file = 'config/mcp-servers.json';
  const p = agentPath(folder, 'config', 'mcp-servers.json');
  if (!fs.existsSync(p)) {
    acc.passes.push(`${file} — (none)`);
    return {};
  }
  try {
    const parsed = McpServerSecretsSchema.parse(JSON.parse(fs.readFileSync(p, 'utf-8')));
    acc.passes.push(`${file} — schema ok`);
    return parsed;
  } catch (err) {
    acc.problems.push({ file, message: prettify(err) });
    return null;
  }
}

/**
 * For every declared MCP server: transport-specific required fields, plus
 * required-env-slot coverage against `config/mcp-servers.json`. Skipped when
 * the secrets file failed to parse (problem already reported elsewhere).
 */
function checkMcpServers(
  caps: Capabilities,
  secrets: McpServerSecrets | null,
  acc: Acc,
): void {
  if (!secrets || Object.keys(caps.mcp_servers).length === 0) return;

  for (const [name, decl] of Object.entries(caps.mcp_servers)) {
    const declField = `blueprint/props/capabilities.json: mcp_servers.${name}`;

    if (decl.transport === 'stdio' && !decl.command) {
      acc.problems.push({ file: declField, message: 'stdio transport requires "command"' });
    }
    if ((decl.transport === 'sse' || decl.transport === 'streamable-http') && !decl.url) {
      acc.problems.push({ file: declField, message: `${decl.transport} transport requires "url"` });
    }

    const provided = secrets[name] ?? {};
    for (const [envKey, slot] of Object.entries(decl.env)) {
      if (typeof slot === 'string') continue; // locked, hardcoded by vendor
      const value = provided[envKey];
      const hasValue = typeof value === 'string' && value.length > 0;
      const hasDefault = slot.value.length > 0;
      if (slot.required && !hasValue && !hasDefault) {
        acc.problems.push({
          file: `config/mcp-servers.json: ${name}.${envKey}`,
          message: `required env slot unprovisioned`,
        });
      } else if (!slot.required && !hasValue && !hasDefault) {
        acc.warnings.push({
          file: `config/mcp-servers.json: ${name}.${envKey}`,
          message: 'optional env slot unset and no default — server starts with this var empty',
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readOperatorOverride(p: string): Record<string, unknown> {
  if (!fs.existsSync(p)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch { /* fall through */ }
  return {};
}

/**
 * Reparse `value` against a strict clone of `schema` if it's a top-level
 * `z.ZodObject`. Returns the list of unrecognized top-level keys. Nested
 * objects keep their original mode — extension schemas would have to opt in
 * to deep strictness themselves.
 */
function unknownKeysAgainstStrictObject(schema: z.ZodType<unknown>, value: unknown): string[] {
  if (!(schema instanceof z.ZodObject)) return [];
  const r = schema.strict().safeParse(value);
  if (r.success) return [];
  const keys: string[] = [];
  for (const issue of r.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      const k = (issue as z.ZodIssue & { keys?: string[] }).keys;
      if (k) keys.push(...k);
    }
  }
  return keys;
}

/**
 * Heuristic: does this schema reject `{}` ? If yes, it has at least one
 * required field. Used to decide whether a missing secrets file is a problem
 * (required keys) vs. a no-op (extension declares no secrets).
 */
function schemaRequiresAnyField(schema: z.ZodType<unknown>): boolean {
  return !schema.safeParse({}).success;
}

function prettify(err: unknown): string {
  return err instanceof z.ZodError ? z.prettifyError(err) : String(err);
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

export function renderValidationReport(r: ValidationReport): string {
  const lines: string[] = [];

  if (r.problems.length === 0) {
    lines.push('Validation **passed** — no problems found.');
  } else {
    lines.push(`Validation **failed** — ${r.problems.length} problem${plural(r.problems.length)}:`);
    lines.push('');
    for (const p of r.problems) lines.push(`- ${p.file} — ${p.message}`);
  }

  if (r.warnings.length > 0) {
    lines.push('');
    lines.push(`${r.warnings.length} warning${plural(r.warnings.length)}:`);
    for (const w of r.warnings) lines.push(`- ${w.file} — ${w.message}`);
  }

  if (r.passes.length > 0) {
    lines.push('');
    lines.push(`Passed ${r.passes.length} check${plural(r.passes.length)}:`);
    for (const p of r.passes) lines.push(`- ${p}`);
  }

  return lines.join('\n');
}
