/**
 * Type-check an agent service.
 *
 * A service is an independent package whose dependency closure is NOT the
 * workspace's (workspace deps export source .ts; registry deps may differ in
 * version; @types/node and service-only deps aren't reachable from the agent
 * folder). esbuild and tsx both strip types without checking, so nothing
 * type-checks a service unless you do it explicitly.
 *
 * This mirrors how buildService (packages/agent-kit/src/build-service.ts)
 * resolves deps for esbuild, but runs `tsc` instead: workspace packages are
 * aliased to their source entry via tsconfig `paths`; registry deps (+ @types/
 * node) are installed real with `--ignore-workspace` (pnpm symlinks break
 * package `exports` resolution); the service `src/*.ts` is copied beside that
 * node_modules so normal resolution finds everything.
 *
 * Usage:  pnpm tsx scripts/check-service.mts <path-to/blueprint/service>
 *
 * A service-only dep that ships without bundled types can be covered by dropping
 * a one-line `declare module` .d.ts into the service's src/ (it gets copied in).
 */
import os from 'os';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Resolve a workspace package to its directory by scanning packages/ for the name. */
function resolveWorkspacePackage(name: string): string | null {
  const dir = path.join(PROJECT_ROOT, 'packages');
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const pj = path.join(dir, e.name, 'package.json');
    if (!fs.existsSync(pj)) continue;
    try { if (JSON.parse(fs.readFileSync(pj, 'utf-8')).name === name) return path.join(dir, e.name); } catch { /* skip */ }
  }
  return null;
}

const serviceDir = process.argv[2];
if (!serviceDir || !fs.existsSync(path.join(serviceDir, 'src', 'index.ts'))) {
  console.error('usage: pnpm tsx scripts/check-service.mts <path-to/blueprint/service>');
  process.exit(2);
}

const deps: Record<string, string> = JSON.parse(fs.readFileSync(path.join(serviceDir, 'package.json'), 'utf-8')).dependencies ?? {};
const registry: Record<string, string> = {};
const paths: Record<string, string[]> = {};
for (const [name, version] of Object.entries(deps)) {
  if (typeof version === 'string' && version.startsWith('workspace:')) {
    const src = resolveWorkspacePackage(name);
    if (!src) throw new Error(`unresolved workspace dep ${name}`);
    const wp = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf-8'));
    const entry = typeof wp.exports === 'string' ? wp.exports : wp.exports?.['.'] ?? './src/index.ts';
    paths[name] = [path.resolve(src, entry)];
  } else {
    registry[name] = version;
  }
}
registry['@types/node'] ??= '^22';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'check-service-'));
try {
  fs.mkdirSync(path.join(tmp, 'src'));
  for (const f of fs.readdirSync(path.join(serviceDir, 'src'))) {
    if (f.endsWith('.ts')) fs.copyFileSync(path.join(serviceDir, 'src', f), path.join(tmp, 'src', f));
  }
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'check-service-tmp', private: true, type: 'module', dependencies: registry }, null, 2));
  fs.writeFileSync(path.join(tmp, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', lib: ['ES2022'],
      strict: true, esModuleInterop: true, skipLibCheck: true, noEmit: true,
      resolveJsonModule: true, allowImportingTsExtensions: true,
      baseUrl: '.', paths, types: ['node'],
    },
    include: ['src/**/*.ts'],
  }, null, 2));

  console.error(`[check-service] installing ${Object.keys(registry).join(', ')} + aliasing ${Object.keys(paths).join(', ') || '(none)'}`);
  execSync('pnpm install --ignore-workspace --silent', { cwd: tmp, stdio: 'inherit' });
  execSync(`${PROJECT_ROOT}/node_modules/.bin/tsc -p ${path.join(tmp, 'tsconfig.json')}`, { stdio: 'inherit' });
  console.log('✅ type-check passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
