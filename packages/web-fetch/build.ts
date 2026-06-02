/**
 * Bundle @getcast/web-fetch's subprocess entry into a self-contained dist/server.js.
 *
 * Externals (must be resolvable at deploy time from an adjacent node_modules):
 *   - better-sqlite3 — native addon
 *   - playwright — dynamic imports + browser binaries
 *   - tiktoken — WASM loaded via fs.readFileSync from package dir
 *
 * Cast's server build copies dist/server.js into its deploy directory and
 * installs these externals alongside. @getcast/web-fetch can also be run
 * standalone: `node dist/server.js` in a directory with the externals
 * installed.
 */
import { build as esbuild } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const ENTRY = path.join(ROOT, 'src', 'server.ts');
const OUTFILE = path.join(ROOT, 'dist', 'server.js');

const EXTERNAL = ['better-sqlite3', 'playwright', 'tiktoken'];

async function main(): Promise<void> {
  fs.mkdirSync(path.dirname(OUTFILE), { recursive: true });

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
  console.log(`Wrote ${OUTFILE} (${(size / 1024).toFixed(0)} KB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
