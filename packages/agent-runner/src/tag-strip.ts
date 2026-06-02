/**
 * Streaming tag-strip filter — mirrors `validateAgentOutput`'s cursor-advance
 * behavior chunk-by-chunk. Equivalence pinned by `tag-strip.property.test.ts`.
 */

const OPEN_RE = /<cast:[a-z]+(?:\s[^>]*)?>/;
const CLOSE_RE = /<\/cast:[a-z]+>/;

/** Equality against `format.ts`'s `CAST_TAG_RE.source` is asserted by the
 *  property test — a trip-wire against silent regex divergence. */
export const CAST_TAG_PATTERN_SOURCE = '<(\\/?)cast:([a-z]+)((?:\\s[^>]*)?)>';

export interface TagStripper {
  feed(chunk: string): string;
  /** Releases held-back bytes; an unfinished tag opens as plain text, an
   *  unfinished body is discarded (input was invalid). */
  flush(): string;
}

function canExtendToOpen(tail: string): boolean {
  if (tail.length === 0 || tail[0] !== '<') return false;
  if (tail.length === 1) return true;
  if (tail[1] === '/') return false;
  const PREFIX = '<cast:';
  if (tail.length <= PREFIX.length) return PREFIX.startsWith(tail);
  if (!tail.startsWith(PREFIX)) return false;
  const after = tail.slice(PREFIX.length);
  const m = /^[a-z]+/.exec(after);
  if (!m) return false;
  const afterName = after.slice(m[0].length);
  if (afterName.length === 0) return true;
  if (afterName[0] === '>') return false;
  if (/^\s/.test(afterName)) return !afterName.includes('>');
  return false;
}

function canExtendToClose(tail: string): boolean {
  if (tail.length === 0 || tail[0] !== '<') return false;
  if (tail.length === 1) return true;
  if (tail[1] !== '/') return false;
  if (tail.length === 2) return true;
  const PREFIX = '</cast:';
  if (tail.length <= PREFIX.length) return PREFIX.startsWith(tail);
  if (!tail.startsWith(PREFIX)) return false;
  const after = tail.slice(PREFIX.length);
  const m = /^[a-z]+/.exec(after);
  if (!m) return false;
  return after.slice(m[0].length).length === 0;
}

export function createTagStripper(): TagStripper {
  let buffer = '';
  let inTag = false;

  function drain(): string {
    let out = '';
    while (true) {
      if (inTag) {
        const closeMatch = CLOSE_RE.exec(buffer);
        if (closeMatch) {
          buffer = buffer.slice(closeMatch.index + closeMatch[0].length);
          inTag = false;
          continue;
        }
        const lt = buffer.lastIndexOf('<');
        if (lt === -1) { buffer = ''; return out; }
        const tail = buffer.slice(lt);
        if (canExtendToClose(tail)) { buffer = tail; return out; }
        buffer = buffer.slice(lt + 1);
        continue;
      }

      const openMatch = OPEN_RE.exec(buffer);
      if (openMatch) {
        out += buffer.slice(0, openMatch.index);
        buffer = buffer.slice(openMatch.index + openMatch[0].length);
        inTag = true;
        continue;
      }

      const lt = buffer.lastIndexOf('<');
      if (lt === -1) { out += buffer; buffer = ''; return out; }
      const tail = buffer.slice(lt);
      if (canExtendToOpen(tail)) {
        out += buffer.slice(0, lt);
        buffer = tail;
        return out;
      }
      out += buffer.slice(0, lt + 1);
      buffer = buffer.slice(lt + 1);
    }
  }

  return {
    feed(chunk: string): string {
      buffer += chunk;
      return drain();
    },
    flush(): string {
      const out = inTag ? '' : buffer;
      buffer = '';
      return out;
    },
  };
}
