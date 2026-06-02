/**
 * cast-services client — the only file that talks to api.getcast.dev.
 *
 * Privacy contract: every request is exactly
 *   GET <BASE><path>?current=<semver>
 *   User-Agent: cast/<semver>
 * Nothing else goes on the wire — no install ID, no inventory, no auth,
 * no cookies, no body. The privacy claim is auditable by reading this file.
 *
 * Fallback ladder (each call):
 *   live fetch → last in-process response → embedded snapshot
 *
 * Snapshots live at packages/cast/snapshots/{models,version}.json and
 * are refreshed by `pnpm sync:snapshots` before each release. Schema mismatch in
 * a snapshot crashes startup — deliberate, snapshot drift is a
 * release-blocker.
 *
 * Disable flags (see env.ts):
 *   CAST_DISABLE_UPDATE_CHECK    — skip updates only
 *   CAST_DISABLE_MODEL_REFRESH   — skip models only
 *
 * Wire contract: cast-services/CLIENT.md (private repo).
 */
import { z } from 'zod';

import { env } from '../env.js';

// Snapshots baked in via static JSON import — esbuild inlines them into the
// bundle so there's no runtime fs path resolution to break. Dev (tsx) and
// tsc-compiled output both resolve the relative path to packages/cast/snapshots/.
import modelsRaw from '../../snapshots/models.json' with { type: 'json' };
import versionRaw from '../../snapshots/version.json' with { type: 'json' };

const BASE = 'https://api.getcast.dev';
const MODELS_PATH = '/api/models';
const UPDATES_PATH = '/api/updates';

const TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 250;
const MODELS_MEMO_MS = 10 * 60 * 1000;

// --- Schemas (boundary validation; tolerate unknown fields per CLIENT.md) ---

const ModelSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  created_at: z.string(),
  max_input_tokens: z.number(),
});

const ModelsResponseSchema = z.object({
  data: z.array(ModelSchema),
  oneMSupported: z.array(z.string()),
});

const UpdateResponseSchema = z.looseObject({
  latest: z.string(),
});

export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;
export type UpdateResponse = z.infer<typeof UpdateResponseSchema>;

// --- Snapshots (validated once at module init; drift crashes startup deliberately) ---

const MODELS_SNAPSHOT = ModelsResponseSchema.parse(modelsRaw);
const VERSION_SNAPSHOT = UpdateResponseSchema.parse(versionRaw);

// --- In-process memo for models (updates is gated by the orchestrator's 24h timer) ---
// SIDE EFFECT: Module-level memo. Re-fetching on every admin-picker open
// would waste a CDN-cacheable request and slow the UI. The 10-min TTL aligns
// with the CDN+origin cache horizon (~35 min effective freshness).

let modelsCache: { at: number; data: ModelsResponse } | null = null;

// --- Chokepoint fetch: timeout + 1 retry on 5xx/network; never on 4xx ---

type FetchOutcome =
  | { ok: true; body: unknown }
  | { ok: false; retriable: boolean };

async function tryFetch(url: string): Promise<FetchOutcome> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url}?current=${encodeURIComponent(env.version)}`, {
      signal: ac.signal,
      headers: { 'user-agent': `cast/${env.version}` },
    });
    if (!res.ok) return { ok: false, retriable: res.status >= 500 };
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false, retriable: true }; // network/abort — retriable
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOnce(url: string): Promise<unknown | null> {
  const first = await tryFetch(url);
  if (first.ok) return first.body;
  if (!first.retriable) return null;
  await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  const second = await tryFetch(url);
  return second.ok ? second.body : null;
}

// --- Public API ---

export async function fetchModels(): Promise<ModelsResponse> {
  if (env.CAST_DISABLE_MODEL_REFRESH) {
    return modelsCache?.data ?? MODELS_SNAPSHOT;
  }
  if (modelsCache && Date.now() - modelsCache.at < MODELS_MEMO_MS) return modelsCache.data;

  const body = await fetchOnce(`${BASE}${MODELS_PATH}`);
  const parsed = body !== null ? ModelsResponseSchema.safeParse(body) : null;
  if (parsed?.success) {
    modelsCache = { at: Date.now(), data: parsed.data };
    return parsed.data;
  }
  return modelsCache?.data ?? MODELS_SNAPSHOT;
}

export async function fetchUpdates(): Promise<UpdateResponse> {
  if (env.CAST_DISABLE_UPDATE_CHECK) return VERSION_SNAPSHOT;

  const body = await fetchOnce(`${BASE}${UPDATES_PATH}`);
  const parsed = body !== null ? UpdateResponseSchema.safeParse(body) : null;
  return parsed?.success ? parsed.data : VERSION_SNAPSHOT;
}

// --- Update status (orchestrator polls at startup + every 24h; UI reads via tRPC) ---

// `url` is an optional per-release link the manifest may carry (the wire
// schema is looseObject, so adding it later is non-breaking). pollUpdates
// does not populate it today; the dashboard banner falls back to the
// canonical /docs/updating page when it's absent.
export type UpdateStatus = { current: string; latest: string; available: boolean; url?: string };

// SIDE EFFECT: Single process-local cell holding the most recent update check
// result. The orchestrator owns the timer and writes via pollUpdates(); the
// admin tRPC reads via getUpdateStatus(). Pure approach would require passing
// the cell through every layer, defeating the single-source claim.
let updateStatus: UpdateStatus | null = null;

function parseVer(v: string): [number, number, number] {
  const parts = v.split('.').map((p) => parseInt(p, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function isNewerVersion(latest: string, current: string): boolean {
  const [a, b, c] = parseVer(latest);
  const [x, y, z] = parseVer(current);
  return a > x || (a === x && (b > y || (b === y && c > z)));
}

export async function pollUpdates(): Promise<UpdateStatus> {
  const { latest } = await fetchUpdates();
  updateStatus = { current: env.version, latest, available: isNewerVersion(latest, env.version) };
  return updateStatus;
}

export function getUpdateStatus(): UpdateStatus | null {
  return updateStatus;
}
