/**
 * Central environment configuration — validates all env vars at startup.
 *
 * Single config file: .env in cwd (persistent across rebundles).
 * process.env values from the supervisor or shell override .env.
 *
 *   env     — operational config (ports, paths, limits)
 *   secrets — credentials (auth mode, API keys) — never in process.env
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

// --- Read .env (parsed, not loaded into process.env) ---

function readDotEnv(): Record<string, string> {
  try {
    return dotenv.parse(fs.readFileSync(path.join(process.cwd(), '.env'), 'utf-8'));
  } catch {
    return {};
  }
}

const dotEnv = readDotEnv();

// Merge: process.env wins over .env (ecosystem config / shell overrides file).
const merged: Record<string, string | undefined> = { ...dotEnv, ...process.env };

// --- Helpers ---

/** Parse a string env var as integer; return undefined for missing/empty so Zod .default() kicks in. */
function intPreprocess(v: unknown): number | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? NaN : n; // NaN → Zod rejects with clear error
}

function strPreprocess(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

const envInt = (fallback: number) =>
  z.preprocess(intPreprocess, z.number().int().default(fallback));

const envStr = (fallback: string) =>
  z.preprocess(strPreprocess, z.string().default(fallback));

const envStrOpt = () =>
  z.preprocess(strPreprocess, z.string().optional());

const envIntOpt = () =>
  z.preprocess(intPreprocess, z.number().int().optional());

const envBool = (fallback: boolean) =>
  z.preprocess(strPreprocess, z.stringbool().default(fallback));

// --- Package version (inlined by esbuild in bundle; read from package.json in dev) ---
//
// In the bundled server (scripts/build-server.ts), esbuild replaces
// __CAST_VERSION__ with the literal version string at build time. In dev
// (tsx) and plain tsc output, that define isn't applied and the value falls
// back to typeof === 'undefined', triggering the fs read path. The two
// cast-package-relative candidates cover both src/env.ts (tsx) and
// dist/env.js (tsc).

declare const __CAST_VERSION__: string | undefined;

function readPackageVersion(): string {
  if (typeof __CAST_VERSION__ === 'string') return __CAST_VERSION__;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkg: { version: string } = JSON.parse(
    fs.readFileSync(path.join(here, '..', 'package.json'), 'utf-8'),
  );
  return pkg.version;
}

// --- Operational config (from merged .env + process.env) ---

const EnvSchema = z.object({
  CAST_AGENTS_DIR: z.string({ error: 'CAST_AGENTS_DIR is required — set it to the directory containing agent instances' }),
  CAST_CONFIG_DIR: z.string({ error: 'CAST_CONFIG_DIR is required — set it to the directory for server config and databases' }),
  CAST_RUNTIME: z.preprocess(strPreprocess, z.enum(['auto', 'docker', 'apple-container']).default('auto')),
  CONTAINER_IMAGE: envStr('cast-agent:latest'),
  CONTAINER_TIMEOUT: envInt(1_800_000),
  CONTAINER_MAX_OUTPUT_SIZE: envInt(10_485_760),
  IDLE_TIMEOUT: envInt(1_800_000),
  MAX_CONCURRENT_CONTAINERS: envInt(3).pipe(z.number().int().min(1)),
  TZ: envStrOpt(),
  CAST_PORT: envInt(5050),
  // Public web UI port. In the standard two-process layout (pnpm dev/start) the
  // web UI runs here and proxies to CAST_PORT — it's the only port operators
  // open. Set by the orchestrator scripts so the startup banner advertises the
  // right URL; unset when the server runs standalone (banner falls back to CAST_PORT).
  CAST_WEB_PORT: envIntOpt(),
  MAX_ATTACHMENT_MB: envInt(10),
  // cast-services client flags (see packages/cast/src/lib/cast-services.ts)
  CAST_DISABLE_UPDATE_CHECK: envBool(false),
  CAST_DISABLE_MODEL_REFRESH: envBool(false),
});

export const env = { ...EnvSchema.parse(merged), version: readPackageVersion() };

// --- Secrets (from .env only — never in process.env) ---

const SecretsSchema = z.object({
  AUTH_MODE: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  CLAUDE_CODE_OAUTH_TOKEN: z.string().optional(),
});

type Secrets = z.infer<typeof SecretsSchema>;

export const secrets: Secrets = SecretsSchema.parse(dotEnv);

/** Re-read `.env` and update the exported `secrets` object in place.
 *  Called after `updateCredentials` writes the file so `resolveAuth()` (which
 *  reads from this object) sees the new values without restarting the server.
 *  Mutates `secrets` rather than reassigning the binding so existing
 *  importers don't see a stale reference. */
export function reloadSecrets(): void {
  const fresh = SecretsSchema.parse(readDotEnv());
  for (const key of Object.keys(secrets) as (keyof Secrets)[]) {
    delete secrets[key];
  }
  Object.assign(secrets, fresh);
}
