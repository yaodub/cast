/**
 * Surface summary walker.
 *
 * Produces a bounded markdown summary of one agent surface (`blueprint/` or
 * `config/`) for a server-scope console (DM/CM/SM). Surface files land in one
 * of four TOC sections:
 *
 *   ## Files            — inlined with `===== FILE: <path> =====` delimiter
 *   ## Stubbed          — path + size, content omitted (binary or oversize)
 *   ## Collapsed        — aggregate line, contents unlisted (L2 blacklist only)
 *   ## Skipped (symlinks) — path → target, never traversed
 *
 * Every file encountered in an admitted subtree is covered by exactly one
 * section — invariant enforced by the walker test.
 *
 * Bounds applied:
 *   - Files >64KB stub without reading (avoids inlining bundled service JS).
 *   - TOC sections + inlined content sort by (priority, path) so prompts and
 *     operator config lead the summary — LLM reads what matters first.
 *
 * Deliberately NOT here (add only when a real pathological case hits):
 *   depth cap, child-count cap, file-count cap, total-size cap + eviction,
 *   node-count abort, `.state.json` hash-skip.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { isText } from 'istextorbinary';

import { agentPath } from '../../config.js';

import { isReadable, type ManagerConsole } from './read-policy.js';

export type Surface = 'blueprint' | 'config';

export interface SurfaceSummary {
  /** sha1 hex of the emitted content bytes. Fast change-detection. */
  readonly hash: string;
  /** Full markdown summary, ready to write to the view dir. */
  readonly content: string;
}

/**
 * Optional agent identity metadata to emit in the summary header.
 *
 * Why these are decoupled from `agentFolder`:
 *   - Folder is mutable; the working path identifier, session-stable by Apple
 *     Container bind-mount semantics but not guaranteed beyond that.
 *   - Alias (`manifest.name`) is mutable, operator-facing.
 *   - Address (`a:<pubkey>@<issuer>`) is the only truly immutable GUID, derived
 *     from the agent's identity keypair.
 *
 * Including alias + address in the summary header lets the LLM correlate
 * filename/folder (what Glob returns) ↔ operator speech (alias) ↔ bus-level
 * identity (address). If a rename happens between sessions, the LLM can still
 * identify the agent by address regardless of what the folder renamed to.
 */
export interface SurfaceIdentity {
  /** Display name from `manifest.name`. Mutable. */
  readonly alias?: string;
  /** Bus address `a:<pubkey>@<issuer>`. Immutable per agent. */
  readonly address?: string;
}

/**
 * How much of an unknown-extension file to read for istextorbinary's buffer
 * fallback. Known extensions short-circuit on filename alone (see `detectText`).
 */
const TEXT_PROBE_BYTES = 4096;

/**
 * Files larger than this are stubbed without being read. Targets bundled
 * service/index.js (typically 1–3MB) and large reference docs, without
 * constraining honest content. Agent prompts are typically 2–10KB; 64KB
 * comfortably fits them and any reasonable handwritten content.
 */
const SIZE_STUB_BYTES = 64 * 1024;

interface InlinedFile {
  path: string;
  size: number;
  content: string;
}

interface StubbedFile {
  path: string;
  size: number;
  reason: 'binary' | 'size';
}

interface CollapsedEntry {
  path: string;
  reason: 'blacklist';
  kind: 'file' | 'dir';
}

interface SkippedSymlink {
  path: string;
  target: string;
}

interface WalkState {
  files: InlinedFile[];
  stubs: StubbedFile[];
  collapsed: CollapsedEntry[];
  skippedSymlinks: SkippedSymlink[];
}

/**
 * Walk one surface of one agent folder, producing the summary markdown + a
 * content hash. `surface` picks blueprint/ vs config/; `consoleName` keys the
 * readability predicate.
 *
 * Missing or non-directory surface root → empty-surface summary (header +
 * `_No files._`). A manager glob on `*.<surface>.md` still matches.
 */
export function walkSurface(
  agentFolder: string,
  surface: Surface,
  consoleName: ManagerConsole,
  identity?: SurfaceIdentity,
): SurfaceSummary {
  const state: WalkState = {
    files: [],
    stubs: [],
    collapsed: [],
    skippedSymlinks: [],
  };

  const surfaceRoot = agentPath(agentFolder, surface);
  let rootStats: fs.Stats | null = null;
  try {
    rootStats = fs.lstatSync(surfaceRoot);
  } catch {
    rootStats = null;
  }

  if (rootStats && rootStats.isDirectory()) {
    walkDir(surfaceRoot, '', surface, consoleName, state);
  }

  const content = render(agentFolder, surface, state, identity);
  // Hash excludes the `rev:` timestamp line — otherwise two back-to-back
  // renders of identical underlying state produce different hashes and
  // `writeSurfaceIfChanged` never declares idempotency. rev is cosmetic
  // header metadata, not part of the surface signature.
  const canonical = content.replace(/^rev: .*$/m, '');
  const hash = crypto.createHash('sha1').update(canonical).digest('hex');
  return { hash, content };
}

function walkDir(
  absDir: string,
  surfaceRelDir: string,
  surface: Surface,
  consoleName: ManagerConsole,
  state: WalkState,
): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const surfaceRelPath = surfaceRelDir ? `${surfaceRelDir}/${entry.name}` : entry.name;
    const agentRelPath = `${surface}/${surfaceRelPath}`;
    const absPath = path.join(absDir, entry.name);

    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(absPath);
    } catch {
      continue;
    }

    if (stats.isSymbolicLink()) {
      let target = '?';
      try {
        target = fs.readlinkSync(absPath);
      } catch {
        /* keep '?' */
      }
      state.skippedSymlinks.push({ path: surfaceRelPath, target });
      continue;
    }

    if (!isReadable(consoleName, agentRelPath)) {
      state.collapsed.push({
        path: surfaceRelPath,
        reason: 'blacklist',
        kind: stats.isDirectory() ? 'dir' : 'file',
      });
      continue;
    }

    if (stats.isDirectory()) {
      walkDir(absPath, surfaceRelPath, surface, consoleName, state);
      continue;
    }

    if (!stats.isFile()) continue; // sockets, fifos, etc.

    // Size gate runs before text detection — avoids reading 2MB of bundled JS
    // just to classify it. If the file is huge, we don't care whether it's
    // text or binary; it's not getting inlined.
    if (stats.size > SIZE_STUB_BYTES) {
      state.stubs.push({ path: surfaceRelPath, size: stats.size, reason: 'size' });
      continue;
    }

    if (!detectText(absPath)) {
      state.stubs.push({ path: surfaceRelPath, size: stats.size, reason: 'binary' });
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(absPath, 'utf-8');
    } catch {
      continue;
    }
    state.files.push({ path: surfaceRelPath, size: stats.size, content });
  }
}

/**
 * Text/binary detection via istextorbinary:
 *   1. Extension allowlist (textextensions / binaryextensions) — resolves
 *      common cases with zero I/O (.md, .json, .png, .sqlite, etc).
 *   2. Unknown-extension fallback: probe first 4KB + encoding check
 *      (null-byte scan + UTF-8 validity). Handles Dockerfile, .env, etc.
 *
 * I/O errors treat the file as binary — keeps unreadable content out of
 * the summary rather than surfacing read errors mid-walk.
 */
export function detectText(absPath: string): boolean {
  // Fast path: extension alone often decides. Pass null buffer — istextorbinary
  // returns true/false for known extensions, null for unknown.
  const byExtension = isText(absPath, null);
  if (byExtension !== null) return byExtension;

  try {
    const fd = fs.openSync(absPath, 'r');
    try {
      const buf = Buffer.alloc(TEXT_PROBE_BYTES);
      const n = fs.readSync(fd, buf, 0, TEXT_PROBE_BYTES, 0);
      const result = isText(absPath, buf.subarray(0, n));
      return result === true;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

// =========================================================================
// Rendering
// =========================================================================

function render(
  agentFolder: string,
  surface: Surface,
  state: WalkState,
  identity: SurfaceIdentity | undefined,
): string {
  const rev = new Date().toISOString();
  // Primary line keys on folder — matches the filename the manager globbed.
  // Identity metadata follows so the LLM can correlate to alias (operator
  // speech) or address (bus-level stable GUID) when they diverge from folder.
  const parts: string[] = [`# ${surface} — ${agentFolder}`];
  parts.push(`folder: ${agentFolder}`);
  if (identity?.alias) parts.push(`alias: ${identity.alias}`);
  if (identity?.address) parts.push(`address: ${identity.address}`);
  parts.push(`rev: ${rev}`);
  parts.push('');

  const totalEntries =
    state.files.length + state.stubs.length + state.collapsed.length + state.skippedSymlinks.length;
  if (totalEntries === 0) {
    parts.push('_No files._', '');
    return parts.join('\n');
  }

  if (state.files.length > 0) {
    parts.push('## Files');
    for (const f of [...state.files].sort(byPriorityThenPath)) {
      parts.push(`- ${f.path}  (${formatBytes(f.size)})`);
    }
    parts.push('');
  }

  if (state.stubs.length > 0) {
    parts.push('## Stubbed');
    for (const s of [...state.stubs].sort(byPriorityThenPath)) {
      parts.push(`- ${s.path}  (${formatBytes(s.size)}, reason: ${s.reason})`);
    }
    parts.push('');
  }

  if (state.collapsed.length > 0) {
    parts.push('## Collapsed');
    for (const c of [...state.collapsed].sort(byPriorityThenPath)) {
      parts.push(`- ${c.path}  (${c.kind}, reason: ${c.reason})`);
    }
    parts.push('');
  }

  if (state.skippedSymlinks.length > 0) {
    parts.push('## Skipped (symlinks)');
    for (const s of [...state.skippedSymlinks].sort(byPriorityThenPath)) {
      parts.push(`- ${s.path} → ${s.target}`);
    }
    parts.push('');
  }

  for (const f of [...state.files].sort(byPriorityThenPath)) {
    parts.push(`===== FILE: ${f.path} =====`, f.content, '');
  }

  return parts.join('\n');
}

// =========================================================================
// Priority ordering (sort key for TOC + inlined content)
// =========================================================================

/**
 * First-match-wins pattern list. Paths that match an earlier entry get that
 * priority; anything unmatched falls through to priority 5. Patterns are
 * surface-root-relative (e.g. `prompt.md` for `blueprint/prompt.md`).
 *
 * The point is ordering, not eviction — T1 entries appear first in each TOC
 * section and first in the inlined content, so the LLM's eye lands on the
 * files that most define the agent.
 */
const PRIORITY_PATTERNS: ReadonlyArray<{ pattern: string; priority: number }> = [
  // T1 — identity & prompts. What makes this agent itself.
  { pattern: 'prompt.md', priority: 1 },
  { pattern: 'whoami.md', priority: 1 },
  { pattern: 'skills.md', priority: 1 },
  { pattern: 'channels/**/prompt.md', priority: 1 },
  { pattern: 'channels/**/skills.md', priority: 1 },

  // T2 — operator-controlled config + declared capabilities + Design staging.
  { pattern: 'agent.json', priority: 2 },
  { pattern: 'acl.json', priority: 2 },
  { pattern: 'mcp-servers.json', priority: 2 },
  { pattern: 'provisions.json', priority: 2 },
  { pattern: 'props/*.json', priority: 2 },
  { pattern: 'ext/**/config.json', priority: 2 },
  { pattern: '.design/**/*', priority: 2 },

  // T3 — channel sundries, auxiliary props, opaque ext secrets.
  { pattern: 'channels/**/*', priority: 3 },
  { pattern: 'props/**/*', priority: 3 },
  { pattern: 'ext/**/secrets.json', priority: 3 },

  // T4 — bundled service code. Presence matters; contents rarely do.
  { pattern: 'service/**/*', priority: 4 },

  // T5 — everything else (README.md, refs/, notes/, …) falls through to 5.
];

export function priorityOf(relPath: string): number {
  for (const { pattern, priority } of PRIORITY_PATTERNS) {
    if (matchPriorityPattern(relPath, pattern)) return priority;
  }
  return 5;
}

/**
 * Narrow glob matcher covering exactly the pattern shapes used in
 * `PRIORITY_PATTERNS`:
 *
 *   - exact literal           — `prompt.md`
 *   - `<prefix>/**\/\*`        — anything at any depth under prefix
 *   - `<prefix>/**\/<suffix>` — any path under prefix ending in /suffix
 *   - `<prefix>/*<suffix>`    — direct child of prefix matching suffix
 *
 * Returns false for unsupported shapes — loud failure beats silent wrong
 * ordering.
 */
function matchPriorityPattern(relPath: string, pattern: string): boolean {
  if (!pattern.includes('*')) return relPath === pattern;

  const deepAll = pattern.match(/^(.+)\/\*\*\/\*$/);
  if (deepAll) {
    const prefix = deepAll[1];
    return relPath.startsWith(prefix + '/');
  }

  const deepSuffix = pattern.match(/^(.+)\/\*\*\/([^*]+)$/);
  if (deepSuffix) {
    const [, prefix, suffix] = deepSuffix;
    return relPath.startsWith(prefix + '/') && relPath.endsWith('/' + suffix);
  }

  const shallow = pattern.match(/^([^*]+)\/\*([^*]+)$/);
  if (shallow) {
    const [, prefix, suffix] = shallow;
    if (!prefix || !suffix) return false;
    if (!relPath.startsWith(prefix + '/')) return false;
    const rest = relPath.slice(prefix.length + 1);
    return !rest.includes('/') && rest.endsWith(suffix);
  }

  return false;
}

function byPriorityThenPath<T extends { path: string }>(a: T, b: T): number {
  const pa = priorityOf(a.path);
  const pb = priorityOf(b.path);
  if (pa !== pb) return pa - pb;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
