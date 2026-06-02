/**
 * Sticky-scroll hook for message lists.
 *
 * Keeps the scroll container pinned to the bottom as new content arrives,
 * but only while the user hasn't scrolled up. Combines:
 *   - MutationObserver on childList/subtree (new message elements)
 *   - ResizeObserver on the container (images/content that load late,
 *     and viewport resizes — see below)
 *   - scroll handler that measures distance to bottom (80px threshold)
 *
 * Resize semantics: the bottom of the viewport is the anchor. When the
 * container shrinks (e.g. the chat panel drag-resizes smaller), the top
 * of the visible content is cropped off rather than the bottom sliding
 * out of view. Implemented by tracking the previous clientHeight and
 * adjusting scrollTop by the delta on every resize — regardless of
 * whether the user is stuck-to-bottom. The stuck-to-bottom branch still
 * pins to scrollHeight directly for late-arriving content.
 *
 * Return shape:
 *   scrollRef     — attach to the overflow-y scroll container
 *   handleScroll  — wire to onScroll
 *   scrollToBottom — imperative "latest" jump (unpins user scroll first)
 *   isAtBottom    — state; flip a "↓ Latest" button on when false
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

export interface StickyScroll<T extends HTMLElement = HTMLDivElement> {
  scrollRef: { current: T | null };
  handleScroll: () => void;
  scrollToBottom: () => void;
  isAtBottom: boolean;
}

const THRESHOLD_PX = 80;

export function useStickyScroll<T extends HTMLElement = HTMLDivElement>(): StickyScroll<T> {
  const scrollRef = useRef<T>(null);
  const stick = useRef(true);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    stick.current = true;
    setIsAtBottom(true);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const pinMutation = () => {
      if (stick.current) {
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
      }
    };

    // Previous clientHeight, captured on each resize fire. Seeded from
    // the container's current height so the first event (which often
    // reports the same size) is a no-op delta.
    let prevClientHeight = el.clientHeight;

    const onResize = () => {
      const newClientHeight = el.clientHeight;
      const delta = prevClientHeight - newClientHeight;
      prevClientHeight = newClientHeight;
      if (stick.current) {
        // Stuck-to-bottom: pin to the very end regardless of delta.
        // (Handles late content arrival as well as size changes.)
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
        return;
      }
      if (delta === 0) return;
      // Anchor the bottom of the viewport: shifting scrollTop by the
      // height delta keeps the same content row aligned to the bottom
      // edge as the container shrinks/grows.
      const max = Math.max(0, el.scrollHeight - newClientHeight);
      el.scrollTop = Math.max(0, Math.min(max, el.scrollTop + delta));
    };

    const mutObs = new MutationObserver(pinMutation);
    mutObs.observe(el, { childList: true, subtree: true });

    const resizeObs = new ResizeObserver(onResize);
    resizeObs.observe(el);

    return () => {
      mutObs.disconnect();
      resizeObs.disconnect();
    };
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < THRESHOLD_PX;
    stick.current = nearBottom;
    setIsAtBottom(nearBottom);
  }, []);

  return { scrollRef, handleScroll, scrollToBottom, isAtBottom };
}
