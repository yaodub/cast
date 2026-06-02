/**
 * Crawl4ai pipeline — pruning filter + markdown + citation-style links.
 *
 * 1. Prune boilerplate DOM nodes using the scoring heuristic
 * 2. Convert cleaned HTML to Markdown
 * 3. Replace inline links with numbered citations
 */

import { createTurndown } from './turndown.js';
import { pruneHtml } from '../pruning.js';
import { convertLinksToCitations } from '../citations.js';
import type { Pipeline, PipelineResult, PageMeta } from '../types.js';

export const crawl4aiPipeline: Pipeline = (html: string, meta: PageMeta): PipelineResult => {
  const prunedHtml = pruneHtml(html);
  const td = createTurndown();
  const rawMarkdown = td.turndown(prunedHtml);
  const { markdown } = convertLinksToCitations(rawMarkdown, meta.url);
  return { content: markdown, ext: 'md' };
};
