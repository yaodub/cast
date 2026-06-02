/**
 * AdminStreamableRow — admin-shaped streaming agent row.
 *
 * Mirrors `MessageRow` from admin-chat.tsx (log layout: avatar gutter +
 * flush-left content) but consumes the shared `useTypewriter` + cursor
 * injection helpers so the typewriter behavior stays in sync with the
 * regular-chat `StreamableBubble`. Identity of the streaming item is
 * keyed by `streamId` at the caller; the role is locked at mount inside
 * `useTypewriter` so history hydration doesn't re-animate.
 */
import { useMemo } from 'preact/hooks';

import { renderMarkdown } from '../../lib/markdown';
import { injectCursorInline, useTypewriter } from '../../lib/streaming';
import { ConsoleAvatar, consoleRole } from './console-avatar';

interface Props {
  text: string;
  sealed: boolean;
  /** Only set once the stream has sealed AND the typewriter has caught up. */
  timestamp?: string;
  channel: string;
  continuation: boolean;
}

export function AdminStreamableRow({ text, sealed, timestamp, channel, continuation }: Props) {
  const { displayedText, isStreaming, caughtUp } = useTypewriter(text, sealed);

  const html = useMemo(
    () => injectCursorInline(renderMarkdown(displayedText) ?? '', isStreaming),
    [displayedText, isStreaming],
  );

  const showTimestamp = sealed && caughtUp && timestamp;

  return (
    <div class={`flex gap-2.5 ${continuation ? '' : 'mt-3 first:mt-0'}`}>
      <div class="w-5 shrink-0 flex justify-center pt-0.5">
        {!continuation && <ConsoleAvatar role={consoleRole(channel)} size="sm" />}
      </div>
      <div class="flex-1 min-w-0">
        {!continuation && showTimestamp && (
          <div class="text-[10px] text-gray-500 leading-none mb-1">
            {new Date(timestamp).toLocaleTimeString()}
          </div>
        )}
        <div
          class="text-sm text-gray-100 prose prose-invert prose-sm max-w-none break-words leading-relaxed [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_pre]:bg-gray-950 [&_pre]:rounded [&_pre]:p-2 [&_pre]:overflow-x-auto [&_code]:text-teal-300 [&_a]:text-teal-400 [&_a]:hover:underline"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}
