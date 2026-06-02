import { useMemo } from 'preact/hooks';

import { renderMarkdown } from '../../lib/markdown';
import { useTypewriter, injectCursorInline } from '../../lib/streaming';

interface Props {
  text: string;
  sealed: boolean;
  timestamp?: string;
}

export function StreamableBubble({ text, sealed, timestamp }: Props) {
  const { displayedText, isStreaming, caughtUp, role } = useTypewriter(text, sealed);

  const html = useMemo(
    () => injectCursorInline(renderMarkdown(displayedText) ?? '', isStreaming),
    [displayedText, isStreaming],
  );

  return (
    <div class={`flex flex-col items-start ${role === 'live' && !sealed ? 'message-in' : ''}`}>
      <div class="max-w-[75%] rounded-2xl px-4 py-2.5 text-sm bg-gray-800 text-gray-200 rounded-tl-sm">
        <div
          class="prose prose-invert prose-sm max-w-none break-words leading-relaxed [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5 [&_pre]:bg-gray-900 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:my-3 [&_code]:text-teal-300 [&_a]:text-teal-400 [&_blockquote]:border-gray-600 [&_blockquote]:text-gray-400 [&_hr]:border-gray-700 [&_hr]:my-3"
          dangerouslySetInnerHTML={{ __html: html }}
        />
        {sealed && caughtUp && timestamp && (
          <div class="text-[10px] mt-1 text-gray-500">
            {new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </div>
        )}
      </div>
    </div>
  );
}
