/**
 * Convert inline markdown links to numbered citation references.
 *
 * Transforms `[text](url)` into `text⟨1⟩` with a references section appended.
 * Image links `![alt](url)` become `![alt⟨1⟩]`.
 * Duplicate URLs share the same citation number.
 */

/** Unicode angle brackets used by crawl4ai for citations. */
const OPEN = '\u27E8';
const CLOSE = '\u27E9';

/** Matches markdown links: [text](url) and ![text](url "title") */
const LINK_PATTERN = /(!?)\[([^\]]+)\]\(([^)]+?)(?:\s+"([^"]*)")?\)/g;

export type CitationResult = {
  markdown: string;
  references: CitationRef[];
};

export type CitationRef = {
  id: number;
  url: string;
  text: string;
  title?: string;
};

/**
 * Replace inline links with numbered citations and append a reference list.
 *
 * @param markdown - Markdown text with inline links
 * @param baseUrl - Base URL for resolving relative links
 */
export function convertLinksToCitations(markdown: string, baseUrl?: string): CitationResult {
  const urlToId = new Map<string, number>();
  const references: CitationRef[] = [];
  let nextId = 1;

  const replaced = markdown.replace(LINK_PATTERN, (_match, bang: string, text: string, rawUrl: string, title?: string) => {
    const url = resolveUrl(rawUrl, baseUrl);
    let id = urlToId.get(url);
    if (id === undefined) {
      id = nextId++;
      urlToId.set(url, id);
      references.push({ id, url, text, title });
    }

    if (bang === '!') {
      // Image: keep the ! prefix
      return `![${text}${OPEN}${id}${CLOSE}]`;
    }
    return `${text}${OPEN}${id}${CLOSE}`;
  });

  if (references.length === 0) return { markdown, references };

  const refLines = references.map((r) => {
    const desc = [r.title, r.text].filter(Boolean).join(' - ');
    return `${OPEN}${r.id}${CLOSE} ${r.url}${desc ? `: ${desc}` : ''}`;
  });

  const output = `${replaced}\n\n---\n## References\n\n${refLines.join('\n')}`;
  return { markdown: output, references };
}

function resolveUrl(raw: string, base?: string): string {
  if (!base) return raw;
  if (/^https?:\/\/|^mailto:/i.test(raw)) return raw;
  try {
    return new URL(raw, base).href;
  } catch {
    return raw;
  }
}
