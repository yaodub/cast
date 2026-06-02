/**
 * Extract page metadata from HTML: title, description, OG tags.
 */

import * as cheerio from 'cheerio';
import type { PageMeta } from './types.js';

/** Extract title and description from HTML head. */
export function extractMetadata(html: string, url: string, contentType: string): PageMeta {
  const $ = cheerio.load(html);

  const title =
    $('meta[property="og:title"]').attr('content') ??
    $('title').first().text().trim() ??
    '';

  const description =
    $('meta[property="og:description"]').attr('content') ??
    $('meta[name="description"]').attr('content') ??
    '';

  return { url, title, description, contentType };
}
