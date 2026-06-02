/**
 * Playwright browser singleton for fetching rendered pages.
 *
 * Module-level instance (same pattern as tokens.ts encoder).
 * `launchBrowser()` is idempotent; `closeBrowser()` cleans up.
 */

import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { classifyContentType, isBinaryCategory } from './content-type.js';

const MAX_RESPONSE_SIZE = Number(process.env['MAX_RESPONSE_SIZE']) || 10 * 1024 * 1024;

// SIDE EFFECT: Module-level browser singleton, reused across all fetch calls.
// Required because launching chromium is expensive (~1s). Pure alternative (pass
// browser handle as parameter) would force every caller to manage browser lifecycle.
let browser: Browser | undefined;

/** Launch chromium (idempotent — reuses existing instance). */
export async function launchBrowser(): Promise<Browser> {
  if (!browser) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

export type FetchPageResult = {
  html: string;
  contentType: string;
  url: string;
  statusCode: number;
  headers: Record<string, string>;
};

export type FetchPageOptions = {
  timeout?: number;
};

/**
 * Navigate to a URL and return the rendered content.
 *
 * For non-HTML responses, uses `response.text()` directly instead of
 * `page.content()` (Playwright wraps non-HTML in `<pre>` tags).
 *
 * For binary responses (PDF, images), uses `response.body()` and returns
 * the content as base64 in the `html` field.
 *
 * Enforces MAX_RESPONSE_SIZE — checks Content-Length header first (free),
 * then byte-counts after download as fallback for chunked responses.
 */
export async function fetchPage(url: string, opts?: FetchPageOptions): Promise<FetchPageResult> {
  const b = await launchBrowser();
  const page = await b.newPage();
  try {
    const timeout = opts?.timeout ?? 30_000;
    // `networkidle` never settles on ad/analytics-heavy sites (news, etc.),
    // causing every fetch to hit the full timeout. `domcontentloaded` returns
    // as soon as the HTML is parsed; for SSR pages content is already present,
    // and Playwright keeps executing JS in the background, so subsequent
    // `page.content()` still captures hydrated output.
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    const statusCode = response?.status() ?? 0;
    const contentType = response?.headers()['content-type'] ?? 'text/html';
    const headers = response?.headers() ?? {};

    // Phase 1: Content-Length pre-check (free — no download)
    const contentLength = headers['content-length'];
    if (contentLength && Number(contentLength) > MAX_RESPONSE_SIZE) {
      throw new Error(`Response too large: ${contentLength} bytes exceeds limit of ${MAX_RESPONSE_SIZE} bytes`);
    }

    const category = classifyContentType(contentType);

    if (isBinaryCategory(category)) {
      // Binary: get raw bytes, encode as base64
      const data = await response?.body() ?? Buffer.alloc(0);
      if (data.byteLength > MAX_RESPONSE_SIZE) {
        throw new Error(`Response too large: ${data.byteLength} bytes exceeds limit of ${MAX_RESPONSE_SIZE} bytes`);
      }
      return { html: data.toString('base64'), contentType, url: page.url(), statusCode, headers };
    }

    // Text: existing logic
    const html = category !== 'html'
      ? (await response?.text() ?? '')
      : await page.content();

    // Phase 2: byte-count fallback for chunked responses
    const bodyBytes = Buffer.byteLength(html, 'utf-8');
    if (bodyBytes > MAX_RESPONSE_SIZE) {
      throw new Error(`Response too large: ${bodyBytes} bytes exceeds limit of ${MAX_RESPONSE_SIZE} bytes`);
    }

    return { html, contentType, url: page.url(), statusCode, headers };
  } finally {
    await page.close();
  }
}

/** Close the browser singleton. */
export async function closeBrowser(): Promise<void> {
  if (browser) {
    await browser.close();
    browser = undefined;
  }
}
