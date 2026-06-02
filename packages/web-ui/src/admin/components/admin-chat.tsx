/**
 * AdminChat — presentational chat surface for a console channel.
 *
 * Layout: log rows, not bubbles. A 20px avatar gutter on the left carries
 * the speaker signal (role-color avatar for the agent, neutral for the
 * operator); content takes the full remaining column width. This buys back
 * the ~80px wasted on bubble alignment in narrow surfaces (rail, drawer)
 * without losing the "who said this" cue.
 *
 * Consecutive messages from the same sender collapse into a continuation
 * group: avatar + timestamp render only on the first row, follow-on rows
 * are flush-left under the same gutter. Halves vertical noise vs. the
 * timestamp-per-bubble layout.
 *
 * State (messages, SSE subscription, history fetch, send, typing, unread,
 * ui_directive routing) lives in `useAdminChat` — called by Layout +
 * AgentDetailPage so subscriptions stay alive across tab switches.
 */
import { useEffect, useMemo, useState } from 'preact/hooks';

import { renderMarkdown } from '../../lib/markdown';
import { useStickyScroll } from '../../lib/use-sticky-scroll';
import type { AdminTargetSnapshot } from '../../worker/protocol';
import type { ChatMessage } from '../hooks/use-admin-chat';
import { trpc } from '../trpc';
import { AdminStreamableRow } from './admin-streamable-row';
import { AuthSetupModal } from './auth-setup-modal';
import { ConsoleAvatar, consoleRole } from './console-avatar';
import { UserIcon } from './icons';

type RenderItem =
  | { kind: 'divider'; key: string; msg: ChatMessage; sortAt: number }
  | { kind: 'message'; key: string; msg: ChatMessage; sortAt: number }
  | { kind: 'stream'; key: string; streamId: string; text: string; sealed: boolean; from: string; timestamp: string; sortAt: number };

// Per-conversation draft persistence. Survives sidebar switches and
// panel close/reopen within a session; resets on page reload (module
// state is cleared). Keyed by `draftKey` — the caller's serialized
// conversation identity. Cleared on successful send.
const drafts = new Map<string, string>();

const GROUP_GAP_MS = 5 * 60 * 1000;

interface Props {
  channel: string;
  /** Stable serialization of the current conversation. Used to key the
   *  per-conversation draft so the textarea remembers what was typed
   *  when the operator switches away and comes back. */
  draftKey: string;
  messages: ChatMessage[];
  /** In-flight preview streams for this target, sourced from the worker's
   *  per-target previews map. Drained on durable seal. */
  previews: AdminTargetSnapshot['previews'];
  typing: boolean;
  /** In-flight runtime label (queued, bootstrap, compacting, auth_refresh).
   *  `null` when no lifecycle phase is active. Takes priority over `typing`
   *  in the activity slot — a queued runner isn't typing yet. */
  lifecycle: string | null;
  sending: boolean;
  error: string | null;
  onSend: (text: string) => Promise<void>;
  /** When true, the chat fills its parent's height instead of the default tab-context calc. */
  fillParent?: boolean;
  /** Override the empty-state copy when there's no history. Lets each
   *  console introduce itself in its own voice instead of the generic
   *  "Say something to start composing this agent." */
  emptyStateText?: string;
}

export function AdminChat({ channel, draftKey, messages, previews, typing, lifecycle, sending, error, onSend, fillParent, emptyStateText }: Props) {
  const [draft, setDraft] = useState(() => drafts.get(draftKey) ?? '');
  const { scrollRef, handleScroll } = useStickyScroll<HTMLDivElement>();

  // Conversation switch: re-seed from the draft map. Stays in sync with
  // whichever key the parent now points at.
  useEffect(() => {
    setDraft(drafts.get(draftKey) ?? '');
  }, [draftKey]);

  const updateDraft = (value: string): void => {
    setDraft(value);
    if (value) drafts.set(draftKey, value);
    else drafts.delete(draftKey);
  };

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || sending) return;
    await onSend(text);
    drafts.delete(draftKey);
    setDraft('');
  };

  // Unified render list — durable messages (some carrying a streamId from a
  // prior seal) and in-flight previews are sorted onto a single timeline by
  // timestamp. Streaming items key by `stream-${streamId}` so the seal-arrival
  // transition is a same-key prop change on <AdminStreamableRow>, not an
  // unmount/remount. A stable index breaks timestamp ties so insertion order
  // wins for equal stamps. Continuation grouping is computed in a single
  // forward pass downstream of this sort.
  const renderItems = useMemo<RenderItem[]>(() => {
    const items: RenderItem[] = [];
    let i = 0;
    for (const m of messages) {
      const sortAt = new Date(m.timestamp).getTime();
      if (m.type === 'divider:fresh_conversation' || m.type === 'divider:queued') {
        items.push({ kind: 'divider', key: m.id ?? `${m.timestamp}-${i}`, msg: m, sortAt });
      } else if (m.streamId && m.type === 'conversation') {
        items.push({
          kind: 'stream',
          key: `stream-${m.streamId}`,
          streamId: m.streamId,
          text: m.text,
          sealed: true,
          from: m.from,
          timestamp: m.timestamp,
          sortAt,
        });
      } else {
        items.push({ kind: 'message', key: m.id ?? `${m.timestamp}-${i}`, msg: m, sortAt });
      }
      i++;
    }
    for (const p of previews) {
      items.push({
        kind: 'stream',
        key: `stream-${p.streamId}`,
        streamId: p.streamId,
        text: p.text,
        sealed: false,
        from: p.from,
        timestamp: p.timestamp,
        sortAt: new Date(p.timestamp).getTime(),
      });
    }
    // Stable sort: Array.prototype.sort is stable in all modern engines, so
    // equal `sortAt` preserves the messages-then-previews insertion order
    // established above (matters when an echo and its preview share a ms).
    items.sort((a, b) => a.sortAt - b.sortAt);
    return items;
  }, [messages, previews]);

  // fillParent: caller (drawer / rail) provides bg + chrome — chat fills
  // flush with no nested card. Standalone: rounded card with its own bg.
  const containerClass = fillParent
    ? 'flex flex-col h-full'
    : 'bg-gray-900 border border-gray-800 rounded-lg flex flex-col';
  const containerStyle = fillParent ? undefined : 'height: calc(100vh - 280px);';

  return (
    <div class={containerClass} style={containerStyle}>
      {/* Messages — outer is the scroll container; inner is a
          min-h-full flex column with justify-end so the bottom of the
          transcript is the anchor. Short content hugs the bottom (empty
          space sits above); tall content overflows past the inner box
          and scrolls in the outer. Wrapping (instead of putting
          justify-end on the scroll container itself) is what keeps
          vertical scrolling working when content exceeds the viewport. */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        class="flex-1 overflow-y-auto px-3 py-3"
      >
        <div class="flex flex-col justify-end min-h-full">
        {/* Canned greeting — synthetic first-turn agent bubble, persistent
            at the top of the transcript. Pure UI: never sent to the LLM,
            never persisted server-side. The string is mirrored in the
            console's manual `## Greeting` block so the operator's reply
            (which IS sent) lands somewhere the LLM is primed to handle. */}
        {emptyStateText && (
          <div class="flex gap-2.5 mt-3 first:mt-0">
            <div class="w-5 shrink-0 flex justify-center pt-0.5">
              <ConsoleAvatar role={consoleRole(channel)} size="sm" />
            </div>
            <div class="flex-1 min-w-0">
              <div
                class="text-sm text-gray-100 prose prose-invert prose-sm max-w-none break-words leading-relaxed [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_p]:my-1.5 [&_a]:text-teal-400 [&_a]:hover:underline"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(emptyStateText) }}
              />
            </div>
          </div>
        )}
        {(() => {
          // Forward-pass closure: tracks the previous non-divider item across
          // both message and stream items so continuation grouping works
          // uniformly. Dividers reset the run; the 5-min gap also breaks the
          // run so long agent turns don't collapse with a stale timestamp.
          let prevFrom: string | null = null;
          let prevTimeMs: number | null = null;
          return renderItems.map((item) => {
            if (item.kind === 'divider') {
              prevFrom = null;
              prevTimeMs = null;
              if (item.msg.type === 'divider:fresh_conversation') {
                return <FreshConversationDivider key={item.key} />;
              }
              return <QueuedDivider key={item.key} text={item.msg.text} />;
            }
            const from = item.kind === 'message' ? item.msg.from : item.from;
            const isContinuation = prevFrom !== null
              && prevTimeMs !== null
              && prevFrom === from
              && item.sortAt - prevTimeMs < GROUP_GAP_MS;
            prevFrom = from;
            prevTimeMs = item.sortAt;
            if (item.kind === 'message') {
              return (
                <MessageRow
                  key={item.key}
                  msg={item.msg}
                  channel={channel}
                  continuation={isContinuation}
                />
              );
            }
            return (
              <AdminStreamableRow
                key={item.key}
                text={item.text}
                sealed={item.sealed}
                timestamp={item.timestamp}
                channel={channel}
                continuation={isContinuation}
              />
            );
          });
        })()}
        {/* Fixed-slot activity indicator: always rendered so appearance/
            disappearance doesn't reflow the scroll container. Lifecycle
            wins over typing — a queued/compacting runner isn't typing yet,
            and the lifecycle label carries the more informative reason.
            Suppressed while a preview is in flight: the in-bubble blinking
            cursor already signals "writing now," so showing a redundant
            "thinking…" pulse below would just add noise. */}
        {(() => {
          const isStreaming = previews.length > 0;
          const show = lifecycle !== null || (typing && !isStreaming);
          // Every label ends in an ellipsis; strip it and replace with the
          // animated `.thinking-dots` span so the dots read as in-motion.
          const label = (lifecycle ?? 'thinking…').replace(/[.…]+$/, '');
          return (
            <div class="flex gap-2.5 mt-2" aria-hidden={!show}>
              <div class="w-5 shrink-0" />
              <div
                class="text-xs text-gray-500 italic transition-opacity duration-100"
                style={{ opacity: show ? 1 : 0 }}
              >
                {label}<span class="thinking-dots" aria-hidden>...</span>
              </div>
            </div>
          );
        })()}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div class="mx-3 mb-2 px-3 py-2 bg-red-900/30 rounded text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Input — replaced with a Setup-Claude CTA when auth is not configured. */}
      <ChatInputArea
        channel={channel}
        draft={draft}
        sending={sending}
        updateDraft={updateDraft}
        submit={submit}
      />
    </div>
  );
}

/** Input row + auth-not-configured fallback. The chat input is replaced with
 *  a "Set up Claude" CTA whenever `auth.getStatus.mode` is null, so the user
 *  can never type into a channel that would silently fail at send. Clicking
 *  the CTA opens the shared AuthSetupModal — saving there hot-reloads the
 *  server and the input flips back live.
 *
 *  This is the single chokepoint for all five admin chat surfaces (Design
 *  Manager, Configure Manager, per-agent default/__design/__configure) — they
 *  all mount through AdminChat. */
function ChatInputArea({ channel, draft, sending, updateDraft, submit }: {
  channel: string;
  draft: string;
  sending: boolean;
  updateDraft: (text: string) => void;
  submit: () => Promise<void>;
}) {
  const authStatus = trpc.auth.getStatus.useQuery();
  const [showSetup, setShowSetup] = useState(false);

  // Treat "still loading" as configured to avoid a flash of the CTA on every
  // mount. The mutation path also typed-rejects at the server, so a brief
  // race here is safe.
  const notConfigured = authStatus.data ? authStatus.data.mode === null : false;

  if (notConfigured) {
    return (
      <>
        <div class="border-t border-gray-800 p-4 flex items-center justify-between gap-4">
          <div class="text-sm text-gray-400">
            Set up Claude to start chatting.
          </div>
          <button
            type="button"
            onClick={() => setShowSetup(true)}
            class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded transition-colors"
          >
            Configure
          </button>
        </div>
        {showSetup && (
          <AuthSetupModal
            onClose={() => setShowSetup(false)}
            onSaved={() => {
              setShowSetup(false);
              authStatus.refetch();
            }}
          />
        )}
      </>
    );
  }

  return (
    <div class="border-t border-gray-800 p-3 flex gap-2">
      <textarea
        value={draft}
        onInput={(e) => updateDraft((e.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
        placeholder={`Message #${channel}…`}
        rows={2}
        class="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:border-blue-500"
      />
      <button
        onClick={() => void submit()}
        disabled={sending || !draft.trim()}
        class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded disabled:opacity-50 transition-colors"
      >
        {sending ? '…' : 'Send'}
      </button>
    </div>
  );
}

function MessageRow({ msg, channel, continuation }: { msg: ChatMessage; channel: string; continuation: boolean }) {
  // Operator messages — both /history and optimistic echoes use the
  // compound form `local/<handle>`. The `local` identity prefix is
  // unambiguous (no other identity starts with `local`).
  const isOperator = msg.from.startsWith('local/');
  return (
    <div class={`flex gap-2.5 ${continuation ? '' : 'mt-3 first:mt-0'}`}>
      <div class="w-5 shrink-0 flex justify-center pt-0.5">
        {!continuation && (isOperator
          ? <OperatorAvatar />
          : <ConsoleAvatar role={consoleRole(channel)} size="sm" />
        )}
      </div>
      <div class="flex-1 min-w-0">
        {!continuation && (
          <div class="text-[10px] text-gray-500 leading-none mb-1">
            {new Date(msg.timestamp).toLocaleTimeString()}
          </div>
        )}
        {isOperator ? (
          // Operator text is plain; preserve literal newlines.
          <p class="text-sm text-gray-100 whitespace-pre-wrap break-words leading-relaxed">{msg.text}</p>
        ) : (
          // Agent text is markdown. `whitespace-pre-wrap` on markdown-rendered
          // HTML would preserve source newlines between block tags as visible
          // line breaks — layout blows up. Use prose styling only.
          <div
            class="text-sm text-gray-100 prose prose-invert prose-sm max-w-none break-words leading-relaxed [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5 [&_li]:my-0.5 [&_pre]:bg-gray-950 [&_pre]:rounded [&_pre]:p-2 [&_pre]:overflow-x-auto [&_code]:text-teal-300 [&_a]:text-teal-400 [&_a]:hover:underline"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.text) }}
          />
        )}
      </div>
    </div>
  );
}

function OperatorAvatar() {
  return (
    <span class="w-5 h-5 bg-gray-700 text-gray-300 rounded-full flex items-center justify-center shrink-0" aria-hidden>
      <UserIcon class="w-3 h-3" />
    </span>
  );
}

// Fresh-conversation boundary — rendered when the server fires a
// `fresh_conversation` lifecycle event (runner spawned without an SDK
// resume id, so the LLM has no prior context). Sits between the
// operator's triggering message and the agent's reply.
function FreshConversationDivider() {
  return (
    <div class="flex items-center gap-3 my-4 px-1 text-[10px] uppercase tracking-wider text-gray-500">
      <span class="flex-1 h-px bg-gray-800" />
      <span>Fresh conversation — agent has no prior context</span>
      <span class="flex-1 h-px bg-gray-800" />
    </div>
  );
}

// Surfaces a long queue wait (gate saturated, no idle runner to evict) so
// the operator can see the contention even after switching tabs or coming
// back later. Stays in the transcript as history once the slot frees.
function QueuedDivider({ text }: { text: string }) {
  return (
    <div class="flex items-center gap-3 my-4 px-1 text-[10px] uppercase tracking-wider text-gray-500">
      <span class="flex-1 h-px bg-gray-800" />
      <span>{text}</span>
      <span class="flex-1 h-px bg-gray-800" />
    </div>
  );
}
