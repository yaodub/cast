/**
 * Bundle the Cast server into a self-contained directory via esbuild.
 *
 * Usage: tsx scripts/build-server.ts [--outdir <path>] [--name <pm2-name>] [--port <port>]
 * Default outdir: dist/
 * Default name: cast
 * Default port: 5050 (the API server; the web UI runs on 5051 and proxies here)
 *
 * Output is a complete, deployable directory:
 *   index.js               — bundled server (all pure-JS deps inlined)
 *   index.js.map           — source map
 *   web-fetch-server.js    — bundled web-fetch subprocess (own build)
 *   web-fetch-server.js.map
 *   node_modules/          — external deps (native addons, worker-thread pkgs, playwright, tiktoken)
 *   package.json           — minimal manifest for external deps
 *
 * Also generates ecosystem.config.cjs in the parent of outdir for pm2.
 *
 * The output requires only `node index.js` to run — no package manager at
 * the deployment site. External deps are resolved during build, not deploy.
 *
 * Subprocess artifacts (e.g. @getcast/web-fetch) are produced by their own
 * build scripts; this script only copies them in and ensures their runtime
 * externals land in the shared node_modules.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import { homedir } from 'os';
import path from 'path';

import { build as esbuild } from 'esbuild';

import { aggregateExtensionManuals } from '../packages/cast/src/console/shared/extension-manuals.js';
import { aggregateTransportManuals } from '../packages/cast/src/console/shared/transport-manuals.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');
const SERVER_SRC = path.join(PROJECT_ROOT, 'packages', 'cast', 'src', 'index.ts');
const DEFAULT_OUTDIR = path.join(PROJECT_ROOT, 'dist');

/**
 * Packages that must be resolvable from the deploy dir's node_modules:
 * - better-sqlite3: C++ native addon (.node binary)
 * - pino/pino-pretty: use worker_threads with dynamic require()
 * - playwright: dynamic browser launcher, ships binaries out-of-band
 * - tiktoken: WASM loaded via fs.readFileSync from package directory
 *
 * The last two are externals of the @getcast/web-fetch subprocess bundle,
 * not the main server bundle, but they share one node_modules tree.
 */
const EXTERNAL_MODULES = ['better-sqlite3', 'pino', 'pino-pretty', 'playwright', 'tiktoken'];

function readFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outdir = readFlag(args, '--outdir')
    ? path.resolve(readFlag(args, '--outdir')!)
    : DEFAULT_OUTDIR;
  const pm2Name = readFlag(args, '--name') ?? 'cast';
  const portStr = readFlag(args, '--port') ?? '5050';
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port must be an integer in [1, 65535], got ${portStr}`);
  }

  fs.mkdirSync(outdir, { recursive: true });

  console.log(`Bundling Cast server → ${outdir}/`);

  // Build subprocess artifacts produced by their own packages (web-fetch, etc.).
  // This keeps each package responsible for its own bundle shape and externals.
  console.log('Building @getcast/web-fetch subprocess...');
  execSync('pnpm --filter @getcast/web-fetch build', { cwd: PROJECT_ROOT, stdio: 'inherit' });

  // Copy web-fetch subprocess bundle into the deploy dir
  const webFetchDist = path.join(PROJECT_ROOT, 'packages', 'web-fetch', 'dist');
  fs.copyFileSync(path.join(webFetchDist, 'server.js'), path.join(outdir, 'web-fetch-server.js'));
  const wfMap = path.join(webFetchDist, 'server.js.map');
  if (fs.existsSync(wfMap)) {
    fs.copyFileSync(wfMap, path.join(outdir, 'web-fetch-server.js.map'));
  }

  // Read server package.json + web-fetch package.json for dependency versions
  const serverPkg = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, 'packages', 'cast', 'package.json'), 'utf-8'),
  );
  const webFetchPkg = JSON.parse(
    fs.readFileSync(path.join(PROJECT_ROOT, 'packages', 'web-fetch', 'package.json'), 'utf-8'),
  );
  const deps: Record<string, string> = {
    ...(webFetchPkg.dependencies ?? {}),
    ...(serverPkg.dependencies ?? {}),
  };

  // createRequire shim so external modules resolve from the bundle's location
  const banner = `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`;

  await esbuild({
    entryPoints: [SERVER_SRC],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    external: EXTERNAL_MODULES,
    // grammy depends on abort-controller/node-fetch polyfills whose AbortSignal
    // class gets renamed by esbuild (AbortSignal → AbortSignal2), breaking
    // node-fetch's constructor.name check. keepNames preserves original names.
    // TODO: fork grammy or contribute upstream to drop polyfills (native since Node 18).
    keepNames: true,
    sourcemap: true,
    banner: { js: banner },
    // Inline the cast version so env.ts doesn't need to fs-read package.json
    // from a path that doesn't exist in the deploy layout.
    define: { __CAST_VERSION__: JSON.stringify(serverPkg.version) },
    outfile: path.join(outdir, 'index.js'),
  });

  // Aggregate per-extension manuals into packages/cast/manuals/extensions/
  // BEFORE copying the manuals tree — so the bundled dist/manuals/ carries
  // them too. Dev-server startup runs the same aggregation via
  // packages/cast/src/index.ts; this is the build-time equivalent.
  const aggregated = aggregateExtensionManuals({
    packagesDir: path.join(PROJECT_ROOT, 'packages'),
    manualsRoot: path.join(PROJECT_ROOT, 'packages', 'cast', 'manuals'),
    quiet: true,
  });
  console.log(`Aggregated ${aggregated.length} extension manual(s): ${aggregated.map((e) => e.name).join(', ')}`);

  // Transport manuals live at the canonical destination already — no copy
  // step. Build-time call mirrors the extension call for parity and so the
  // tree is validated before bundling.
  const aggregatedTransports = aggregateTransportManuals({
    manualsRoot: path.join(PROJECT_ROOT, 'packages', 'cast', 'manuals'),
    quiet: true,
  });
  console.log(`Aggregated ${aggregatedTransports.length} transport manual(s): ${aggregatedTransports.map((t) => t.name).join(', ')}`);

  // Copy console manuals alongside the bundled server. resolveManualsDir() in
  // packages/cast/src/console/index.ts locates them relative to the module path.
  const manualsSrc = path.join(PROJECT_ROOT, 'packages', 'cast', 'manuals');
  if (fs.existsSync(manualsSrc)) {
    const manualsDest = path.join(outdir, 'manuals');
    if (fs.existsSync(manualsDest)) fs.rmSync(manualsDest, { recursive: true });
    fs.cpSync(manualsSrc, manualsDest, { recursive: true });
    console.log(`Copied console manuals → ${manualsDest}/`);
  }

  // Copy the admin page manual alongside the bundled server.
  // resolveAdminManualPath() in packages/cast/src/console/shared/page-manual.ts
  // expects dist/admin-manual.json in prod. The web-ui's vite build emits this
  // via the admin-manual plugin.
  const adminManualSrc = path.join(PROJECT_ROOT, 'packages', 'web-ui', 'dist', 'admin-manual.json');
  if (fs.existsSync(adminManualSrc)) {
    fs.copyFileSync(adminManualSrc, path.join(outdir, 'admin-manual.json'));
    console.log(`Copied admin-manual.json → ${outdir}/admin-manual.json`);
  } else {
    console.warn('admin-manual.json not found in web-ui/dist — run `pnpm --filter @getcast/web-ui build` first.');
  }

  // Resolve external deps into node_modules at build time (not deploy time).
  // This uses npm in a temp dir, then copies the result into the output.
  const externalDeps: Record<string, string> = {};
  for (const mod of EXTERNAL_MODULES) {
    if (mod in deps) externalDeps[mod] = deps[mod];
  }

  if (Object.keys(externalDeps).length > 0) {
    // Write the manifest into outdir and npm-install against it in place.
    // This lets npm create node_modules/.bin/ symlinks with correct relative
    // targets — copying from a temp dir leaves them pointing at the temp path.
    const pkg = { name: 'cast-server', private: true, type: 'module', dependencies: externalDeps };
    fs.writeFileSync(path.join(outdir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

    const destNm = path.join(outdir, 'node_modules');
    if (fs.existsSync(destNm)) fs.rmSync(destNm, { recursive: true });

    console.log('Resolving external dependencies...');
    execSync('npm install --omit=dev', { cwd: outdir, stdio: 'pipe' });
  }

  // Version-tag the agent image alongside :latest, so release artifacts carry
  // provenance — humans inspecting the store see which release an image
  // accompanied. Plays no role in staleness detection (that's the
  // cast-agent:src-<hash> receipt build.mjs staples). Best-effort: skip
  // silently if the runtime isn't installed or doesn't have :latest (e.g.
  // fresh deploy machine). Must be `image tag`, not `tag` — Apple Container
  // has no top-level `tag` command.
  function tagIfPresent(runtime: string, version: string): void {
    try {
      execSync(`${runtime} image inspect cast-agent:latest`, { stdio: 'pipe' });
      execSync(`${runtime} image tag cast-agent:latest cast-agent:${version}`, { stdio: 'pipe' });
      console.log(`Tagged cast-agent:${version} on ${runtime}`);
    } catch {
      // runtime missing or :latest not present; nothing to tag
    }
  }
  tagIfPresent('container', serverPkg.version);
  tagIfPresent('docker', serverPkg.version);

  // Generate pm2 ecosystem file inside outdir (next to index.js and .env).
  // Data lives at ~/.cast/ by default (matches scripts/start.mjs and
  // scripts/dev.ts). Override by editing the generated ecosystem file or
  // setting CAST_AGENTS_DIR / CAST_CONFIG_DIR in pm2's env block.
  const dataRoot = path.join(homedir(), '.cast');
  const ecosystemPath = path.join(outdir, 'ecosystem.config.cjs');
  const ecosystem = `module.exports = {
  apps: [{
    name: '${pm2Name}',
    cwd: '${outdir}',
    script: './index.js',
    env: {
      CAST_AGENTS_DIR: '${path.join(dataRoot, 'agents')}',
      CAST_CONFIG_DIR: '${path.join(dataRoot, 'config')}',
      CAST_PORT: ${port},
      NODE_ENV: 'production',
    },
  }],
};
`;
  fs.writeFileSync(ecosystemPath, ecosystem);
  console.log(`Wrote ${ecosystemPath}`);

  const stat = fs.statSync(path.join(outdir, 'index.js'));
  console.log(`Done. Bundle: ${(stat.size / 1024).toFixed(0)} KB`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
