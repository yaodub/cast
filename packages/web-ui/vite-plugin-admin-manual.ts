/**
 * Vite plugin — emits `dist/admin-manual.json` from the colocated `pageManual`
 * exports.
 *
 * Two hooks cover the whole pipeline without a concurrent helper process:
 *
 * - `configureServer(server)` — dev mode. Imports `src/admin/manual.ts` once
 *   at startup, writes the JSON, then watches `src/admin/pages/**\/*.tsx` and
 *   re-emits on any change. New Configure sessions pick up the fresh registry.
 *
 * - `closeBundle()` — prod mode (vite build). Imports `src/admin/manual.ts`
 *   once after the bundle closes, writes JSON next to the built assets. The
 *   cast server's build-server.ts copies it into its own deploy dir.
 *
 * The plugin imports the aggregator via Vite's `ssrLoadModule` so TS + JSX
 * resolution are handled without pulling React runtime. Dev uses the already-
 * running Vite dev server's module graph; prod spawns a short-lived Vite in
 * ssr mode inside the hook.
 */
import fs from 'fs';
import path from 'path';
import type { Plugin, ViteDevServer, ResolvedConfig } from 'vite';

const MANUAL_ENTRY = path.resolve(import.meta.dirname ?? '.', 'src/admin/manual.ts');
const PAGES_GLOB = path.resolve(import.meta.dirname ?? '.', 'src/admin/pages');

interface EmitOptions {
  /** Absolute path to `dist/admin-manual.json`. */
  outPath: string;
}

async function emitManualViaServer(server: ViteDevServer, opts: EmitOptions): Promise<void> {
  try {
    const mod = await server.ssrLoadModule(MANUAL_ENTRY);
    const manual = (mod as { ADMIN_MANUAL?: unknown }).ADMIN_MANUAL;
    if (!manual || typeof manual !== 'object') {
      server.config.logger.warn(`[admin-manual] manual.ts did not export ADMIN_MANUAL`);
      return;
    }
    fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
    fs.writeFileSync(opts.outPath, JSON.stringify(manual, null, 2) + '\n');
    server.config.logger.info(
      `[admin-manual] wrote ${path.relative(process.cwd(), opts.outPath)} (${Object.keys(manual).length} pages)`,
    );
  } catch (err) {
    server.config.logger.warn(`[admin-manual] failed to emit: ${(err as Error).message}`);
  }
}

async function emitManualViaFreshBuild(opts: EmitOptions): Promise<void> {
  // Prod path: spawn a short-lived Vite in ssr mode to load manual.ts. We can't
  // reuse the main build's output because the pageManual consts are tree-shaken
  // out of component bundles — they're authoring-time data, not runtime.
  const { createServer } = await import('vite');
  const ssr = await createServer({
    configFile: false,
    plugins: [(await import('@preact/preset-vite')).default()],
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'warn',
  });
  try {
    const mod = await ssr.ssrLoadModule(MANUAL_ENTRY);
    const manual = (mod as { ADMIN_MANUAL?: unknown }).ADMIN_MANUAL;
    if (!manual || typeof manual !== 'object') {
      console.warn('[admin-manual] manual.ts did not export ADMIN_MANUAL');
      return;
    }
    fs.mkdirSync(path.dirname(opts.outPath), { recursive: true });
    fs.writeFileSync(opts.outPath, JSON.stringify(manual, null, 2) + '\n');
    console.log(
      `[admin-manual] wrote ${path.relative(process.cwd(), opts.outPath)} (${Object.keys(manual).length} pages)`,
    );
  } finally {
    await ssr.close();
  }
}

export function adminManualPlugin(): Plugin {
  let resolvedConfig: ResolvedConfig | null = null;

  return {
    name: 'cast-admin-manual',

    configResolved(config) {
      resolvedConfig = config;
    },

    configureServer(server) {
      const outPath = path.resolve(server.config.root, 'dist/admin-manual.json');
      // Emit once at startup, then watch page files and re-emit on change. Dev
      // server already uses chokidar via server.watcher — piggyback on it.
      void emitManualViaServer(server, { outPath });
      server.watcher.add(PAGES_GLOB);
      const rerun = (file: string): void => {
        if (!file.startsWith(PAGES_GLOB)) return;
        // Bust the SSR module cache so the reimport sees the edited file.
        server.moduleGraph.invalidateAll();
        void emitManualViaServer(server, { outPath });
      };
      server.watcher.on('change', rerun);
      server.watcher.on('add', rerun);
      server.watcher.on('unlink', rerun);
    },

    async closeBundle() {
      // `closeBundle` fires after `vite build` writes its assets. Emit the JSON
      // alongside by reading outDir from the resolved config.
      if (!resolvedConfig) return;
      // Only run in build, not in serve — configureServer owns dev emission.
      if (resolvedConfig.command !== 'build') return;
      const outPath = path.resolve(resolvedConfig.root, resolvedConfig.build.outDir, 'admin-manual.json');
      await emitManualViaFreshBuild({ outPath });
    },
  };
}
