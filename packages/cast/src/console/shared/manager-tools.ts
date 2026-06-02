/**
 * Server-scope console escape-hatch tools.
 *
 * Three MCP tools shared across DM/CM/SM, gated on `ctx.consoleName`. Each
 * authorizes via the same `isReadable` predicate the walker uses — single
 * source of truth for what a console can touch.
 *
 *   manager__list        — paginated ls into a cross-agent directory.
 *   manager__read        — scoped cat with line range.
 *   manager__resurvey    — regenerate summaries + report what changed.
 *
 * Supporting plumbing lives in two siblings:
 *   - `manager-consoles.ts`     — classification + view-dir path; shared
 *                                  with `mounts.ts` and view-dir maintenance.
 *   - `view-dir-maintenance.ts` — startup populate / lifecycle / debounced
 *     refresh. `manager__resurvey` is conceptually a refresh exposed to the
 *     LLM, so it reuses `writeSurfaceIfChanged` from there directly.
 *
 * `resolveAgentToFolder` lives in this file because translating an
 * LLM-supplied identifier to an on-disk folder is part of the tool's
 * contract. Filesystem-scoped — walks `mnt/agents/` and consults
 * `manifest.json` rather than the bus resolver, because file operations
 * need the current on-disk folder, not the bus address.
 */
import fs from 'fs';
import path from 'path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { AGENTS_DIR, agentPath, listSubdirectories } from '../../config.js';
import { AgentDb, type EventLevel } from '../../agent/agent-db.js';
import { textResult } from '../../extensions/registry.js';
import type { ToolResult } from '../../extensions/registry.js';

import type { ConsoleMcpContext } from '../strategy.js';

import { isManagerConsole, readableSurfaces, viewDirForConsole } from './manager-consoles.js';
import { isReadable, type ManagerConsole } from './read-policy.js';
import { writeSurfaceIfChanged } from './view-dir-maintenance.js';

interface ResolveResult {
  folder?: string;
  error?: string;
}

/**
 * Resolve an LLM-supplied `agent` argument to the canonical on-disk folder.
 * Lives here because translating tool input to a folder path is part of the
 * tool's contract — single consumer is the three `register*Tool` functions
 * below. Exported so unit tests can exercise it directly.
 *
 * Security model: `args.agent` is **target identifier** (LLM legitimately
 * picks which agent to inspect — DM/CM/SM are designed to inspect any child
 * agent). Caller privilege is `consoleName` from ctx (fixed by runtime, not
 * LLM-supplied). `isReadable(consoleName, path)` enforces path policy
 * independently. The "never trust LLM-supplied identifiers" rule covers
 * caller identity, not target identity — picking what to inspect is a
 * legitimate part of the tool's job.
 *
 * Accepts three shapes — tried in order so folder-typed input is never
 * misclassified by a colliding alias:
 *   1. Exact folder name (filesystem-unique by construction).
 *   2. Alias match against `manifest.name` (mutable; collisions possible).
 *   3. Address `a:<pubkey>@<issuer>` match against `manifest.pubkey`.
 *
 * On alias/pubkey collision returns an error rather than picking arbitrarily —
 * the caller is expected to retry with the explicit folder name.
 */
export function resolveAgentToFolder(input: string): ResolveResult {
  const folders = listSubdirectories(AGENTS_DIR).filter((f) => !f.startsWith('.'));

  if (folders.includes(input)) return { folder: input };

  const isAddress = input.startsWith('a:');
  const pubkeyFromAddress = isAddress ? input.slice(2).split('@')[0] : null;

  const matches: string[] = [];
  for (const folder of folders) {
    let raw: { name?: string; pubkey?: string };
    try {
      raw = JSON.parse(fs.readFileSync(agentPath(folder, 'manifest.json'), 'utf-8')) as {
        name?: string;
        pubkey?: string;
      };
    } catch {
      continue; // folder without a manifest — skip, keep searching
    }
    if (!isAddress && raw.name === input) matches.push(folder);
    if (isAddress && pubkeyFromAddress && raw.pubkey === pubkeyFromAddress) matches.push(folder);
  }

  if (matches.length === 0) return { error: `No agent matches '${input}'.` };
  if (matches.length > 1) {
    return {
      error: `Ambiguous identifier '${input}' matches ${matches.length} agents (${matches.join(', ')}). Pass the folder name explicitly.`,
    };
  }
  return { folder: matches[0] };
}

export function registerManagerTools(server: McpServer, ctx: ConsoleMcpContext): void {
  if (!isManagerConsole(ctx.consoleName)) return;
  const consoleName = ctx.consoleName;

  registerListTool(server, consoleName);
  registerReadTool(server, consoleName);
  registerResurveyTool(server, consoleName);
  registerEventsTool(server);
}

function registerListTool(server: McpServer, consoleName: ManagerConsole): void {
  server.tool(
    'manager__list',
    'List a directory under a cross-agent surface — use when the summary marks a dir as `## Collapsed`, or when you need file-level detail the summary doesn\'t expose. Paths are relative to the target agent\'s root (e.g. `blueprint/channels`). Returns `{ entries, totalCount, offset, limit }` with entries `{ name, type: "file"|"dir", size }`. Symlinks are silently skipped.',
    {
      agent: z.string().describe('Target agent: folder name, alias, or `a:<pubkey>@<issuer>` address.'),
      path: z.string().describe('Directory path, agent-root-relative (no leading slash, no `..`).'),
      glob: z.string().optional().describe('Shell-style filter applied to entry names (e.g. `*.md`).'),
      offset: z.number().optional().describe('Pagination: skip N entries. Default 0.'),
      limit: z.number().optional().describe('Pagination: return at most N entries. Default 50.'),
    },
    async (args): Promise<ToolResult> => {
      const resolved = resolveAgentToFolder(args.agent);
      if (!resolved.folder) return textResult(resolved.error ?? 'unknown resolution error', true);
      if (!isReadable(consoleName, args.path)) {
        return textResult(`Path '${args.path}' is not readable by ${consoleName}.`, true);
      }

      const absDir = agentPath(resolved.folder, args.path);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch (err) {
        return textResult(
          `Cannot list '${args.path}': ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }

      let filtered = entries.filter((e) => !e.isSymbolicLink());
      if (args.glob) {
        const rx = globToRegex(args.glob);
        filtered = filtered.filter((e) => rx.test(e.name));
      }

      const offset = args.offset ?? 0;
      const limit = args.limit ?? 50;
      const paged = filtered.slice(offset, offset + limit).map((e) => {
        let size = 0;
        try {
          size = fs.statSync(path.join(absDir, e.name)).size;
        } catch {
          /* ignore */
        }
        return {
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          size,
        };
      });

      return textResult(
        JSON.stringify({ entries: paged, totalCount: filtered.length, offset, limit }),
      );
    },
  );
}

function registerReadTool(server: McpServer, consoleName: ManagerConsole): void {
  server.tool(
    'manager__read',
    'Read a file under a cross-agent surface — use when the summary stubs a file (`reason: binary` or `reason: size`) or when you need a specific line range. Paths are relative to the target agent\'s root. Returns `{ content, truncated, totalLines }`. Symlinks are refused.',
    {
      agent: z.string().describe('Target agent: folder name, alias, or `a:<pubkey>@<issuer>` address.'),
      path: z.string().describe('File path, agent-root-relative (no leading slash, no `..`).'),
      offset: z.number().optional().describe('Starting line (0-indexed). Default 0.'),
      limit: z.number().optional().describe('Max lines to return. Default 500.'),
    },
    async (args): Promise<ToolResult> => {
      const resolved = resolveAgentToFolder(args.agent);
      if (!resolved.folder) return textResult(resolved.error ?? 'unknown resolution error', true);
      if (!isReadable(consoleName, args.path)) {
        return textResult(`Path '${args.path}' is not readable by ${consoleName}.`, true);
      }

      const absPath = agentPath(resolved.folder, args.path);
      try {
        if (fs.lstatSync(absPath).isSymbolicLink()) {
          return textResult('Path is a symlink; refused.', true);
        }
      } catch (err) {
        return textResult(
          `Cannot stat '${args.path}': ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }

      let raw: string;
      try {
        raw = fs.readFileSync(absPath, 'utf-8');
      } catch (err) {
        return textResult(
          `Cannot read '${args.path}': ${err instanceof Error ? err.message : String(err)}`,
          true,
        );
      }

      const lines = raw.split('\n');
      const totalLines = lines.length;
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 500;
      const paged = lines.slice(offset, offset + limit);
      const truncated = offset + paged.length < totalLines;

      return textResult(
        JSON.stringify({ content: paged.join('\n'), truncated, totalLines }),
      );
    },
  );
}

function registerResurveyTool(server: McpServer, consoleName: ManagerConsole): void {
  server.tool(
    'manager__resurvey',
    'Regenerate surface summaries and report which changed. Use after pushing an edit to another agent, or to refresh stale summaries. No args = sweep every agent × every readable surface. Returns `{ changed: string[], unchanged: string[] }` with keys shaped `folder:surface`.',
    {
      agent: z.string().optional().describe('Target agent (folder/alias/address). Omit to sweep all.'),
      surface: z.enum(['blueprint', 'config']).optional().describe(
        'Restrict to one surface. Omit to sweep every surface this console can read.',
      ),
    },
    async (args): Promise<ToolResult> => {
      const surfacesForConsole = readableSurfaces(consoleName);
      if (args.surface && !surfacesForConsole.includes(args.surface)) {
        return textResult(`Surface '${args.surface}' is not readable by ${consoleName}.`, true);
      }

      let folders: string[];
      if (args.agent) {
        const resolved = resolveAgentToFolder(args.agent);
        if (!resolved.folder) return textResult(resolved.error ?? 'unknown resolution error', true);
        folders = [resolved.folder];
      } else {
        folders = listSubdirectories(AGENTS_DIR).filter((f) => !f.startsWith('.'));
      }

      const surfaces = args.surface ? [args.surface] : surfacesForConsole;
      const viewDir = viewDirForConsole(consoleName);
      fs.mkdirSync(viewDir, { recursive: true });

      const changed: string[] = [];
      const unchanged: string[] = [];
      for (const folder of folders) {
        for (const surface of surfaces) {
          const key = `${folder}:${surface}`;
          const didWrite = writeSurfaceIfChanged(consoleName, folder, surface, viewDir);
          if (didWrite) changed.push(key);
          else unchanged.push(key);
        }
      }

      return textResult(JSON.stringify({ changed, unchanged }));
    },
  );
}

function registerEventsTool(server: McpServer): void {
  server.tool(
    'manager__events',
    'Query the agent event log for a specific agent. Returns recent errors, warnings, and lifecycle events from `state/agent.db`. Use to triage failures or to confirm whether a scheduler/service/container action actually fired. Returns `{ events, total, truncated }`. Events sort newest-first by timestamp.',
    {
      agent: z.string().describe('Target agent: folder name, alias, or `a:<pubkey>@<issuer>` address.'),
      limit: z.number().optional().describe('Max events to return. Default 50.'),
      level: z.enum(['error', 'warn', 'info']).optional().describe('Filter by severity.'),
      component: z.enum(['agent', 'backup', 'container', 'conversation', 'scheduler', 'service']).optional().describe('Filter by component.'),
      since: z.string().optional().describe('ISO 8601 timestamp lower bound (exclusive).'),
      conversationKey: z.string().optional().describe('Filter to events tagged with this conversation key.'),
    },
    async (args): Promise<ToolResult> => {
      const resolved = resolveAgentToFolder(args.agent);
      if (!resolved.folder) return textResult(resolved.error ?? 'unknown resolution error', true);

      const limit = args.limit ?? 50;
      const queryOpts = {
        level: args.level as EventLevel | undefined,
        component: args.component,
        since: args.since,
        conversationKey: args.conversationKey,
      };

      const db = new AgentDb(agentPath(resolved.folder, 'state', 'agent.db'));
      try {
        const events = db.readEvents({ ...queryOpts, limit });
        const total = db.countEvents(queryOpts);
        const truncated = events.length < total;
        return textResult(JSON.stringify({ events, total, truncated }));
      } finally {
        db.close();
      }
    },
  );
}

// Glob → regex for `manager__list`'s glob filter. Deliberately narrow — this
// is display filtering, not a security boundary (`isReadable` already gated
// the path). Handles `*` and `?` only.
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const rx = escaped.replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${rx}$`);
}
