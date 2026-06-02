/**
 * Shared markdown renderer + HTML sanitizer.
 *
 * Both web chat and admin console chat parse agent output as markdown and
 * render it via `dangerouslySetInnerHTML`. This module is the single source
 * of truth for:
 *   - what links look like (target _blank, rel noopener)
 *   - which tags and attributes are allowed through
 *
 * Link styling (color, hover) is left to each parent surface via Tailwind
 * descendant selectors so that the two chat surfaces can diverge cosmetically
 * without duplicating the marked renderer setup.
 */
import { marked, type Renderer } from 'marked';

const renderer: Partial<Renderer> = {
  link({ href, text }) {
    const safeHref = href.replace(/"/g, '&quot;');
    return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  },
};
marked.use({ renderer });

/** Parse markdown to HTML and strip dangerous tags / attributes. */
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  const el = document.createElement('div');
  el.innerHTML = html;
  for (const node of el.querySelectorAll('script, iframe, object, embed, form, link, style')) {
    node.remove();
  }
  for (const node of el.querySelectorAll('*')) {
    for (const attr of [...node.attributes]) {
      if (attr.name.startsWith('on')) {
        node.removeAttribute(attr.name);
      }
    }
  }
  return el.innerHTML;
}
