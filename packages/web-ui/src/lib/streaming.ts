import { useEffect, useState } from 'preact/hooks';

const STREAM_LINE_MS = 120;
const SEAL_LINE_MS = 30;

export type TypewriterRole = 'live' | 'static';

export interface TypewriterState {
  /** The substring of `text` revealed so far. */
  displayedText: string;
  /** True when a cursor should be rendered (live role, and either unsealed or still catching up). */
  isStreaming: boolean;
  /** True when the reveal has reached the end of `text`. Distinct from `!isStreaming`
   *  in the "live + caught up + not yet sealed" state (caughtUp=true, isStreaming=true). */
  caughtUp: boolean;
  /** Locked at mount: 'live' bubbles animate; 'static' bubbles show full text immediately. */
  role: TypewriterRole;
}

/**
 * Per-line typewriter reveal with role-locked-at-mount lifecycle.
 *
 * Role semantics:
 *   - live   — born from an in-flight preview; reveals line-by-line, then catches up
 *              to the seal text when `sealed` flips true mid-life.
 *   - static — born already-sealed (history hydration, conversation switch); full
 *              text immediately, no animation ever.
 *
 * After mount, only `sealed` may flip (live → sealing → done); the role itself
 * is fixed by what existed at first render. This is what prevents history bubbles
 * from re-animating on page refresh.
 */
export function useTypewriter(text: string, sealed: boolean): TypewriterState {
  const [role] = useState<TypewriterRole>(() => sealed ? 'static' : 'live');
  const [revealedLen, setRevealedLen] = useState(() => role === 'static' ? text.length : 0);

  useEffect(() => {
    if (role === 'static') return;
    if (revealedLen >= text.length) return;
    const timer = setTimeout(() => {
      setRevealedLen((prev) => {
        const nl = text.indexOf('\n', prev);
        return nl === -1 ? text.length : nl + 1;
      });
    }, sealed ? SEAL_LINE_MS : STREAM_LINE_MS);
    return () => clearTimeout(timer);
  }, [text, sealed, revealedLen, role]);

  const displayedText = text.slice(0, Math.min(revealedLen, text.length));
  const caughtUp = revealedLen >= text.length;
  const isStreaming = role === 'live' && (!sealed || !caughtUp);

  return { displayedText, isStreaming, caughtUp, role };
}

/**
 * Insert a blinking cursor span at the end of the innermost trailing leaf.
 *
 * Returns `html` unchanged when `isStreaming === false`. Otherwise walks past
 * the full trailing chain of closing tags (e.g. `</code></pre>` or `</li></ul>`)
 * and inserts the cursor at the start of that chain — so the cursor sits
 * inline with the last text inside the innermost element, not as a stray
 * sibling beneath block elements. The `.preview-cursor` CSS class +
 * cursor-blink keyframe live in `index.css`.
 */
export function injectCursorInline(html: string, isStreaming: boolean): string {
  if (!isStreaming) return html;
  const cursor = '<span class="preview-cursor" aria-hidden="true">▌</span>';
  const m = html.match(/(?:<\/[a-zA-Z][^>]*>\s*)+$/);
  if (!m || m.index === undefined) return html + cursor;
  return html.slice(0, m.index) + cursor + html.slice(m.index);
}
