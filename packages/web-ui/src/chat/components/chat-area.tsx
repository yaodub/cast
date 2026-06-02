import { useRef, useEffect, useMemo, useState } from 'preact/hooks';
import type { ChatConversationSnapshot, StoredMessage } from '../../worker/protocol';
import { useStickyScroll } from '../../lib/use-sticky-scroll';
import { MessageBubble } from './message-bubble';
import { StreamableBubble } from './streamable-bubble';
import { MessageInput, type PendingFile } from './message-input';
import { ActivityIndicator } from './activity-indicator';
import { AgentAvatar } from '../../lib/components/agent-avatar';

type RenderItem =
  | { key: string; kind: 'message'; msg: StoredMessage; sortAt: number }
  | { key: string; kind: 'stream'; text: string; sealed: boolean; timestamp: string; sortAt: number };

const RENDER_LIMIT = 200;

export interface ChatAreaProps {
  messages: StoredMessage[];
  activeAgent: string | null;
  activeChannel: string;
  channels: Array<{ name: string }>;
  error: string | null;
  typing: boolean;
  lifecycle: string | null;
  previews: ChatConversationSnapshot['previews'];
  pendingFiles: PendingFile[];
  currentHandle: string | null;
  onSend: (text: string) => void;
  onStageFiles: (files: File[] | FileList) => void;
  onUnstageFile: (id: string) => void;
  onChannelChange: (channel: string) => void;
}

export function ChatArea({
  messages: allMsgs,
  activeAgent: agent,
  activeChannel: channel,
  channels,
  error,
  typing,
  lifecycle,
  previews,
  pendingFiles,
  currentHandle,
  onSend,
  onStageFiles,
  onUnstageFile,
  onChannelChange,
}: ChatAreaProps) {
  const { scrollRef, handleScroll, scrollToBottom, isAtBottom } = useStickyScroll<HTMLDivElement>();
  const showScrollBtn = !isAtBottom;
  const [dragging, setDragging] = useState(false);

  const msgs = useMemo(
    () => allMsgs.length > RENDER_LIMIT ? allMsgs.slice(-RENDER_LIMIT) : allMsgs,
    [allMsgs],
  );

  // Build a unified, timestamp-sorted timeline. Stream items key by
  // `stream-${streamId}` so the seal-arrival transition is a same-key prop
  // change on <StreamableBubble> rather than an unmount/remount. The worker
  // patches a sealed message's timestamp to its preview's first-seen instant
  // so the bubble holds position across the seal.
  const renderItems = useMemo<RenderItem[]>(() => {
    const items: RenderItem[] = [];
    for (const m of msgs) {
      const sortAt = new Date(m.timestamp).getTime();
      if (m.streamId) {
        items.push({ key: `stream-${m.streamId}`, kind: 'stream', text: m.text, sealed: true, timestamp: m.timestamp, sortAt });
      } else {
        items.push({ key: m.id, kind: 'message', msg: m, sortAt });
      }
    }
    for (const p of previews) {
      items.push({ key: `stream-${p.streamId}`, kind: 'stream', text: p.text, sealed: false, timestamp: p.timestamp, sortAt: new Date(p.timestamp).getTime() });
    }
    items.sort((a, b) => a.sortAt - b.sortAt);
    return items;
  }, [msgs, previews]);
  const truncated = allMsgs.length > RENDER_LIMIT;

  // Paste files — scoped to chat area container
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function handlePaste(e: ClipboardEvent): void {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        onStageFiles(files);
      }
    }
    el.addEventListener('paste', handlePaste);
    return () => el.removeEventListener('paste', handlePaste);
  }, [onStageFiles]);

  function handleDragOver(e: DragEvent): void {
    e.preventDefault();
    setDragging(true);
  }

  function handleDragLeave(e: DragEvent): void {
    if (e.currentTarget && !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setDragging(false);
    }
  }

  function handleDrop(e: DragEvent): void {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer?.files.length) {
      onStageFiles(e.dataTransfer.files);
    }
  }

  return (
    <div
      ref={containerRef}
      class="flex-1 flex flex-col min-h-0 relative"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drop overlay */}
      {dragging && (
        <div class="absolute inset-0 z-10 bg-teal-900/20 border-2 border-dashed border-teal-500/50 rounded flex items-center justify-center pointer-events-none">
          <span class="text-teal-400 text-sm font-medium">Drop files to attach</span>
        </div>
      )}
      {/* Header — flat (no fill) with a clear divider below. Sits on
          the messages canvas; the hr separates the title row from the
          scrolling thread. Avatar matches the sidebar's so the same
          agent reads identically across both surfaces. */}
      <div class="px-5 py-3.5 border-b border-gray-800 flex items-center gap-3 shrink-0">
        {agent && <AgentAvatar alias={agent} size="md" active />}
        <div>
          <span class="text-white font-semibold text-sm">{agent}</span>
          <div class="text-xs text-gray-500">Agent</div>
        </div>
        {channels.filter((ch) => ch.name !== 'default').length > 0 && (
          <ChannelDropdown channels={channels} active={channel} onChange={onChannelChange} />
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div class="mx-4 mt-3 px-4 py-2.5 bg-red-900/30 rounded-lg flex items-center gap-2 shrink-0">
          <svg class="w-4 h-4 text-red-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <span class="text-sm font-medium text-red-300">{error}</span>
        </div>
      )}

      {/* Messages */}
      <div class="flex-1 relative min-h-0">
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          class="absolute inset-0 overflow-y-scroll px-4 py-3 space-y-3"
        >
          {truncated && (
            <div class="text-gray-600 text-xs text-center py-2">
              Showing last {RENDER_LIMIT} messages
            </div>
          )}
          {msgs.length === 0 && (
            <div class="flex flex-col items-center justify-center py-16 gap-3">
              <svg class="w-10 h-10 text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <span class="text-gray-500 text-sm">No messages yet. Say something!</span>
            </div>
          )}
          {renderItems.map((item) => item.kind === 'message'
            ? <MessageBubble key={item.key} message={item.msg} currentHandle={currentHandle} />
            : <StreamableBubble key={item.key} text={item.text} sealed={item.sealed} timestamp={item.timestamp} />
          )}
          <ActivityIndicator typing={typing} lifecycle={lifecycle} streaming={previews.length > 0} />
        </div>

        {showScrollBtn && (
          <div class="absolute bottom-3 left-0 right-0 flex justify-center">
            <button
              onClick={scrollToBottom}
              class="px-5 py-1.5 bg-gray-800 rounded-full text-sm text-gray-300 hover:bg-gray-700 shadow-lg transition-colors"
            >
              ↓ Latest
            </button>
          </div>
        )}
      </div>

      <MessageInput
        pendingFiles={pendingFiles}
        onSend={onSend}
        onStageFiles={onStageFiles}
        onUnstageFile={onUnstageFile}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel dropdown
// ---------------------------------------------------------------------------

function ChannelDropdown({
  channels,
  active,
  onChange,
}: {
  channels: Array<{ name: string }>;
  active: string;
  onChange: (ch: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent): void {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div ref={ref} class="relative ml-auto">
      <button
        onClick={() => setOpen(!open)}
        class="flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-200 bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
      >
        <span class="text-gray-500">#</span> {active}
        <svg class={`w-4 h-4 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div class="absolute right-0 top-full mt-1.5 w-52 bg-gray-800 rounded-lg shadow-xl z-20 py-1.5">
          {channels.map((ch) => (
            <button
              key={ch.name}
              onClick={() => { onChange(ch.name); setOpen(false); }}
              class={`w-full text-left px-4 py-2.5 text-sm font-medium transition-colors flex items-center gap-2 ${
                ch.name === active
                  ? 'text-teal-400 bg-teal-900/20'
                  : 'text-gray-300 hover:bg-gray-700 hover:text-white'
              }`}
            >
              <span class="text-gray-500">#</span> {ch.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

