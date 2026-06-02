/**
 * DOM pruning scorer — faithful port of crawl4ai's PruningContentFilter.
 *
 * Scores each DOM node by text density, link density, tag weight,
 * class/id penalty, and text length. Nodes below the threshold are
 * removed. Top-down recursive: removing a parent removes all children.
 */

import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export type PruningConfig = {
  threshold: number;
  thresholdType: 'fixed' | 'dynamic';
  minWordThreshold?: number;
  weights: MetricWeights;
};

type MetricWeights = {
  textDensity: number;
  linkDensity: number;
  tagWeight: number;
  classIdWeight: number;
  textLength: number;
};

const DEFAULT_CONFIG: PruningConfig = {
  threshold: 0.48,
  thresholdType: 'fixed',
  weights: {
    textDensity: 0.4,
    linkDensity: 0.2,
    tagWeight: 0.2,
    classIdWeight: 0.1,
    textLength: 0.1,
  },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAG_WEIGHTS: Record<string, number> = {
  div: 0.5, p: 1.0, article: 1.5, section: 1.0,
  span: 0.3, li: 0.5, ul: 0.5, ol: 0.5,
  h1: 1.2, h2: 1.1, h3: 1.0, h4: 0.9,
  h5: 0.8, h6: 0.7,
};

const DYNAMIC_TAG_IMPORTANCE: Record<string, number> = {
  article: 1.5, main: 1.4, section: 1.3,
  p: 1.2, h1: 1.4, h2: 1.3, h3: 1.2,
  div: 0.7, span: 0.6,
};

/** Pattern for class/id values that suggest boilerplate. Anchored to start (matches crawl4ai behavior). */
const NEGATIVE_PATTERN = /^(nav|footer|header|sidebar|ads|comment|promo|advert|social|share)/i;

/** Tags removed before pruning — structural boilerplate. */
const EXCLUDED_TAGS = new Set([
  'nav', 'footer', 'header', 'aside',
  'script', 'style', 'form', 'iframe', 'noscript',
]);

/** Attribute allowlist — everything else is stripped (post-pruning). */
const IMPORTANT_ATTRS = new Set(['src', 'href', 'alt', 'title', 'width', 'height']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safely extract the lowercase tag name from a Cheerio/domhandler node. */
function elementTag(node: AnyNode): string {
  return (node as Element).tagName?.toLowerCase() ?? ''; // Cheerio's AnyNode union requires narrowing to Element
}

/** Get the attribs object from a node (undefined if not an Element). */
function elementAttribs(node: AnyNode): Record<string, string> | undefined {
  return (node as Element).attribs; // Cheerio's AnyNode union requires narrowing to Element
}

/** Tags never removed during empty-element cleanup. */
const BYPASS_TAGS = new Set([
  'a', 'img', 'br', 'hr', 'input', 'meta', 'link',
  'source', 'track', 'wbr', 'tr', 'td', 'th',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Prune boilerplate from HTML, returning cleaned HTML string. */
export function pruneHtml(html: string, config?: Partial<PruningConfig>): string {
  const cfg = { ...DEFAULT_CONFIG, ...config, weights: { ...DEFAULT_CONFIG.weights, ...config?.weights } };
  const $ = cheerio.load(html);

  // Pre-cleaning (before pruning, on full DOM with all attributes intact)
  removeComments($);
  removeExcludedTags($);
  stripBase64Images($);
  removeEmptyElements($);

  // Pruning operates on full attributes (needs class/id for scoring)
  pruneTree($, $('body'), cfg);

  // Post-pruning cleanup
  flattenNestedElements($);
  stripAttributes($);

  return $('body').html() ?? '';
}

// ---------------------------------------------------------------------------
// Pre-cleaning
// ---------------------------------------------------------------------------

function removeComments($: CheerioAPI): void {
  $('*').contents().filter(function (this: AnyNode) {
    return this.type === 'comment';
  }).remove();
}

function removeExcludedTags($: CheerioAPI): void {
  for (const tag of EXCLUDED_TAGS) {
    $(tag).remove();
  }
}

/** Strip data: URIs from image src attributes. */
function stripBase64Images($: CheerioAPI): void {
  $('img').each(function (this: AnyNode) {
    const el = $(this);
    const src = el.attr('src') ?? '';
    if (src.startsWith('data:')) {
      el.removeAttr('src');
    }
  });
}

function removeEmptyElements($: CheerioAPI): void {
  // Bottom-up: process deepest first so parent emptiness is evaluated after children are removed.
  const all = $('*').toArray().reverse();
  for (const node of all) {
    const el = $(node);
    const tag = elementTag(node);
    if (BYPASS_TAGS.has(tag)) continue;
    if (isInsidePreOrCode($, el)) continue;
    const text = el.text().trim();
    const wordCount = text ? text.split(/\s+/).length : 0;
    if (wordCount < 1 && el.children().length === 0) {
      el.remove();
    }
  }
}

function isInsidePreOrCode($: CheerioAPI, el: Cheerio<AnyNode>): boolean {
  return el.parents('pre, code').length > 0;
}

// ---------------------------------------------------------------------------
// Post-pruning cleanup
// ---------------------------------------------------------------------------

/**
 * Flatten nested elements of the same tag type.
 * e.g. <div><div><div><p>text</p></div></div></div> → <div><p>text</p></div>
 *
 * Matches crawl4ai's flatten_nested_elements: when a parent and its only
 * child element share the same tag, unwrap the child (replace parent content
 * with child's content, merge attributes).
 */
function flattenNestedElements($: CheerioAPI): void {
  let changed = true;
  while (changed) {
    changed = false;
    $('*').each(function (this: AnyNode) {
      const el = $(this);
      const tag = elementTag(this);
      if (!tag) return;
      const children = el.children();
      // Only flatten if exactly one child element and no meaningful text siblings
      if (children.length !== 1) return;
      const child = children.first();
      const childTag = children[0] ? elementTag(children[0]) : '';
      if (childTag !== tag) return;
      // Check no significant direct text (just whitespace between tags is ok)
      const directText = el.contents().filter(function (this: AnyNode) {
        return this.type === 'text';
      }).text().trim();
      if (directText.length > 0) return;
      // Unwrap: replace el's contents with child's contents
      el.html(child.html() ?? '');
      changed = true;
    });
  }
}

/** Strip all attributes except the allowlist (runs after pruning). */
function stripAttributes($: CheerioAPI): void {
  $('*').each(function (this: AnyNode) {
    const attribs = elementAttribs(this);
    if (!attribs) return;
    const el = $(this);
    for (const attr of Object.keys(attribs)) {
      if (!IMPORTANT_ATTRS.has(attr)) {
        el.removeAttr(attr);
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

function pruneTree($: CheerioAPI, root: Cheerio<AnyNode>, cfg: PruningConfig): void {
  const children = root.children().toArray();
  for (const child of children) {
    const el = $(child);
    const tag = elementTag(child);

    // Skip text/comment nodes
    if (!tag) continue;

    const score = computeScore($, el, tag, cfg);
    const threshold = computeThreshold(tag, $, el, cfg);

    if (score < threshold) {
      el.remove();
    } else {
      pruneTree($, el, cfg);
    }
  }
}

/**
 * Normalize text to match BeautifulSoup's get_text(strip=True).
 * Collapses all whitespace runs to single spaces.
 */
function normalizedText(el: Cheerio<AnyNode>): string {
  return el.text().replace(/\s+/g, ' ').trim();
}

function computeScore(
  $: CheerioAPI,
  el: Cheerio<AnyNode>,
  tag: string,
  cfg: PruningConfig,
): number {
  const text = normalizedText(el);
  const textLen = text.length;

  // min_word_threshold short-circuit
  if (cfg.minWordThreshold !== undefined) {
    const wordCount = textLen > 0 ? text.split(/\s+/).length : 0;
    if (wordCount < cfg.minWordThreshold) return -1;
  }

  // tagLen as UTF-8 byte length (matches crawl4ai's encode_contents)
  const innerHtml = el.html() ?? '';
  const tagLen = Buffer.byteLength(innerHtml, 'utf-8');

  const linkTextLen = childLinkTextLen($, el);

  const w = cfg.weights;
  let score = 0;
  let totalWeight = 0;

  // text_density
  const textDensity = tagLen > 0 ? textLen / tagLen : 0;
  score += w.textDensity * textDensity;
  totalWeight += w.textDensity;

  // link_density
  const linkDensity = textLen > 0 ? 1 - linkTextLen / textLen : 0;
  score += w.linkDensity * linkDensity;
  totalWeight += w.linkDensity;

  // tag_weight
  const tagScore = TAG_WEIGHTS[tag] ?? 0.5;
  score += w.tagWeight * tagScore;
  totalWeight += w.tagWeight;

  // class_id_weight — penalty clamped to 0
  const classIdScore = computeClassIdWeight(el);
  score += w.classIdWeight * Math.max(0, classIdScore);
  totalWeight += w.classIdWeight;

  // text_length — Math.log is natural log (matches crawl4ai)
  score += w.textLength * Math.log(textLen + 1);
  totalWeight += w.textLength;

  return totalWeight > 0 ? score / totalWeight : 0;
}

/** Sum of normalized text lengths of direct child <a> elements (matches crawl4ai recursive=False). */
function childLinkTextLen($: CheerioAPI, el: Cheerio<AnyNode>): number {
  let len = 0;
  el.children('a').each(function (this: AnyNode) {
    len += normalizedText($(this)).length;
  });
  return len;
}

function computeClassIdWeight(el: Cheerio<AnyNode>): number {
  let score = 0;
  const cls = el.attr('class') ?? '';
  if (cls && NEGATIVE_PATTERN.test(cls)) score -= 0.5;
  const id = el.attr('id') ?? '';
  if (id && NEGATIVE_PATTERN.test(id)) score -= 0.5;
  return score;
}

function computeThreshold(
  tag: string,
  $: CheerioAPI,
  el: Cheerio<AnyNode>,
  cfg: PruningConfig,
): number {
  if (cfg.thresholdType === 'fixed') return cfg.threshold;

  // Dynamic threshold — adjust per-node based on importance and content
  let threshold = cfg.threshold;
  const importance = DYNAMIC_TAG_IMPORTANCE[tag] ?? 0.7;

  if (importance > 1) threshold *= 0.8;

  const text = normalizedText(el);
  const textLen = text.length;
  const innerHtml = el.html() ?? '';
  const tagLen = Buffer.byteLength(innerHtml, 'utf-8');
  const textRatio = tagLen > 0 ? textLen / tagLen : 0;

  if (textRatio > 0.4) threshold *= 0.9;

  const linkRatio = textLen > 0 ? childLinkTextLen($, el) / textLen : 0;

  if (linkRatio > 0.6) threshold *= 1.2;

  return threshold;
}
