/**
 * ChatPanel — single-slot chat surface docked at the bottom of the
 * middle column.
 *
 * Single height variable, drag-to-resize on the top edge, two preset
 * buttons (small/large) that just *set* the height — they're not a
 * toggle, they don't track state. Drawer is always in flow (`relative
 * shrink-0`); the workspace card sits above and is never modal-locked.
 *
 * A dim backdrop is always mounted but its opacity ramps with --chat-h
 * via pure CSS (`.chat-dim-backdrop` in index.css), so workspace fades
 * back as the chat grows without us branching in JSX. Backdrop is
 * pointer-events:none — workspace stays interactive at any chat size.
 *
 * Height resets to MIN on remount (no persistence). The previous
 * localStorage flow restored too-tall drawers on small screens; the
 * fix is to not persist.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'wouter';

import type { AdminChatState } from '../hooks/use-admin-chat';
import type { ServerScopeTarget } from '../hooks/use-server-scope-chat';
import { useAdminEventStream } from '../hooks/use-admin-event-stream';
import { AdminChat } from './admin-chat';
import { AgentAvatar } from '../../lib/components/agent-avatar';
import {
  ConsoleAvatar,
  consoleRole,
  consolePosture,
  type ConsolePosture,
  type ConsoleScope,
} from './console-avatar';
import {
  AllAgentsGlyph,
  CloseIcon,
  GlobeIcon,
  LockIcon,
  PanelLargeIcon,
  PanelSmallIcon,
} from './icons';

// Floor of the drag clamp — smaller than the default so dragging down
// past "small" is still possible. Default is what the small button sets
// and what the panel opens at on mount: 25% along the drag range, so it
// sits comfortably above the floor with room to shrink further.
const MIN_HEIGHT_PX = 200;
const DEFAULT_RANGE_RATIO = 0.25;
const MAX_HEIGHT_VH_RATIO = 0.92;
const maxHeightPx = (): number => Math.floor(window.innerHeight * MAX_HEIGHT_VH_RATIO);
const defaultHeightPx = (): number =>
  Math.floor(MIN_HEIGHT_PX + (maxHeightPx() - MIN_HEIGHT_PX) * DEFAULT_RANGE_RATIO);

export type CurrentChat =
  | { kind: 'manager'; target: ServerScopeTarget }
  | { kind: 'agent'; alias: string; mode: 'design' | 'configure' };

interface Props {
  current: CurrentChat;
  onClose: () => void;
  chat: AdminChatState;
  /** One-shot seed for the initial height. Read only in the useState
   *  initializer; prop changes after mount are ignored by design. */
  initialSize?: 'default' | 'large';
}

const MANAGER_VERB: Record<ServerScopeTarget, string> = {
  'design-manager': 'Design',
  'config-manager': 'Configure',
  'security-manager': 'Review',
};

const PER_AGENT_VERB = { design: 'Design', configure: 'Configure' } as const;

// Canned greetings — synthetic first-turn bubbles rendered above the
// transcript before the LLM is invoked. The strings here are mirrored
// in each console's manual `## Greeting` block (LLM-facing): authoring
// both at once keeps the operator's reply-to-the-greeting legible to
// the LLM, which has no transcript of having said anything.
const EMPTY_TEXT_MANAGER: Record<ServerScopeTarget, string> = {
  'design-manager':
    "Hi! I help you build and shape multi-agent systems on Cast. Describe what you want — an assistant, a workflow, something more complex — and I'll suggest which agents you'll need and what each one does. Works for new ideas or extending what you've already got. I'm in preview and still being sharpened — if I get stuck, your agents are plain files you can edit by hand or hand to Claude Code. What are you working on?",
  'config-manager':
    "Hi! I help with the practical setup of your agents — passwords, integrations, who's allowed to talk to them. I can see across all your agents and hand changes to the right one. Design decides what your agents *do*; configuration handles what they *need* to actually run. I'm in preview and still being sharpened — if I get stuck, your config is plain files you can edit by hand or hand to Claude Code. What needs setting up or changing?",
  'security-manager':
    "Hi! I'm a second look across all your agents — I review your work for privacy concerns, security risks, gaps, and whether the pieces hold together. I only read; I don't change anything. Useful when you've just built something, or anytime you want to check what's running. I'm in preview and still being sharpened, so treat what I surface as a starting point, not the last word. What should I look at?",
};

const EMPTY_TEXT_AGENT: Record<'design' | 'configure', string> = {
  design:
    "Hi! I work on this one agent with you — what it does, who it talks to, what tools and skills it has. Whether we're shaping it from scratch or adjusting how it works, just tell me what you're after. I'm in preview and still being sharpened — if I get stuck, the agent's files are plain text you can edit by hand or hand to Claude Code. What should this agent do?",
  configure:
    "Hi! I handle the practical setup for this one agent — secrets, integrations, who's paired with it, when its service runs. I'm in preview and still being sharpened — if I get stuck, the files are plain text you can edit by hand or hand to Claude Code. What needs setting up or changing?",
};

const POSTURE_LABEL: Record<ConsolePosture, string> = {
  'sdk-only': 'Locked — safe for secrets',
  'full-net': "Web-connected — don't paste secrets",
};

const POSTURE_TOOLTIP: Record<ConsolePosture, string> = {
  'sdk-only': 'This surface only reaches the AI — nothing else. Safe to paste secrets, identifiers, or conversation history.',
  'full-net': 'This surface can reach the public web (npm install, doc lookups). Anything pasted here could be relayed by prompt injection.',
};

// Scope-themed chrome — both surfaces carry a mild scope-tinted bg +
// matching divider. Agent slightly lighter than server so it reads as
// "focus surface inside the frame," not as another structural shell.
// Both hues are cool (indigo / teal) so they balance without dampening.
const SCOPE_HEADER_BG: Record<ConsoleScope, string> = {
  server: 'bg-indigo-950/60',
  agent: 'bg-teal-950/40',
};
const SCOPE_HEADER_BORDER: Record<ConsoleScope, string> = {
  server: 'border-indigo-500/25',
  agent: 'border-teal-500/25',
};
const SCOPE_TOP_EDGE: Record<ConsoleScope, string> = {
  server: 'bg-indigo-700/50',
  agent: 'bg-teal-700/50',
};

export function ChatPanel({ current, onClose, chat, initialSize }: Props) {
  const { verb, channel, role, posture, emptyText, consoleScope, alias } =
    resolveCurrent(current);
  const draftKey = current.kind === 'manager'
    ? `manager:${current.target}`
    : `agent:${current.alias}/${current.mode}`;
  const PostureIcon = posture === 'sdk-only' ? LockIcon : GlobeIcon;
  const postureColor = posture === 'sdk-only' ? 'text-emerald-400/80' : 'text-amber-300/80';

  const { connectionState } = useAdminEventStream();
  const [heightPx, setHeightPx] = useState(() =>
    initialSize === 'large' ? maxHeightPx() : defaultHeightPx(),
  );
  const dragRef = useRef<{ startY: number; startH: number } | null>(null);

  // Shrink-on-nav: any URL change clamps height down to the default
  // preset so a workspace tile click reveals the underlying page
  // instead of staying buried under a large/dragged-tall chat. Only
  // collapses — never grows — so a user who picked small stays small.
  const [location] = useLocation();
  const prevLocationRef = useRef(location);
  useEffect(() => {
    if (location === prevLocationRef.current) return;
    prevLocationRef.current = location;
    setHeightPx((h) => Math.min(h, defaultHeightPx()));
  }, [location]);

  const clampHeight = (h: number): number =>
    Math.max(MIN_HEIGHT_PX, Math.min(maxHeightPx(), h));

  function handlePointerDown(e: PointerEvent): void {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { startY: e.clientY, startH: heightPx };
  }
  function handlePointerMove(e: PointerEvent): void {
    if (!dragRef.current) return;
    const dy = dragRef.current.startY - e.clientY;
    setHeightPx(clampHeight(dragRef.current.startH + dy));
  }
  function handlePointerUp(e: PointerEvent): void {
    if (dragRef.current) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      dragRef.current = null;
    }
  }

  // Titlebar click: snap to whichever preset is further from current
  // height. A dragged-tall chat collapses to small; a small chat grows
  // to large. Ignored when the click lands on a button so the inner
  // small/large/close controls keep their own behavior.
  function handleHeaderClick(e: MouseEvent): void {
    if ((e.target as HTMLElement).closest('button') != null) return;
    const small = defaultHeightPx();
    const large = maxHeightPx();
    setHeightPx(heightPx >= (small + large) / 2 ? small : large);
  }

  return (
    <>
      {/* Dim backdrop — opacity is a pure CSS ramp anchored to the
          small/large positions (see .chat-dim-backdrop in index.css).
          pointer-events:none so the workspace stays interactive even
          at full chat height. */}
      <div
        class="chat-dim-backdrop absolute inset-0 z-20 bg-black pointer-events-none"
        style={{
          '--chat-h': String(heightPx),
          '--chat-default': String(defaultHeightPx()),
          '--chat-max': String(maxHeightPx()),
        }}
        aria-hidden
      />
      <section
        class="relative z-30 shrink-0 bg-gray-900 rounded-t-xl shadow-[0_-16px_32px_-4px_rgba(0,0,0,0.6)] ring-1 ring-gray-700/60 flex flex-col overflow-hidden"
        style={`height: ${heightPx}px;`}
      >
        {/* Top edge — scope-tinted accent line, also the drag handle. */}
        <div
          class={`h-2 ${SCOPE_TOP_EDGE[consoleScope]} shrink-0 cursor-ns-resize hover:brightness-125 transition-all`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          aria-label="Resize chat"
          role="separator"
        />

        {/* Header — scope-themed bg + matching bottom border (full-bleed),
            inner row constrained to match the chat content width. Clicking
            the row (outside any button) toggles between small/large. */}
        <div class={`${SCOPE_HEADER_BG[consoleScope]} border-b ${SCOPE_HEADER_BORDER[consoleScope]} shrink-0`}>
        <div
          class="mx-auto max-w-6xl w-full px-4 py-2.5 flex items-center gap-3 cursor-pointer"
          onClick={handleHeaderClick}
        >
          {consoleScope === 'agent' && alias != null && (
            <span class="flex items-center gap-2 shrink-0">
              <AgentAvatar alias={alias} size="sm" active />
              <span class="text-sm font-medium text-white">{alias}</span>
            </span>
          )}
          {consoleScope === 'server' && (
            <span class="flex items-center gap-2 shrink-0">
              <span class="w-6 h-6 rounded-md bg-teal-600 text-white flex items-center justify-center shrink-0">
                <AllAgentsGlyph class="w-3.5 h-3.5" />
              </span>
              <span class="text-sm font-medium text-white">All Agents</span>
            </span>
          )}
          <div class="flex items-center gap-2 text-sm leading-tight shrink-0">
            <ConsoleAvatar role={role} size="md" />
            <span class="font-medium text-white">{verb}</span>
          </div>

          <span
            class="shrink-0 rounded-full border border-amber-400/40 bg-amber-400/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300/90"
            title="Console agents are in preview — still being refined. Your agents are plain files you can always edit by hand or with Claude Code."
          >
            preview
          </span>

          <div
            class={`ml-auto flex items-center gap-1.5 text-[11px] leading-tight shrink-0 ${postureColor}`}
            title={POSTURE_TOOLTIP[posture]}
          >
            <PostureIcon class="w-3 h-3 shrink-0" />
            <span>{POSTURE_LABEL[posture]}</span>
          </div>

          {connectionState === 'reconnecting' && (
            <div
              class="flex items-center gap-1.5 text-[11px] leading-tight shrink-0 text-amber-300/80"
              title="Live event stream reconnecting — packets sent during the gap will not be replayed."
            >
              <span class="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" aria-hidden />
              <span>Reconnecting…</span>
            </div>
          )}

          <button
            type="button"
            onClick={() => setHeightPx(defaultHeightPx())}
            class="p-1.5 text-gray-500 hover:text-gray-200 hover:bg-gray-700/60 rounded transition-colors shrink-0"
            aria-label="Set chat to small"
            title="Small"
          >
            <PanelSmallIcon class="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setHeightPx(maxHeightPx())}
            class="p-1.5 text-gray-500 hover:text-gray-200 hover:bg-gray-700/60 rounded transition-colors shrink-0"
            aria-label="Set chat to large"
            title="Large"
          >
            <PanelLargeIcon class="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onClose}
            class="p-1.5 text-gray-500 hover:text-gray-200 hover:bg-gray-700/60 rounded transition-colors shrink-0"
            aria-label="Close chat"
            title="Close"
          >
            <CloseIcon class="w-4 h-4" />
          </button>
        </div>
        </div>

        <div class="flex-1 min-h-0 mx-auto w-full max-w-6xl">
          <AdminChat
            channel={channel}
            draftKey={draftKey}
            messages={chat.messages}
            previews={chat.previews}
            typing={chat.typing}
            lifecycle={chat.lifecycle}
            sending={chat.sending}
            error={chat.error}
            onSend={chat.send}
            fillParent
            emptyStateText={emptyText}
          />
        </div>
      </section>
    </>
  );
}

function resolveCurrent(current: CurrentChat): {
  verb: string;
  channel: string;
  role: 'design' | 'configure' | 'review';
  posture: ConsolePosture;
  emptyText: string;
  consoleScope: ConsoleScope;
  alias: string | null;
} {
  if (current.kind === 'manager') {
    return {
      verb: MANAGER_VERB[current.target],
      channel: current.target,
      role: consoleRole(current.target),
      posture: consolePosture(current.target),
      emptyText: EMPTY_TEXT_MANAGER[current.target],
      consoleScope: 'server',
      alias: null,
    };
  }
  return {
    verb: PER_AGENT_VERB[current.mode],
    channel: current.mode,
    role: consoleRole(current.mode),
    posture: consolePosture(current.mode),
    emptyText: EMPTY_TEXT_AGENT[current.mode],
    consoleScope: 'agent',
    alias: current.alias,
  };
}
