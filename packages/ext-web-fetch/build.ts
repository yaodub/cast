/**
 * Bundle @getcast/ext-web-fetch into a self-contained dist/.
 *
 * Two artifacts:
 *   dist/index.js              — extension entry (esbuild)
 *   dist/web-fetch-server.js   — subprocess (copied from @getcast/web-fetch's own build)
 *
 * At runtime, the extension's resolveServerEntry() falls back to
 * `path.join(import.meta.dirname, 'web-fetch-server.js')` when the workspace
 * resolution fails — which is exactly the dynamic-load case.
 *
 * Externals (server provides shared instances at load time):
 *   - @getcast/extension-schema — contract surface
 *   - zod — schema interop
 *
 * The subprocess (web-fetch-server.js) carries its own externals:
 * better-sqlite3, playwright, tiktoken. They must be resolvable from the
 * subprocess's location at runtime — same constraint as the cast server's
 * own deploy.
 */
import { build as esbuild } from 'esbuild';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const ENTRY = path.join(ROOT, 'src', 'index.ts');
const OUTFILE = path.join(ROOT, 'dist', 'index.js');
const WEB_FETCH_PKG = path.resolve(ROOT, '..', 'web-fetch');
const WEB_FETCH_BUILT = path.join(WEB_FETCH_PKG, 'dist', 'server.js');
const WEB_FETCH_DEST = path.join(ROOT, 'dist', 'web-fetch-server.js');

const EXTERNAL = ['@getcast/extension-schema', 'zod'];

async function main(): Promise<void> {
  fs.mkdirSync(path.dirname(OUTFILE), { recursive: true });

  console.log('Building @getcast/web-fetch subprocess...');
  execSync('pnpm --filter @getcast/web-fetch build', {
    cwd: path.resolve(ROOT, '..', '..'),
    stdio: 'inherit',
  });

  if (!fs.existsSync(WEB_FETCH_BUILT)) {
    throw new Error(`Expected ${WEB_FETCH_BUILT} after web-fetch build`);
  }

  fs.copyFileSync(WEB_FETCH_BUILT, WEB_FETCH_DEST);
  const mapSrc = WEB_FETCH_BUILT + '.map';
  if (fs.existsSync(mapSrc)) {
    fs.copyFileSync(mapSrc, WEB_FETCH_DEST + '.map');
  }
  console.log(`Copied subprocess → ${WEB_FETCH_DEST}`);

  const banner = `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`;

  await esbuild({
    entryPoints: [ENTRY],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    external: EXTERNAL,
    keepNames: true,
    sourcemap: true,
    banner: { js: banner },
    outfile: OUTFILE,
  });

  const size = fs.statSync(OUTFILE).size;
  const subSize = fs.statSync(WEB_FETCH_DEST).size;
  console.log(`Wrote ${OUTFILE} (${(size / 1024).toFixed(0)} KB)`);
  console.log(`Wrote ${WEB_FETCH_DEST} (${(subSize / 1024).toFixed(0)} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
