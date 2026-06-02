/**
 * Test harness for web-fetch.
 *
 * Usage:
 *   pnpm --filter @getcast/web-fetch test [url]              # fetch URL with Playwright
 *   pnpm --filter @getcast/web-fetch test --stdin             # read HTML from stdin
 *   pnpm --filter @getcast/web-fetch test --pipeline crawl4ai # select pipeline(s)
 *   pnpm --filter @getcast/web-fetch test --server-url http://localhost:3002  # POST to running server
 *   pnpm --filter @getcast/web-fetch test --regression        # run regression suite
 *   pnpm --filter @getcast/web-fetch test --no-cache [url]   # bypass cache, always fetch fresh
 *   pnpm --filter @getcast/web-fetch test --log              # print request log and exit
 */

import { parseArgs } from 'node:util';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { fetchPage, closeBrowser } from './browser.js';
import { initCache, cachedFetch, closeCache, getRequestLog } from './cache.js';
import { processHtml, processBinary } from './index.js';
import { classifyContentType, isBinaryCategory, extForCategory, extForMime } from './content-type.js';
import type { FetchResult } from './types.js';

const FetchResultSchema = z.object({
  meta: z.object({
    url: z.string(),
    title: z.string(),
    description: z.string(),
    contentType: z.string(),
    fetchedAt: z.string(),
    sizes: z.record(z.string(), z.object({ bytes: z.number(), tokens: z.number() })),
  }),
  files: z.record(z.string(), z.string()),
  encoding: z.enum(['base64']).optional(),
  ext: z.string().optional(),
});

const outDir = join(import.meta.dirname, '..', '.tmp', 'output');

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    stdin: { type: 'boolean', default: false },
    pipeline: { type: 'string', multiple: true },
    'server-url': { type: 'string' },
    regression: { type: 'boolean', default: false },
    'no-cache': { type: 'boolean', default: false },
    log: { type: 'boolean', default: false },
  },
});

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printResult(result: FetchResult): void {
  console.log();
  console.log('--- Meta ---');
  console.log(`URL: ${result.meta.url}`);
  if (result.meta.title) console.log(`Title: ${result.meta.title}`);
  if (result.meta.description) console.log(`Description: ${result.meta.description}`);
  console.log(`Content-Type: ${result.meta.contentType}`);
  console.log();

  console.log('--- Sizes ---');
  const rawTokens = result.meta.sizes['raw']?.tokens ?? 0;
  for (const [name, size] of Object.entries(result.meta.sizes)) {
    if (name === 'raw') {
      console.log(`  raw: ${size.tokens} tokens (${size.bytes} bytes)`);
    } else {
      const ratio = rawTokens > 0 ? ((size.tokens / rawTokens) * 100).toFixed(1) : '?';
      console.log(`  ${name}: ${size.tokens} tokens (${ratio}% of raw, ${size.bytes} bytes)`);
    }
  }
}

function writeOutputFiles(result: FetchResult): void {
  mkdirSync(outDir, { recursive: true });

  const isBinary = result.encoding === 'base64';

  for (const [name, content] of Object.entries(result.files)) {
    let filename: string;
    if (isBinary) {
      const ext = result.ext ?? 'bin';
      filename = `${name}.${ext}`;
      writeFileSync(join(outDir, filename), Buffer.from(content, 'base64'));
    } else {
      const category = classifyContentType(result.meta.contentType);
      const ext = name === 'content' ? extForCategory(category) : 'md';
      filename = `${name}.${ext}`;
      writeFileSync(join(outDir, filename), content);
    }
    console.log(`Wrote: ${filename}`);
  }

  console.log(`Output directory: ${outDir}`);
}

function printPreview(result: FetchResult, key: string, lines = 80): void {
  const content = result.files[key];
  if (!content) return;
  console.log();
  console.log(`--- ${key} (first ${lines} lines) ---`);
  const allLines = content.split('\n');
  console.log(allLines.slice(0, lines).join('\n'));
  if (allLines.length > lines) {
    console.log(`... (${allLines.length - lines} more lines)`);
  }
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function modeInline(url: string, pipelines: string[], noCache: boolean): Promise<void> {
  console.log(`Fetching: ${url}`);

  let page;
  if (noCache) {
    page = await fetchPage(url);
    console.log(`Rendered: ${page.html.length} chars, status ${page.statusCode}`);
  } else {
    const cached = await cachedFetch(url);
    console.log(
      `Rendered: ${cached.html.length} chars, status ${cached.statusCode} (cache ${cached.cacheHit ? 'hit' : 'miss'})`,
    );
    page = cached;
  }

  const category = classifyContentType(page.contentType);
  const result = isBinaryCategory(category)
    ? processBinary(page.html, page.url, page.contentType)
    : processHtml(page.html, page.url, page.contentType, { pipelines });
  printResult(result);
  writeOutputFiles(result);

  // Preview the first pipeline output (skip for binary)
  if (!result.encoding) {
    const previewKey = Object.keys(result.files)[0];
    if (previewKey) printPreview(result, previewKey);
  }
}

async function modeStdin(pipelines: string[]): Promise<void> {
  console.log('Reading HTML from stdin...');
  const html = readFileSync(0, 'utf-8');
  console.log(`Read ${html.length} chars from stdin`);

  const result = processHtml(html, 'stdin://', 'text/html', { pipelines });
  printResult(result);
  writeOutputFiles(result);

  const previewKey = Object.keys(result.files)[0];
  if (previewKey) printPreview(result, previewKey);
}

async function modeServer(url: string, pipelines: string[], serverUrl: string): Promise<void> {
  console.log(`POST ${serverUrl}/fetch → ${url}`);
  const body = JSON.stringify({ url, pipelines });
  const res = await fetch(`${serverUrl}/fetch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    console.error(`Server error ${res.status}: ${text}`);
    process.exit(1);
  }

  const result = FetchResultSchema.parse(await res.json());
  printResult(result);

  const previewKey = Object.keys(result.files)[0];
  if (previewKey) printPreview(result, previewKey);
}

type RegressionCase = {
  name: string;
  url: string;
  expectCategory: string;
  tokenRange: [number, number];
};

const REGRESSION_CASES: RegressionCase[] = [
  {
    name: 'Wikipedia (HTML)',
    url: 'https://en.wikipedia.org/wiki/Web_scraping',
    expectCategory: 'html',
    tokenRange: [5_000, 50_000],
  },
  {
    name: 'httpbin JSON',
    url: 'https://httpbin.org/json',
    expectCategory: 'json',
    tokenRange: [30, 500],
  },
  {
    name: 'httpbin robots.txt',
    url: 'https://httpbin.org/robots.txt',
    expectCategory: 'text',
    tokenRange: [1, 100],
  },
];

async function modeRegression(noCache: boolean): Promise<void> {
  let passed = 0;
  let failed = 0;

  for (const tc of REGRESSION_CASES) {
    process.stdout.write(`${tc.name}... `);
    try {
      const page = noCache ? await fetchPage(tc.url) : await cachedFetch(tc.url);
      const category = classifyContentType(page.contentType);

      if (category !== tc.expectCategory) {
        console.log(`FAIL (expected ${tc.expectCategory}, got ${category})`);
        failed++;
        continue;
      }

      const pipelines = category === 'html' ? ['crawl4ai'] : undefined;
      const result = isBinaryCategory(category)
        ? processBinary(page.html, page.url, page.contentType)
        : processHtml(page.html, page.url, page.contentType, { pipelines });
      const key = Object.keys(result.files)[0];
      const tokens = key ? (result.meta.sizes[key]?.tokens ?? 0) : 0;
      const [lo, hi] = tc.tokenRange;

      if (tokens < lo || tokens > hi) {
        console.log(`FAIL (${tokens} tokens, expected ${lo}–${hi})`);
        failed++;
      } else {
        console.log(`OK (${tokens} tokens)`);
        passed++;
      }
    } catch (err) {
      console.log(`FAIL (${String(err).slice(0, 100)})`);
      failed++;
    }
  }

  console.log();
  console.log(`Regression: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function modeLog(): Promise<void> {
  const entries = getRequestLog();
  if (entries.length === 0) {
    console.log('No requests logged.');
    return;
  }
  for (const e of entries) {
    const hit = e.cache_hit ? 'HIT' : 'MISS';
    console.log(`[${e.requested_at}] ${hit}  ${e.url}`);
  }
  console.log(`\n${entries.length} entries`);
}

async function main(): Promise<void> {
  const pipelines = values.pipeline ?? ['markdown', 'crawl4ai'];
  const noCache = values['no-cache'] ?? false;

  const cacheDbPath = join(import.meta.dirname, '..', '.tmp', 'cache.db');
  initCache({ dbPath: cacheDbPath });

  try {
    if (values.log) {
      await modeLog();
    } else if (values.regression) {
      await modeRegression(noCache);
    } else if (values.stdin) {
      await modeStdin(pipelines);
    } else if (values['server-url']) {
      const serverUrl = values['server-url'];
      const url = positionals[0] ?? 'https://en.wikipedia.org/wiki/Web_scraping';
      await modeServer(url, pipelines, serverUrl);
    } else {
      const url = positionals[0] ?? 'https://en.wikipedia.org/wiki/Web_scraping';
      await modeInline(url, pipelines, noCache);
    }
  } finally {
    closeCache();
    await closeBrowser();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
