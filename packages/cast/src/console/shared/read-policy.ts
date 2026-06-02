/**
 * Shared readability predicate for server-scope console surface summaries.
 * Single authority for "can <console> see <path>?" — used by the walker
 * to decide what to inline vs drop, and by the manager__* MCP tools to
 * authorize escape-hatch reads.
 *
 * Two layers:
 *   Layer 1 — per-console include allowlist. "What's in scope for this
 *     console." DM reads blueprint only; CM+SM read blueprint + config.
 *   Layer 2 — universal walker blacklist. "Never walk these even when
 *     in-scope." Applied inside admitted subtrees — pure hygiene, no
 *     security role.
 *
 * Path safety (absolute paths, `..` escapes) is enforced here as well,
 * ahead of pattern matching. One function, one place to audit.
 *
 * Paths are agent-root-relative POSIX (e.g. `blueprint/prompt.md`). The
 * walker emits surface-root-relative paths in summaries, but reads the
 * fs via agent-root paths, so isReadable uses the agent-root shape.
 */
import path from 'path';

/**
 * Consoles that own a summary view. Narrower than ConsoleName — Design and
 * Configure are per-agent and bind-mount their single target directly.
 */
export type ManagerConsole = 'design-manager' | 'config-manager' | 'security-manager';

/**
 * Layer 1 — include allowlist per console. Patterns are agent-root-relative
 * globs. `<prefix>/**\/\*` admits the prefix itself and everything below it.
 */
export const POLICIES: Readonly<Record<ManagerConsole, readonly string[]>> = {
  'design-manager': ['blueprint/**/*'],
  'config-manager': ['blueprint/**/*', 'config/**/*'],
  'security-manager': ['blueprint/**/*', 'config/**/*'],
};

/**
 * Layer 2 — universal walker hygiene blacklist. Applied inside any admitted
 * subtree. Not a security boundary (an injected agent doesn't gain access
 * by matching); just stops the walker from drowning in node_modules, logs,
 * or build artifacts that sometimes end up under blueprint/.
 */
export const WALKER_BLACKLIST: readonly string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.venv/**',
  '**/*.log',
];

/**
 * Match a single POSIX relative path against one of the restricted glob
 * shapes used in POLICIES + WALKER_BLACKLIST. Deliberately narrow — throws
 * on unsupported patterns rather than silently mis-matching, so a typo in
 * POLICIES fails loud at first use (covered by the read-policy tests).
 *
 * Supported shapes:
 *   - `<prefix>/**\/\*`   — prefix itself or anything underneath
 *   - `**\/<segment>/**` — any path containing `<segment>` as a dir component
 *   - `**\/*.<ext>`      — any path ending in `.<ext>`
 *   - plain string       — exact match
 */
function matchGlob(relPath: string, pattern: string): boolean {
  if (pattern === relPath) return true;

  const prefixMatch = pattern.match(/^(.+)\/\*\*\/\*$/);
  if (prefixMatch?.[1]) {
    const prefix = prefixMatch[1];
    return relPath === prefix || relPath.startsWith(prefix + '/');
  }

  const segMatch = pattern.match(/^\*\*\/([^/*]+)\/\*\*$/);
  if (segMatch?.[1]) {
    const segment = segMatch[1];
    return relPath.split('/').includes(segment);
  }

  const extMatch = pattern.match(/^\*\*\/\*(\.[a-z0-9]+)$/i);
  if (extMatch?.[1]) {
    const ext = extMatch[1];
    return relPath.endsWith(ext) && relPath.length > ext.length;
  }

  throw new Error(`Unsupported glob pattern in read-policy: ${pattern}`);
}

/**
 * Can `console` read `relPath` (agent-root-relative POSIX)?
 *
 * Checks, in order:
 *   1. Path safety — reject absolute, empty, or any `..` segment.
 *   2. Layer 1 include — must match at least one pattern in POLICIES[console].
 *   3. Layer 2 blacklist — must match no pattern in WALKER_BLACKLIST.
 *
 * Returns true iff all checks pass. Single authority — walker and MCP tools
 * call this and do not re-validate path syntax themselves.
 */
export function isReadable(console: ManagerConsole, relPath: string): boolean {
  if (typeof relPath !== 'string' || relPath.length === 0) return false;
  if (relPath.startsWith('/')) return false;

  // path.posix.normalize collapses `./` and redundant slashes. We then check
  // for any `..` segment by split — a leading `..` resolves to itself; an
  // interior `foo/../bar` normalizes to `bar` (harmless), but `bar/../..`
  // produces a leading `..` which the next check rejects.
  const normalized = path.posix.normalize(relPath);
  if (normalized === '.' || normalized === '') return false;
  if (normalized.startsWith('..')) return false;
  if (normalized.split('/').includes('..')) return false;

  const policy = POLICIES[console];
  if (!policy.some((p) => matchGlob(normalized, p))) return false;

  if (WALKER_BLACKLIST.some((p) => matchGlob(normalized, p))) return false;

  return true;
}
