/**
 * Aggregate per-extension manuals into `packages/cast/manuals/extensions/`
 * so every console container sees them at `/ref/manuals/extensions/<name>/`.
 *
 * Source: each `packages/ext-<pkg>/manual/` tree (README.md, SKILL.md, skills subdir).
 * Destination: `packages/cast/manuals/extensions/<pkg>/…`
 *
 * Runs at server start (before any console session spawns) so the copy
 * refreshes on every `pnpm dev` restart. Idempotent — target subdir is
 * cleared before each copy. Also runs during bundled builds (invoked by
 * `scripts/build-server.ts`) so deployed dist/manuals/ ships the same shape.
 *
 * No frontmatter validation — extensions set their own format.
 * We copy, we don't parse.
 *
 * SIDE EFFECTS: Module-level catalog cache (`cachedExtensions`) populated by
 *   the most recent `aggregateExtensionManuals()` call. Server-lifetime
 *   singleton: extensions register at startup and the aggregated tree is
 *   read-only afterward, so prompt-assembly helpers can read the catalog
 *   without re-walking the filesystem.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { logger } from '../../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Resolve the repo's `packages/` directory from this module's on-disk
 * location. Dev: `packages/cast/src/console/shared/` → `../../../..` →
 * `packages/`. Breaks if the source layout moves; that's acceptable — the
 * aggregation helper belongs to the dev/build flow, not runtime routing.
 */
function resolvePackagesDir(): string | null {
  const candidate = path.resolve(__dirname, '../../../../..', 'packages');
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Resolve the canonical destination for aggregated extension manuals.
 * Matches `resolveManualsDir()` in `console/index.ts` — both paths feed
 * into the same `/ref/manuals/` mount via `buildBaseMounts`.
 *
 * Dev: `packages/cast/src/console/shared/` → `../../../manuals` →
 *      `packages/cast/manuals/`.
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

export interface AggregatedExtension {
  /** Extension package name (directory under `packages/ext-<name>/`). */
  readonly name: string;
  /** One-line description from the README frontmatter, if present. */
  readonly description: string | null;
  /** Whether a SKILL.md was present. */
  readonly hasSkill: boolean;
}

export interface AggregateOpts {
  /** Repo `packages/` dir — defaults to resolving from this module. */
  readonly packagesDir?: string;
  /** Destination manuals root — defaults to `packages/cast/manuals/`. */
  readonly manualsRoot?: string;
  /** Names of extensions the runtime registry knows about. When provided, the
   *  aggregated manual tree is checked against it for drift (see
   *  `checkRegistrationDrift`). */
  readonly registeredNames?: ReadonlySet<string>;
  /** Silent mode — no info/warn log emission. Build scripts want quiet. */
  readonly quiet?: boolean;
}

/**
 * Copy every `packages/ext-<name>/manual/` tree into
 * `<manualsRoot>/extensions/<name>/`. Returns metadata for each extension
 * copied so callers (DM, CM, SM snapshots) can render a one-line catalog.
 *
 * Default paths resolve via this module's location (dev server start).
 * Callers outside the source tree (e.g. `scripts/build-server.ts`) pass
 * explicit paths.
 *
 * Failure modes:
 *   - No packages/ dir (unusual layout) → returns empty.
 *   - No manuals/ dest → returns empty. Build-time aggregation is
 *     expected to have populated the dest when running from a dist bundle.
 *   - Per-extension read/copy error → extension skipped, others continue.
 */
/**
 * Module-level cache populated by the most recent successful
 * `aggregateExtensionManuals()` call. Consumed by prompt-assembly helpers
 * that want the one-line catalog without re-walking the filesystem.
 *
 * Lives as a module singleton because the aggregation is a server-lifetime
 * operation — extensions are registered at startup, and the aggregated tree
 * is read-only afterward.
 */
let cachedExtensions: AggregatedExtension[] = [];

/** Return the catalog populated at server-start aggregation. Empty before. */
export function getAggregatedExtensions(): readonly AggregatedExtension[] {
  return cachedExtensions;
}

/**
 * Render the one-line extension catalog for inclusion in a console's
 * dynamic snapshot. Each entry: `- **<name>** — <description>` when a
 * description is present, else `- **<name>**`. Appends a trailing hint
 * pointing at the manuals mount.
 *
 * Returns null when no extensions are registered — caller should skip the
 * section entirely.
 */
export function formatExtensionCatalog(extensions: readonly AggregatedExtension[]): string | null {
  if (extensions.length === 0) return null;
  const lines = extensions.map((e) => {
    const desc = e.description ? ` — ${e.description}` : '';
    return `- **${e.name}**${desc}`;
  });
  lines.push(
    '',
    'Full manuals are at `/ref/manuals/extensions/<name>/{README,SKILL}.md` — read the relevant one before wiring or proposing an extension.',
  );
  return lines.join('\n');
}

export function aggregateExtensionManuals(opts: AggregateOpts = {}): AggregatedExtension[] {
  const packagesDir = opts.packagesDir ?? resolvePackagesDir();
  const manualsRoot = opts.manualsRoot ?? resolveManualsRoot();
  const quiet = opts.quiet ?? false;

  if (!manualsRoot) {
    if (!quiet) {
      logger.warn(
        { packagesDir, manualsRoot },
        'Cannot aggregate extension manuals — manuals root not resolvable',
      );
    }
    return [];
  }

  const destRoot = path.join(manualsRoot, 'extensions');

  // Prod path: bundle carries a pre-aggregated manuals/extensions/ tree, and
  // packages/ isn't available at runtime. Load the catalog from what's on
  // disk so the dynamic-snapshot extension list stays populated.
  if (!packagesDir) {
    if (!fs.existsSync(destRoot)) {
      if (!quiet) {
        logger.warn({ destRoot }, 'No pre-aggregated extension manuals found at runtime');
      }
      return [];
    }
    const results = readPreAggregatedExtensions(destRoot);
    cachedExtensions = results;
    if (opts.registeredNames) checkRegistrationDrift(results, opts.registeredNames, quiet);
    if (!quiet) {
      logger.info(
        { count: results.length, extensions: results.map((r) => r.name), source: 'bundle' },
        'Extension manuals loaded from bundle',
      );
    }
    return results;
  }

  // Clean slate each run — never merge with stale copies.
  if (fs.existsSync(destRoot)) {
    fs.rmSync(destRoot, { recursive: true, force: true });
  }
  fs.mkdirSync(destRoot, { recursive: true });

  const results: AggregatedExtension[] = [];

  const entries = fs.readdirSync(packagesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('ext-')) continue;

    const extName = entry.name.slice('ext-'.length);
    const srcManualDir = path.join(packagesDir, entry.name, 'manual');
    if (!fs.existsSync(srcManualDir)) continue;

    const destManualDir = path.join(destRoot, extName);

    try {
      fs.cpSync(srcManualDir, destManualDir, { recursive: true });
    } catch (err) {
      if (!quiet) {
        logger.warn(
          { extension: extName, err: (err as Error).message },
          'Failed to copy extension manual — skipping',
        );
      }
      continue;
    }

    const readmePath = path.join(destManualDir, 'README.md');
    const skillPath = path.join(destManualDir, 'SKILL.md');
    const description = readFrontmatterDescription(readmePath);
    const hasSkill = fs.existsSync(skillPath);

    // Sanity check: defineExtension({name}) in src/index.ts must agree with
    // the folder-derived key. Drift means someone renamed the folder without
    // updating the registration. Build scripts (`quiet: true`) throw; dev
    // server startup warn-logs and continues — we want dev to keep booting
    // even if a locally-edited extension is temporarily inconsistent.
    const declaredName = readDefinedExtensionName(
      path.join(packagesDir, entry.name, 'src', 'index.ts'),
    );
    if (declaredName && declaredName !== extName) {
      const msg = `Extension folder name "${extName}" disagrees with defineExtension({ name: "${declaredName}" }) in ${entry.name}/src/index.ts — folder is the authoritative key.`;
      if (quiet) throw new Error(msg);
      if (!quiet) logger.warn({ extension: extName, declaredName }, msg);
    }

    results.push({ name: extName, description, hasSkill });
  }

  results.sort((a, b) => a.name.localeCompare(b.name));
  cachedExtensions = results;
  if (opts.registeredNames) checkRegistrationDrift(results, opts.registeredNames, quiet);
  if (!quiet) {
    logger.info(
      { count: results.length, extensions: results.map((r) => r.name) },
      'Extension manuals aggregated',
    );
  }
  return results;
}

/**
 * Warn (or throw, under quiet build mode) on drift between the aggregated
 * manual tree and the runtime extension registry. Mirrors the consistency
 * check in transport-manuals.ts.
 *
 * A registered extension with no manual leaves the DM with no field guidance
 * to cite. A manual with no matching registered extension is the dangerous
 * direction: the DM's snapshot is headed "Extensions registered on this
 * server", so an orphaned manual would advertise a capability the server
 * cannot honor — an agent wired to it gets blocked at the validation gate
 * with no signal that the extension was never registered. Surfacing the drift
 * at startup keeps that catalog honest.
 */
function checkRegistrationDrift(
  results: readonly AggregatedExtension[],
  registeredNames: ReadonlySet<string>,
  quiet: boolean,
): void {
  const documented = new Set(results.map((r) => r.name));
  for (const name of registeredNames) {
    if (!documented.has(name)) {
      const msg = `Extension "${name}" is registered but has no manual at packages/ext-${name}/manual/README.md`;
      if (quiet) throw new Error(msg);
      logger.warn({ extension: name }, msg);
    }
  }
  for (const r of results) {
    if (!registeredNames.has(r.name) && !quiet) {
      logger.warn(
        { extension: r.name },
        `Extension manual exists for "${r.name}" but no extension with that name is registered — console snapshots would advertise it as available`,
      );
    }
  }
}

/**
 * Walk a pre-aggregated `<manualsRoot>/extensions/` tree and build the
 * catalog. Used at prod runtime where packages/ isn't available but the
 * build step already populated destRoot. Description comes from README
 * frontmatter; drift-check against defineExtension is skipped (validated
 * at build time, `quiet: true`).
 */
function readPreAggregatedExtensions(destRoot: string): AggregatedExtension[] {
  const results: AggregatedExtension[] = [];
  for (const entry of fs.readdirSync(destRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(destRoot, entry.name);
    const description = readFrontmatterDescription(path.join(dir, 'README.md'));
    const hasSkill = fs.existsSync(path.join(dir, 'SKILL.md'));
    results.push({ name: entry.name, description, hasSkill });
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

/**
 * Grep the extension's src/index.ts for `defineExtension({ name: '...' })`
 * and return the declared name. Returns null if the file is missing or
 * the pattern doesn't match — we don't treat absence as an error here;
 * extension authors are free to wire up their factory differently. The
 * caller only flags drift when we DID find a name and it disagrees with
 * the folder.
 */
function readDefinedExtensionName(indexPath: string): string | null {
  if (!fs.existsSync(indexPath)) return null;
  const text = fs.readFileSync(indexPath, 'utf-8');
  const match = text.match(/defineExtension\(\s*\{\s*name:\s*['"]([^'"]+)['"]/);
  return match?.[1] ?? null;
}

/**
 * Read a `description: ...` field from YAML frontmatter. Returns null if
 * the file doesn't exist, has no frontmatter block, or the field is
 * absent. No full YAML parse — extensions are disciplined enough that a
 * regex covers it.
 */
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
