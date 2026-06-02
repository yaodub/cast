/**
 * Page-manual loader — reads `admin-manual.json` emitted by the web-ui build.
 *
 * The schema (the JSON shape both ends agree on) lives in `@getcast/admin-schema/v1`;
 * this module owns the cast-side filesystem read + render-to-prompt-text.
 * Injected into each console session's dynamic snapshot so the bot knows
 * what each admin page is for when it calls `admin__navigate`.
 *
 * Follows `resolveManualsDir`'s filesystem-fallback convention (see
 * `packages/cast/src/console/index.ts:37-46`) — no `NODE_ENV` check. The
 * prod bundle is expected to have `admin-manual.json` copied in alongside
 * the `manuals/` directory by `scripts/build-server.ts`; in dev the file
 * lives under `packages/web-ui/dist/`.
 *
 * SIDE EFFECTS: Module-level cache (`cached`, `cachedPath`) populated on
 *   first successful load. Acceptable because the manual file changes only
 *   across builds; new content is picked up on server restart. Cache survives
 *   across all console sessions in the process.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { AdminManualSchema, type AdminManual } from '@getcast/admin-schema/v1';

import { logger } from '../../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Resolve the on-disk path to `admin-manual.json`. Two candidates, probed in
 * order (dev first, prod second) — mirrors `resolveManualsDir`. Returns null
 * if nothing is found, so callers can degrade cleanly.
 */
export function resolveAdminManualPath(): string | null {
  const candidates = [
    // dev: packages/cast/src/console/shared/ → packages/web-ui/dist/admin-manual.json
    path.resolve(__dirname, '../../../../web-ui/dist/admin-manual.json'),
    // prod: bundled index.js → <outdir>/admin-manual.json (same dir as index.js)
    path.resolve(__dirname, 'admin-manual.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

let cached: AdminManual | null = null;
let cachedPath: string | null = null;

/**
 * Load and parse the admin manual. Cached in-process after the first call —
 * the file changes only across builds (dev) or never (prod), and active
 * Configure sessions snapshot their context at session open, so a stale
 * cache is acceptable for 30-minute TTL windows. New sessions pick up new
 * data on next server restart.
 *
 * Returns null if the file is missing or malformed; callers should treat
 * that as "no admin index available" and either skip injection or inject
 * an empty registry.
 */
export function loadAdminManual(): AdminManual | null {
  if (cached && cachedPath && fs.existsSync(cachedPath)) return cached;
  const p = resolveAdminManualPath();
  if (!p) {
    logger.warn('admin-manual.json not found — admin__navigate page index will be absent from console prompts. Run `pnpm -F @getcast/web-ui build` to generate it.');
    return null;
  }
  try {
    const parsed = AdminManualSchema.parse(JSON.parse(fs.readFileSync(p, 'utf-8')));
    cached = parsed;
    cachedPath = p;
    logger.info({ path: p, pages: Object.keys(parsed).length }, 'Admin manual loaded');
    return parsed;
  } catch (err) {
    logger.warn({ err, path: p }, 'Failed to parse admin-manual.json — page index will be absent');
    return null;
  }
}

/** Render the manual as a text block for the console prompt's dynamic snapshot. */
export function renderAdminManual(manual: AdminManual): string {
  const lines: string[] = [];
  const paths = Object.keys(manual).sort();
  for (const p of paths) {
    const entry = manual[p]!;
    lines.push(`- \`${p}\` — ${entry.purpose}`);
    if (entry.actions && entry.actions.length > 0) {
      for (const action of entry.actions) {
        lines.push(`  - ${action}`);
      }
    }
    if (entry.sections && entry.sections.length > 0) {
      for (const sec of entry.sections) {
        lines.push(`  - \`#${sec.anchor}\` — ${sec.purpose}`);
        for (const action of sec.actions) {
          lines.push(`    - ${action}`);
        }
      }
    }
  }
  return lines.join('\n');
}
