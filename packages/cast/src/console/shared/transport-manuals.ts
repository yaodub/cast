/**
 * Aggregate per-transport manuals from `packages/cast/manuals/transports/`
 * for inclusion in console dynamic snapshots and reference at
 * `/ref/manuals/transports/<name>/` (via the existing /ref/manuals/ mount).
 *
 * No copy step: transports are first-party in `packages/cast/`, so manuals
 * already live at the canonical destination. The aggregator just walks the
 * tree, parses frontmatter, and primes a module-level cache.
 *
 * Runs at server start (before any console session spawns) and at build
 * time (parity with extension aggregation, even though no copy is performed).
 *
 * SIDE EFFECTS: Module-level cache (`cachedTransports`) populated by the
 *   most recent `aggregateTransportManuals()` call.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger } from '../../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve `packages/cast/manuals/` from this module's on-disk location.
 * Mirrors `resolveManualsRoot()` in `extension-manuals.ts`.
 */
function resolveManualsRoot(): string | null {
  const candidates = [
    path.resolve(__dirname, '../../../manuals'), // dev: packages/cast/src/console/shared/ → packages/cast/manuals/
    path.resolve(__dirname, 'manuals'),          // prod: bundled index.js → <outdir>/manuals/
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

export interface AggregatedTransport {
  /** Transport name (directory under `packages/cast/manuals/transports/`). */
  readonly name: string;
  /** One-line description from the README frontmatter, if present. */
  readonly description: string | null;
}

export interface AggregateTransportOpts {
  readonly manualsRoot?: string;
  /** Names of transports the runtime knows about (routed ∪ bespoke). */
  readonly registeredNames?: ReadonlySet<string>;
  /** Silent mode — no info/warn log emission. Build scripts want quiet. */
  readonly quiet?: boolean;
}

let cachedTransports: AggregatedTransport[] = [];

export function getAggregatedTransports(): readonly AggregatedTransport[] {
  return cachedTransports;
}

/**
 * Internal-plumbing transports that exist in the registry but should NOT
 * appear in console snapshots. Console agents have no reason to propose
 * binding `local` (debug-only CLI) or `console` (admin-UI SSE); surfacing
 * them is noise. Stub manuals exist for the consistency check.
 */
const HIDDEN_FROM_CATALOG = new Set(['local', 'console']);

/**
 * Render the one-line transport catalog for inclusion in a console's
 * dynamic snapshot. Mirrors `formatExtensionCatalog`. Returns null when no
 * visible transports — caller should skip the section entirely.
 */
export function formatTransportCatalog(
  transports: readonly AggregatedTransport[],
): string | null {
  const visible = transports.filter((t) => !HIDDEN_FROM_CATALOG.has(t.name));
  if (visible.length === 0) return null;
  const lines = visible.map((t) => {
    const desc = t.description ? ` — ${t.description}` : '';
    return `- **${t.name}**${desc}`;
  });
  lines.push(
    '',
    'Full manuals are at `/ref/manuals/transports/<name>/README.md` — read the relevant one when proposing a transport binding.',
  );
  return lines.join('\n');
}

export function aggregateTransportManuals(
  opts: AggregateTransportOpts = {},
): AggregatedTransport[] {
  const manualsRoot = opts.manualsRoot ?? resolveManualsRoot();
  const quiet = opts.quiet ?? false;

  if (!manualsRoot) {
    if (!quiet) {
      logger.warn(
        { manualsRoot },
        'Cannot aggregate transport manuals — manuals root not resolvable',
      );
    }
    return [];
  }

  const root = path.join(manualsRoot, 'transports');
  if (!fs.existsSync(root)) {
    if (!quiet) {
      logger.warn({ root }, 'No transport manuals directory found');
    }
    return [];
  }

  const results: AggregatedTransport[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const readmePath = path.join(root, entry.name, 'README.md');
    const description = readFrontmatterDescription(readmePath);
    results.push({ name: entry.name, description });
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  cachedTransports = results;

  if (opts.registeredNames) {
    const documented = new Set(results.map((r) => r.name));
    for (const name of opts.registeredNames) {
      if (!documented.has(name)) {
        const msg = `Transport "${name}" is registered but has no manual at packages/cast/manuals/transports/${name}/README.md`;
        if (quiet) throw new Error(msg);
        if (!quiet) logger.warn({ transport: name }, msg);
      }
    }
    for (const r of results) {
      if (!opts.registeredNames.has(r.name) && !quiet) {
        logger.warn(
          { transport: r.name },
          `Transport manual exists for "${r.name}" but no transport with that name is registered`,
        );
      }
    }
  }

  if (!quiet) {
    logger.info(
      { count: results.length, transports: results.map((r) => r.name) },
      'Transport manuals aggregated',
    );
  }
  return results;
}

/** Match extension-manuals.ts behavior — kept inline to avoid coupling. */
function readFrontmatterDescription(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const text = fs.readFileSync(filePath, 'utf-8');
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const block = text.slice(3, end);
  const match = block.match(/^description:\s*(.+?)\s*$/m);
  return match?.[1]?.replace(/^['"]|['"]$/g, '') ?? null;
}
