/**
 * Bundle @getcast/ext-email into a self-contained dist/index.js.
 *
 * Externals (server provides shared instances at load time):
 *   - @getcast/extension-schema — contract surface
 *   - zod — schema interop
 *
 * Everything else (imapflow, nodemailer, mailparser, html-to-text, croner)
 * is inlined for a single drop-in artifact.
 */
import { build as esbuild } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const ENTRY = path.join(ROOT, 'src', 'index.ts');
const OUTFILE = path.join(ROOT, 'dist', 'index.js');

const EXTERNAL = ['@getcast/extension-schema', 'zod'];

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
