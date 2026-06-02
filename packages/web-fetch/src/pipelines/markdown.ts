/**
 * Markdown pipeline — straight HTML-to-Markdown via Turndown.
 * No filtering, no pruning. Full page conversion.
 */

import { createTurndown } from './turndown.js';
import type { Pipeline, PipelineResult, PageMeta } from '../types.js';

export const markdownPipeline: Pipeline = (html: string, _meta: PageMeta): PipelineResult => {
  const td = createTurndown();
  const content = td.turndown(html);
  return { content, ext: 'md' };
};
