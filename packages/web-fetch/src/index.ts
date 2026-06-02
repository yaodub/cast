/**
 * @getcast/web-fetch — public API.
 *
 * Core functions for fetching, cleaning, and converting web content.
 * The server (socket/HTTP) and browser management are separate concerns.
 */

export { validateFetchUrl } from './url-validation.js';
export { pruneHtml } from './pruning.js';
export type { PruningConfig } from './pruning.js';
export { convertLinksToCitations } from './citations.js';
export type { CitationResult, CitationRef } from './citations.js';
export { extractMetadata } from './metadata.js';
export { countTokens } from './tokens.js';
export { classifyContentType, extForCategory, isBinaryCategory, extForMime } from './content-type.js';
export type { ContentCategory } from './content-type.js';
export { markdownPipeline, crawl4aiPipeline } from './pipelines/index.js';
export type { Pipeline, PipelineResult, PageMeta, SizeInfo, FetchResult } from './types.js';
export {
  initCache,
  cachedFetch,
  closeCache,
  getRequestLog,
  evictUrl,
  evictExpired,
  parseCacheControlMaxAge,
  _initTestCache,
} from './cache.js';
export type { CacheConfig, CachedFetchOptions, RequestLogEntry } from './cache.js';

import { classifyContentType, extForMime } from './content-type.js';
import { extractMetadata } from './metadata.js';
import { countTokens } from './tokens.js';
import { markdownPipeline, crawl4aiPipeline } from './pipelines/index.js';
import type { Pipeline, PageMeta, SizeInfo, FetchResult } from './types.js';

/** Built-in pipeline registry. */
const PIPELINES: Record<string, Pipeline> = {
  markdown: markdownPipeline,
  crawl4ai: crawl4aiPipeline,
};

export type ProcessOptions = {
  /** Which pipelines to run (default: ["crawl4ai"]). */
  pipelines?: string[];
  /** Additional custom pipelines. */
  customPipelines?: Record<string, Pipeline>;
};

/**
 * Process raw content through the requested pipelines.
 * Does NOT fetch — caller provides the content and URL.
 * Returns metadata + pipeline outputs (content strings, not files).
 *
 * Non-HTML content types (JSON, XML, text) bypass pipelines entirely
 * and return the content as-is (JSON is pretty-printed).
 */
export function processHtml(
  html: string,
  url: string,
  contentType: string,
  opts?: ProcessOptions,
): FetchResult {
  const category = classifyContentType(contentType);

  // Non-HTML: skip cheerio parsing and pipelines entirely
  if (category !== 'html') {
    const content = category === 'json' ? prettyPrintJson(html) : html;
    const sizes: Record<string, SizeInfo> = {
      raw: { bytes: Buffer.byteLength(html, 'utf-8'), tokens: countTokens(html) },
      content: { bytes: Buffer.byteLength(content, 'utf-8'), tokens: countTokens(content) },
    };
    const meta: PageMeta = { url, title: '', description: '', contentType };
    return {
      meta: { ...meta, fetchedAt: new Date().toISOString(), sizes },
      files: { content },
    };
  }

  // HTML: extract metadata and run pipelines
  const meta = extractMetadata(html, url, contentType);
  const pipelineNames = opts?.pipelines ?? ['crawl4ai'];
  const allPipelines = { ...PIPELINES, ...opts?.customPipelines };

  const sizes: Record<string, SizeInfo> = {
    raw: { bytes: Buffer.byteLength(html, 'utf-8'), tokens: countTokens(html) },
  };
  const files: Record<string, string> = {};

  for (const name of pipelineNames) {
    const pipeline = allPipelines[name];
    if (!pipeline) continue;
    const result = pipeline(html, meta);
    files[name] = result.content;
    sizes[name] = {
      bytes: Buffer.byteLength(result.content, 'utf-8'),
      tokens: countTokens(result.content),
    };
  }

  return {
    meta: { ...meta, fetchedAt: new Date().toISOString(), sizes },
    files,
  };
}

/**
 * Process binary content (PDF, images, etc.) — no pipelines, just passthrough.
 * The `base64` param is the raw bytes already encoded as base64 by fetchPage().
 */
export function processBinary(
  base64: string,
  url: string,
  contentType: string,
): FetchResult {
  const bytes = Math.floor(Buffer.byteLength(base64, 'utf-8') * 3 / 4);
  const ext = extForMime(contentType);
  const meta: PageMeta = { url, title: '', description: '', contentType };
  return {
    meta: { ...meta, fetchedAt: new Date().toISOString(), sizes: { raw: { bytes, tokens: 0 } } },
    files: { raw: base64 },
    encoding: 'base64',
    ext,
  };
}

function prettyPrintJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
