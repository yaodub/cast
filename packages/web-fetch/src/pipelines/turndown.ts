/** Shared Turndown configuration for all pipelines. */

import TurndownService from 'turndown';

export function createTurndown(): TurndownService {
  return new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    hr: '---',
  });
}
