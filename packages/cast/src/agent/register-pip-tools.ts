/**
 * pip tool registrar — extracted from mcp-server.ts.
 *
 * Registered only when the agent's manifest declares `pip.allowed_packages`
 * (gates which packages can be installed). The on-disk manifest at
 * `home/.python-packages/.manifest.json` records installed-version metadata
 * for the agent; pip3 itself is the source of truth for actual files.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { z } from 'zod';

import { isToolDisabled } from '@getcast/agent-schema/v1';

import { textResult } from '../extensions/registry.js';
import { agentPath, CONTAINER_IMAGE, RUNTIME_BINARY } from '../config.js';
import { readText } from '../lib/config-reader.js';
import { parseJsonSafe } from '../lib/utils.js';
import { logger } from '../logger.js';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpAgentContext } from './mcp-server.js';

const execFileAsync = promisify(execFile);

const PipManifestSchema = z.record(
  z.string(),
  z.object({ version: z.string(), installed_at: z.string() }),
);
type PipManifest = z.infer<typeof PipManifestSchema>;

export function registerPipTools(server: McpServer, ctx: McpAgentContext): void {
  if (!ctx.pipConfig) return;

  const disabled = (name: string) => isToolDisabled(name, ctx.disabledTools ?? []);
  const pipAllowed = ctx.pipConfig.allowed_packages;
  const pipTargetDir = agentPath(ctx.agentFolder, 'home', '.python-packages');
  const pipManifestPath = path.join(pipTargetDir, '.manifest.json');

  function readPipManifest(): PipManifest {
    const raw = readText(pipManifestPath);
    if (!raw) return {};
    return parseJsonSafe(raw, PipManifestSchema) ?? {};
  }

  function writePipManifest(manifest: PipManifest): void {
    fs.mkdirSync(pipTargetDir, { recursive: true });
    fs.writeFileSync(pipManifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }

  const isPackageAllowed = (pkg: string): boolean =>
    pipAllowed.includes('*') || pipAllowed.includes(pkg);

  if (!disabled('pip__install')) server.tool(
    'pip__install',
    'Install a Python package. The package will be available to all Python scripts in current and future conversations via standard import.',
    {
      package: z.string().describe('Package name (e.g. "duckdb", "pandas")'),
      version: z.string().optional().describe('Version constraint (e.g. "1.2.0", ">=2.0", "<3.0,>=2.1")'),
      upgrade: z.boolean().optional().describe('Upgrade to latest version if already installed'),
    },
    async (args) => {
      const pkg = args.package.trim().toLowerCase();
      if (!pkg || /[;&|`$]/.test(pkg)) {
        return textResult('Invalid package name.', true);
      }
      if (!isPackageAllowed(pkg)) {
        return textResult(`Package "${pkg}" is not in the allowed list. Allowed: ${pipAllowed.join(', ')}`, true);
      }

      const manifest = readPipManifest();
      if (manifest[pkg] && !args.upgrade && !args.version) {
        return textResult(`${pkg} is already installed (version ${manifest[pkg].version}). Use upgrade: true to update.`);
      }

      const packageSpec = args.version ? `${pkg}${args.version.startsWith('>') || args.version.startsWith('<') || args.version.startsWith('=') || args.version.startsWith('!') ? args.version : `==${args.version}`}` : pkg;
      // Run pip inside a throwaway Linux container built from the agent image —
      // never on the host. This produces wheels for the container's platform
      // (the host may be macOS), and keeps arbitrary package build code out of
      // the host. The container mounts ONLY the output dir (no secrets) and is
      // the sole thing with network, so full egress is acceptable.
      //
      // Stronger variants (not implemented):
      //  - Scratch-dir isolation: mount an EMPTY dir as /out, host copies results
      //    back after, so a malicious LLM can't stage secrets into a folder the
      //    networked throwaway can read. (Cost: re-fetches shared deps.)
      //  - PyPI-only egress via an entrypoint.sh iptables pip-mode: more shell
      //    complexity, only partial coverage (DNS / request-path covert channels).
      const pipArgs = ['install', '--no-input', '--target', '/out', ...(args.upgrade ? ['--upgrade'] : []), packageSpec];

      try {
        fs.mkdirSync(pipTargetDir, { recursive: true });
        const { stdout, stderr } = await execFileAsync(
          RUNTIME_BINARY,
          ['run', '--rm', '--entrypoint', 'pip3', '-v', `${pipTargetDir}:/out`, CONTAINER_IMAGE, ...pipArgs],
          { timeout: 300_000 },
        );
        // Extract installed version from pip output (e.g. "Successfully installed duckdb-0.10.0")
        const versionMatch = (stdout + stderr).match(new RegExp(`${pkg}-([\\d.]+)`));
        const version = versionMatch?.[1] ?? manifest[pkg]?.version ?? 'unknown';
        manifest[pkg] = { version, installed_at: new Date().toISOString() };
        writePipManifest(manifest);
        logger.info({ agentFolder: ctx.agentFolder, package: pkg, version }, 'pip package installed');
        return textResult(`Installed ${pkg} ${version}. Available via \`import ${pkg}\` in Python scripts.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ agentFolder: ctx.agentFolder, package: pkg, error: msg }, 'pip install failed');
        ctx.agentDb?.logEvent('error', 'service', 'pip_install_failed', `pip install failed: ${pkg}`, {
          context: { package: pkg, error: msg },
        });
        return textResult(`pip install failed: ${msg.slice(-500)}`, true);
      }
    },
  );

  if (!disabled('pip__list')) server.tool(
    'pip__list',
    'List Python packages installed for this agent.',
    {},
    async () => {
      const manifest = readPipManifest();
      const entries = Object.entries(manifest);
      if (entries.length === 0) {
        return textResult('No Python packages installed. Use pip__install to add packages.');
      }
      const lines = entries.map(([name, info]) => `${name} ${info.version}`);
      return textResult(lines.join('\n'));
    },
  );
}
