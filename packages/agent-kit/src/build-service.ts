import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import * as p from '@clack/prompts';
import { build as esbuild } from 'esbuild';
import { z } from 'zod';

import { AGENT_KIT_ROOT, PROJECT_ROOT } from './paths.js';
import { writeJson } from './helpers.js';

const PackageJsonSchema = z.object({
  name: z.string().optional(),
  dependencies: z.record(z.string(), z.string()).default({}),
  pnpm: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

/** Known native modules that cannot be bundled by esbuild. */
const NATIVE_MODULES = ['better-sqlite3'];

/**
 * Resolve a workspace package by its npm name.
 * Scans `packages/` directories for a matching `package.json` name field.
 * Returns the absolute path to the package directory, or null if not found.
 */
function resolveWorkspacePackage(name: string): string | null {
  const packagesDir = path.join(PROJECT_ROOT, 'packages');
  if (!fs.existsSync(packagesDir)) return null;
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgJson = path.join(packagesDir, entry.name, 'package.json');
    if (!fs.existsSync(pkgJson)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'));
      if (data.name === name) return path.join(packagesDir, entry.name);
    } catch { continue; }
  }
  return null;
}

/**
 * Bundle a template's service source into a self-contained index.js via esbuild.
 * Skips if the template has no service/src/index.ts.
 */
export async function buildService(templateServiceDir: string, outputServiceDir: string): Promise<void> {
  const entryPoint = path.join(templateServiceDir, 'src', 'index.ts');
  if (!fs.existsSync(entryPoint)) return;

  // Clean rebuild — secrets (.env, credentials.json) live in service/ (separate dir),
  // so the bundle output dir can be wiped without preserving runtime files.
  if (fs.existsSync(outputServiceDir)) {
    fs.rmSync(outputServiceDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outputServiceDir, { recursive: true });

  // Determine which native modules are actually used
  const templatePkgPath = path.join(templateServiceDir, 'package.json');
  const templatePkg = fs.existsSync(templatePkgPath)
    ? PackageJsonSchema.parse(JSON.parse(fs.readFileSync(templatePkgPath, 'utf-8')))
    : PackageJsonSchema.parse({});
  const deps: Record<string, string> = templatePkg.dependencies;
  const externals = NATIVE_MODULES.filter((m) => m in deps);

  // Separate workspace packages from registry packages.
  // Workspace packages are resolved via esbuild alias to their source .ts files.
  // Their transitive dependencies are merged into the registry deps for the temp install.
  const workspaceAliases: Record<string, string> = {};
  const registryDeps: Record<string, string> = {};
  let pnpmOverrides = templatePkg.pnpm;

  for (const [name, version] of Object.entries(deps)) {
    if (typeof version === 'string' && version.startsWith('workspace:')) {
      const srcPath = resolveWorkspacePackage(name);
      if (srcPath) {
        const wsPkg = JSON.parse(fs.readFileSync(path.join(srcPath, 'package.json'), 'utf-8'));

        // Resolve the package's root entry point for esbuild alias
        const exportsEntry = typeof wsPkg.exports === 'string'
          ? wsPkg.exports
          : wsPkg.exports?.['.'] ?? './src/index.ts';
        workspaceAliases[name] = path.resolve(srcPath, exportsEntry);

        // Merge transitive deps from the workspace package
        const wsDeps: Record<string, string> = wsPkg.dependencies ?? {};
        for (const [depName, depVer] of Object.entries(wsDeps)) {
          if (!(depName in registryDeps)) registryDeps[depName] = depVer;
        }
        // Merge pnpm overrides from workspace packages
        if (wsPkg.pnpm) pnpmOverrides = { ...pnpmOverrides, ...wsPkg.pnpm };
      }
    } else {
      registryDeps[name] = version as string; // version is string here — Object.entries loses literal type
    }
  }

  // Install registry deps in a temp dir with --ignore-workspace so esbuild gets
  // real node_modules (not pnpm symlinks which break package.json exports resolution)
  const buildTmpDir = path.join(AGENT_KIT_ROOT, '.tmp', `build-${Date.now()}`);
  fs.mkdirSync(buildTmpDir, { recursive: true });
  writeJson(path.join(buildTmpDir, 'package.json'), {
    name: 'build-tmp', private: true, type: 'module',
    dependencies: registryDeps,
    ...(pnpmOverrides ? { pnpm: pnpmOverrides } : {}),
  });
  execSync('pnpm install --ignore-workspace', { cwd: buildTmpDir, stdio: 'pipe' });

  // esbuild bundle — resolve registry deps from the temp dir's real node_modules,
  // resolve workspace packages via alias to their source .ts files
  const createRequireShim = `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`;
  try {
    await esbuild({
      entryPoints: [entryPoint],
      bundle: true,
      platform: 'node',
      target: 'node20',
      format: 'esm',
      external: externals,
      sourcemap: true,
      banner: { js: createRequireShim },
      outfile: path.join(outputServiceDir, 'index.js'),
      nodePaths: [path.join(buildTmpDir, 'node_modules')],
      ...(Object.keys(workspaceAliases).length > 0 ? { alias: workspaceAliases } : {}),
    });
  } finally {
    fs.rmSync(buildTmpDir, { recursive: true, force: true });
  }

  // Copy manifest.json (strip `entry` — stamped bundles always use index.js)
  const manifestSrc = path.join(templateServiceDir, 'manifest.json');
  if (fs.existsSync(manifestSrc)) {
    const raw = JSON.parse(fs.readFileSync(manifestSrc, 'utf-8'));
    delete raw.entry;
    fs.writeFileSync(path.join(outputServiceDir, 'manifest.json'), JSON.stringify(raw, null, 2) + '\n');
  }

  // Write minimal package.json listing only native deps and install them
  if (externals.length > 0) {
    const minimalDeps: Record<string, string> = {};
    for (const ext of externals) minimalDeps[ext] = deps[ext]!; // ext filtered from deps keys above
    const minimalPkg = {
      name: `${templatePkg.name ?? 'agent-service'}-bundle`,
      private: true,
      type: 'module',
      dependencies: minimalDeps,
      ...(templatePkg.pnpm ? { pnpm: templatePkg.pnpm } : {}),
    };
    writeJson(path.join(outputServiceDir, 'package.json'), minimalPkg);

    p.log.step('Installing native service dependencies...');
    execSync('pnpm install --ignore-workspace', {
      cwd: outputServiceDir,
      stdio: 'pipe',
    });
    // pnpm install always writes a lockfile — remove it from the production bundle
    fs.rmSync(path.join(outputServiceDir, 'pnpm-lock.yaml'), { force: true });
  }

  // Checksum for staleness detection
  const bundleContent = fs.readFileSync(path.join(outputServiceDir, 'index.js'));
  const checksum = createHash('sha256').update(bundleContent).digest('hex');
  fs.writeFileSync(path.join(outputServiceDir, 'checksum.txt'), checksum + '\n');

  p.log.step('Service bundled');
}

/** Compute SHA-256 checksum of a service bundle built from a template's source to a temp dir. */
export async function computeTemplateServiceChecksum(templateServiceDir: string): Promise<string | null> {
  const entryPoint = path.join(templateServiceDir, 'src', 'index.ts');
  if (!fs.existsSync(entryPoint)) return null;

  const tmpDir = path.join(AGENT_KIT_ROOT, '.tmp', `check-${Date.now()}`);
  try {
    await buildService(templateServiceDir, tmpDir);
    const checksumPath = path.join(tmpDir, 'checksum.txt');
    return fs.existsSync(checksumPath) ? fs.readFileSync(checksumPath, 'utf-8').trim() : null;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
