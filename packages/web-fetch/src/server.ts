/**
 * Standalone HTTP server for web-fetch.
 *
 * POST /fetch  — fetch a URL, process it, return FetchResult as JSON.
 * GET  /health — liveness check.
 * GET  /log    — recent request log with cache hit/miss status.
 *
 * Lifecycle:
 *   1. Preflight check (chromium binary exists) — exits immediately if missing
 *   2. Bind port, health endpoint available
 *   3. Lazy init on first /fetch (cache, browser launched on demand by browser.ts)
 */

import fs from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { z } from 'zod';
import { closeBrowser } from './browser.js';
import { initCache, cachedFetch, closeCache, getRequestLog } from './cache.js';
import { classifyContentType, isBinaryCategory } from './content-type.js';
import { processHtml, processBinary } from './index.js';
import { validateFetchUrl } from './url-validation.js';

// ---------------------------------------------------------------------------
// Preflight check
// ---------------------------------------------------------------------------

function checkChromium(): boolean {
  try {
    return fs.existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lazy init
// ---------------------------------------------------------------------------

// SIDE EFFECT: Lazy init flag — cache is initialized on first /fetch request,
// not at startup. Keeps the server lightweight until actually needed (health
// endpoint works immediately without dependencies).
let initialized = false;

function ensureInit(): void {
  if (initialized) return;
  initCache({ dbPath: join(import.meta.dirname, '..', '.tmp', 'cache.db') });
  initialized = true;
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

const FetchRequestSchema = z.object({
  url: z.string().url(),
  pipelines: z.array(z.string()).optional(),
  timeout: z.number().positive().optional(),
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleFetch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  ensureInit();

  const raw = await readBody(req);

  let parsed: z.infer<typeof FetchRequestSchema>;
  try {
    parsed = FetchRequestSchema.parse(JSON.parse(raw));
  } catch (err) {
    json(res, 400, { error: 'Invalid request', details: String(err) });
    return;
  }

  try {
    validateFetchUrl(parsed.url);
  } catch (err) {
    json(res, 400, { error: 'URL validation failed', details: String(err) });
    return;
  }

  let page;
  try {
    page = await cachedFetch(parsed.url, { timeout: parsed.timeout });
  } catch (err) {
    const message = String(err);
    if (message.includes('Response too large')) {
      json(res, 413, { error: 'Response too large', url: parsed.url, details: message });
      return;
    }
    if (message.includes('Timeout')) {
      json(res, 504, { error: 'Navigation timeout', url: parsed.url });
    } else {
      json(res, 502, { error: 'Navigation failed', url: parsed.url, details: message });
    }
    return;
  }

  const category = classifyContentType(page.contentType);
  if (isBinaryCategory(category)) {
    const result = processBinary(page.html, page.url, page.contentType);
    json(res, 200, result);
    return;
  }

  const result = processHtml(page.html, page.url, page.contentType, {
    pipelines: parsed.pipelines,
  });

  json(res, 200, result);
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const PORT = Number(process.env['PORT'] ?? '0'); // 0 = pick random available port

// Preflight: exit early if chromium is not installed.
if (!checkChromium()) {
  console.error('web-fetch: Playwright chromium not installed. Run: npx playwright install chromium');
  process.exit(1);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      json(res, 200, { service: 'web-fetch', version: '0.1.0' });
    } else if (req.method === 'GET' && req.url === '/log') {
      ensureInit();
      json(res, 200, getRequestLog());
    } else if (req.method === 'POST' && req.url === '/fetch') {
      await handleFetch(req, res);
    } else {
      json(res, 404, { error: 'Not found' });
    }
  } catch (err) {
    json(res, 500, { error: 'Internal error', details: String(err) });
  }
});

async function shutdown(): Promise<void> {
  console.log('Shutting down...');
  if (initialized) closeCache();
  await closeBrowser();
  server.close();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.listen(PORT, () => {
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : PORT;
  console.log(`web-fetch server listening on :${actualPort}`);
  // Report port to parent via IPC (used when PORT=0 for dynamic port assignment)
  if (process.send) {
    process.send({ type: 'ready', port: actualPort });
  }
});
