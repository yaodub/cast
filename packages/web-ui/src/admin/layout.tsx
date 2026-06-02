/**
 * Layout — admin shell. Scope × verb sidebar.
 *
 * Two sections; each opens with a 4-tile top row that mirrors the other:
 *
 *   SERVER (forms only)
 *     [Messaging] [Identities] [Activity] [Settings]
 *
 *   AGENTS (verbs + per-agent list)
 *     [All Agents] [Design] [Configure] [Review]
 *     · alias-1 (URL-active → expanded)
 *       [Design] [Configure]    ← per-agent verbs inline
 *     · alias-2
 *     · …
 *     + New agent
 *
 * The fleet-row Design/Configure/Review tiles dock chat at server-scope
 * — these are the things formerly known as Design Manager / Config
 * Manager / Security Manager, renamed to the verb to match the per-agent
 * tiles. Internal addressing keeps the original `*-manager` symbols
 * (incl. `security-manager` for Review) — only the user-facing label
 * moved. Position differentiates: full-width 4-col grid = all-agents,
 * indented inline under a row = per-agent.
 *
 * Clicking an already-active verb tile toggles its chat closed.
 *
 * Auto-close: per-agent chats are bound to their agent's URL. Navigating
 * away from /agents/<alias>/* closes the per-agent chat. Manager chats
 * span all pages and persist across URL changes — required for the
 * `admin__navigate` handoff (manager points operator at a form, the
 * operator follows, returns to the chat to confirm/continue).
 */
import { createContext } from 'preact';
import { useState, useEffect, useRef, useContext, useMemo, useCallback } from 'preact/hooks';
import { Link, useLocation } from 'wouter';
import type { ComponentChildren, JSX } from 'preact';

import { trpc } from './trpc';
import { ChatPanel, type CurrentChat } from './components/chat-panel';
import { AgentAvatar } from '../lib/components/agent-avatar';
import {
  type ConsoleRole,
  DockMark,
  SCOPE_TEXT,
} from './components/console-avatar';
import {
  ActivityIcon,
  AllAgentsGlyph,
  CogIcon,
  ConfigureIcon,
  DesignIcon,
  FolderIcon,
  GlobeIcon,
  PlusIcon,
  SecureIcon,
  UserIcon,
} from './components/icons';
import { BrandStrip } from '../lib/brand';
import { useAdminChat, type AdminChatState } from './hooks/use-admin-chat';
import { useServerScopeChat, type ServerScopeTarget } from './hooks/use-server-scope-chat';
import { useAdminGlobalState } from './hooks/use-admin-global-state';
import { type Target, useAdminEventStream } from './hooks/use-admin-event-stream';
import { useChatUnread } from './lib/chat-unread';

// ---------- server tiles ----------

interface ServerCategory {
  id: 'identity' | 'activity' | 'routes' | 'settings';
  href: string;
  label: string;
  hint: string;
  Icon: (props: { class?: string }) => JSX.Element;
}

const SERVER_CATEGORIES: readonly ServerCategory[] = [
  { id: 'routes',   href: '/routes',   label: 'Messaging',  hint: 'Telegram, email, websocket transports',                Icon: GlobeIcon },
  { id: 'identity', href: '/identity', label: 'Identities', hint: 'Server identity, registered agents, paired users',     Icon: UserIcon },
  { id: 'activity', href: '/activity', label: 'Activity',   hint: 'Host event log — bus drops, lifecycle, container failures', Icon: ActivityIcon },
  { id: 'settings', href: '/settings', label: 'Settings',   hint: 'Server-wide preferences and model credentials',        Icon: CogIcon },
];

// ---------- role tokens (verb tiles) ----------

interface RoleTokens {
  bg: string;
  glow: string;
  Icon: (props: { class?: string }) => JSX.Element;
}

const ROLE_TOKENS: Record<ConsoleRole, RoleTokens> = {
  design:    { bg: 'bg-sky-500',     glow: 'shadow-[0_0_16px_rgba(14,165,233,0.5)]',  Icon: DesignIcon },
  configure: { bg: 'bg-amber-600',   glow: 'shadow-[0_0_16px_rgba(245,158,11,0.5)]',  Icon: ConfigureIcon },
  review:    { bg: 'bg-emerald-600', glow: 'shadow-[0_0_16px_rgba(5,150,105,0.5)]',   Icon: SecureIcon },
};

// ---------- chat selection context ----------

// Lets `<main>`'s descendants (e.g. AgentDetailPage's header) drive
// chat docking without prop-drilling. Layout is the single source of
// truth for `currentChat` — context just exposes it + the toggle.
interface ChatSelectionCtx {
  currentChat: CurrentChat | null;
  setOrToggleChat: (next: CurrentChat) => void;
  /**
   * Open the Configure surface appropriate for the current URL and post a
   * HELP question about the given anchor (or the page itself if no anchor).
   * Per-agent routes (`/agents/<alias>/...`) target that agent's
   * `__configure` channel; everything else targets `config-manager`.
   * Used by `<HelpButton/>`.
   */
  askHelp: (opts: { anchor?: string; label?: string }) => Promise<void>;
  /**
   * Dock the Security Manager chat and post `text` from the operator. Same
   * mechanic as `askHelp`: client-side `writeEcho` makes the operator's
   * message appear immediately, then the POST hands the body to SM's
   * default channel. Used by the "Request review" button on agent-detail —
   * the tRPC `agent.requestReview` mutation returns the canonical prompt
   * text, the UI sends it through this so the SM chat actually shows it.
   */
  sendToSecurityManager: (text: string) => Promise<void>;
}

const ChatSelectionContext = createContext<ChatSelectionCtx | null>(null);

export function useChatSelection(): ChatSelectionCtx {
  const ctx = useContext(ChatSelectionContext);
  if (!ctx) throw new Error('useChatSelection must be used inside <Layout>');
  return ctx;
}

// ---------- create-agent modal ----------

function CreateAgentModal({ onClose }: { onClose: () => void }) {
  const [, navigate] = useLocation();
  const { setOrToggleChat } = useChatSelection();
  const utils = trpc.useUtils();
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const create = trpc.agent.create.useMutation({
    onSuccess: async (data) => {
      await utils.agent.list.invalidate();
      onClose();
      navigate(`/agents/${data.alias}`);
      setOrToggleChat({ kind: 'agent', alias: data.alias, mode: 'design' });
    },
    onError: (e) => setErr(e.message),
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      // Focus trap — Tab/Shift-Tab wraps within the modal so keyboard
      // focus can't escape into the page underneath while the dialog is
      // open. Recomputed each Tab so dynamically-added/removed buttons
      // (e.g. the disabled-while-pending submit) are picked up.
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  function submit(e: Event): void {
    e.preventDefault();
    setErr(null);
    const trimmed = name.trim();
    if (!trimmed) {
      setErr('Name is required');
      return;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(trimmed)) {
      setErr('Name must be lowercase alphanumeric plus hyphens, no leading hyphen');
      return;
    }
    create.mutate({ name: trimmed });
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-agent-title"
      class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div class="bg-gray-900 border border-gray-800 rounded-md p-6 w-full max-w-md space-y-4">
        <div>
          <h2 id="create-agent-title" class="text-white font-semibold">Create Agent</h2>
          <p class="text-xs text-gray-500 mt-1">
            Starts a blank draft. Click Design under the new agent in the sidebar to compose it.
          </p>
        </div>
        <form onSubmit={submit} class="space-y-3">
          <label class="block">
            <span class="text-sm text-gray-400">Name</span>
            <input
              type="text"
              value={name}
              onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)}
              placeholder="my-agent"
              autoFocus
              class="w-full mt-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm font-mono placeholder-gray-500 focus:outline-none focus:border-teal-500"
            />
            <span class="block text-xs text-gray-500 mt-1">
              Lowercase alphanumeric plus hyphens. Folder name under mnt/agents/.
            </span>
          </label>
          {err && <div class="text-xs text-red-400">{err}</div>}
          <div class="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              class="px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800 rounded transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={create.isPending}
              class="px-3 py-1.5 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded disabled:opacity-50 transition-colors"
            >
              {create.isPending ? 'Creating...' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------- sidebar tiles ----------

function SidebarSection({
  tone,
  title,
  children,
}: {
  tone: 'agent' | 'server';
  title: string;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <div class="px-3 py-3 border-t border-gray-800/60 first:border-t-0">
      <div class={`px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] ${SCOPE_TEXT[tone]}`}>
        {title}
      </div>
      {children}
    </div>
  );
}

function ServerTile({ category, active }: { category: ServerCategory; active: boolean }): JSX.Element {
  const { Icon } = category;
  return (
    <Link
      href={category.href}
      class="flex flex-col items-center gap-1.5 p-2 rounded-md"
      title={category.hint}
    >
      <span
        class={`w-12 h-12 flex items-center justify-center rounded-md transition-all ${
          active
            ? 'bg-indigo-600 text-white shadow-[0_0_16px_rgba(99,102,241,0.5)]'
            : 'bg-gray-800 text-gray-400'
        }`}
      >
        <Icon class="w-6 h-6" />
      </span>
      <span class={`text-[11px] font-medium leading-tight text-center whitespace-nowrap ${active ? 'text-white' : 'text-gray-400'}`}>
        {category.label}
      </span>
    </Link>
  );
}

function AllAgentsTile({ active }: { active: boolean }): JSX.Element {
  return (
    <Link
      href="/agents"
      class="flex flex-col items-center gap-1.5 p-2 rounded-md"
      title="Fleet overview — every agent on this server"
    >
      <span
        class={`w-12 h-12 flex items-center justify-center rounded-md transition-all ${
          active
            ? 'bg-teal-600 text-white shadow-[0_0_16px_rgba(20,184,166,0.5)]'
            : 'bg-gray-800 text-gray-400'
        }`}
      >
        <AllAgentsGlyph class="w-6 h-6" />
      </span>
      <span class={`text-[11px] font-medium leading-tight text-center whitespace-nowrap ${active ? 'text-white' : 'text-gray-400'}`}>
        All Agents
      </span>
    </Link>
  );
}

// Agent tile — per-agent counterpart to AllAgentsTile. Always rendered
// in active styling because it only appears when the agent's row is
// expanded (i.e. you're already on /agents/<alias>/…), so it functions as
// a "you are here" indicator + a click-back-to-the-agent-root affordance
// when a sub-route is open. Teal echoes the agent-scope leitmotif used by
// SCOPE_TEXT.agent, the AgentRow's left stripe, and the AllAgents fleet
// tile.
function AgentTile({ alias }: { alias: string }): JSX.Element {
  return (
    <Link
      href={`/agents/${alias}`}
      class="flex flex-col items-center gap-1.5 p-2 rounded-md"
      title={`${alias} — this agent`}
    >
      <span class="w-12 h-12 flex items-center justify-center rounded-md transition-all bg-teal-600 text-white shadow-[0_0_16px_rgba(20,184,166,0.5)]">
        <FolderIcon class="w-6 h-6" />
      </span>
      <span class="text-[11px] font-medium leading-tight text-center whitespace-nowrap text-white">
        Agent
      </span>
    </Link>
  );
}

function RoleTile({
  role,
  label,
  active,
  unread,
  onClick,
  dock = false,
}: {
  role: ConsoleRole;
  label: string;
  active: boolean;
  unread: boolean;
  onClick: () => void;
  // When true, overlays the bottom-right `DockMark` L on the tile.
  // Marks tiles that *dock a chat panel* (fleet DM/CM/SM and per-agent
  // Design/Configure); page-nav tiles (All Agents, Agent) stay bare so
  // the operator can tell at a glance which tiles open a panel from
  // below vs. which navigate to a page. Lit white when the tile is
  // active (chat docked) and dimmed gray when inactive, so the marker
  // also reads as a docked-state indicator.
  dock?: boolean;
}): JSX.Element {
  const t = ROLE_TOKENS[role];
  const Icon = t.Icon;
  return (
    <button
      type="button"
      onClick={onClick}
      class="relative flex flex-col items-center gap-1.5 p-2 rounded-md"
      title={label}
    >
      <span
        class={`relative w-12 h-12 flex items-center justify-center rounded-md transition-all overflow-hidden ${
          active
            ? `${t.bg} text-white ${t.glow}`
            : 'bg-gray-800 text-gray-400'
        }`}
      >
        {dock && <DockMark class={active ? 'text-white' : 'text-gray-700'} />}
        <Icon class="w-6 h-6 relative" />
      </span>
      <span class={`text-[11px] font-medium leading-tight text-center whitespace-nowrap ${active ? 'text-white' : 'text-gray-400'}`}>
        {label}
      </span>
      {unread && !active && (
        <span class="absolute top-1 right-1 w-2 h-2 rounded-full bg-red-500" aria-label="unread" />
      )}
    </button>
  );
}

// ---------- agent rows ----------

function AgentRow({
  alias,
  status,
  badge,
  isUrlActive,
  href,
  chatActiveMode,
  onSelectChat,
}: {
  alias: string;
  status: string | null;
  badge: number | undefined;
  isUrlActive: boolean;
  href: string;
  chatActiveMode: 'design' | 'configure' | null;
  onSelectChat: (mode: 'design' | 'configure') => void;
}): JSX.Element {
  // Per-channel unread reads from the shared `chat-unread` localStorage
  // layer (populated by `useAdminUnreadTracker` in Layout) so the dots
  // light up for any agent, not just the URL-active one.
  const designUnread = useChatUnread({ kind: 'agent', alias, channel: '__design' });
  const configureUnread = useChatUnread({ kind: 'agent', alias, channel: '__configure' });
  const rowUnread = designUnread || configureUnread;

  // 3px left stripe — gray at rest, teal when active. Mirrors the
  // border-l accent on AgentDetailPage's heading. Wraps the row +
  // expansion so a selected agent's stripe extends down through its
  // verb tiles, reading as one block.
  return (
    <div class={`border-l-[3px] ${isUrlActive ? 'border-teal-500/60' : 'border-gray-700/50'}`}>
      <Link
        href={href}
        class="flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer"
      >
        <AgentAvatar alias={alias} size="md" active={isUrlActive} glow={isUrlActive} />
        <span class={`flex-1 text-sm font-medium truncate ${isUrlActive ? 'text-white' : 'text-gray-300'}`}>
          {alias}
        </span>
        <div class="flex items-center gap-1.5 shrink-0">
          {status === 'draft' && (
            <span class="px-1.5 py-0.5 text-[10px] font-medium bg-amber-800/40 text-amber-200 rounded">
              draft
            </span>
          )}
          {badge != null && badge > 0 && (
            <span class="bg-red-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
              {badge}
            </span>
          )}
          {rowUnread && !isUrlActive && (
            <span class="w-1.5 h-1.5 rounded-full bg-red-500" aria-label="unread" />
          )}
        </div>
      </Link>
      {isUrlActive && (
        <div class="flex gap-1.5 pl-11 pb-1">
          <AgentTile alias={alias} />
          <RoleTile
            role="design"
            label="Design"
            active={chatActiveMode === 'design'}
            unread={designUnread}
            onClick={() => onSelectChat('design')}
            dock
          />
          <RoleTile
            role="configure"
            label="Configure"
            active={chatActiveMode === 'configure'}
            unread={configureUnread}
            onClick={() => onSelectChat('configure')}
            dock
          />
        </div>
      )}
    </div>
  );
}

function NewAgentRow({ onClick }: { onClick: () => void }): JSX.Element {
  // Same border-l stripe as AgentRow so the continuous gray line
  // extends through this trailing affordance.
  return (
    <div class="border-l-[3px] border-gray-700/50">
      <button
        type="button"
        onClick={onClick}
        class="w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium text-gray-400 hover:text-white transition-colors cursor-pointer"
      >
        <span class="w-8 h-8 rounded-full border border-dashed border-gray-600 flex items-center justify-center shrink-0">
          <PlusIcon class="w-3.5 h-3.5" />
        </span>
        <span class="flex-1 text-left">New agent</span>
      </button>
    </div>
  );
}

// ---------- main Layout ----------

export function Layout({ children }: { children: ComponentChildren }) {
  const agents = trpc.agent.list.useQuery();
  const pairingCounts = trpc.agent.pendingPairingCounts.useQuery();
  const [location, navigate] = useLocation();

  const agentMatch = location.match(/^\/agents\/([^/]+)/);
  const currentAlias = agentMatch?.[1] ?? null;

  const [currentChat, setCurrentChat] = useState<CurrentChat | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  // First-run hint: with zero agents on the server, dock Design Manager
  // at large size so a fresh operator lands directly in the surface that
  // walks them through creating their first agent. One-shot per mount —
  // ref-guarded so a transient empty window during refetch doesn't
  // re-trigger. `pendingAutoSize` seeds ChatPanel's initial height; it
  // resets on close so the next manual open uses default.
  const autoOpenedRef = useRef(false);
  const [pendingAutoSize, setPendingAutoSize] = useState<'default' | 'large'>('default');

  // Auto-close: per-agent chat closes when URL leaves that agent's page.
  // Manager chats persist across URL changes — required for the
  // admin__navigate handoff (chat sends operator to a form, conversation
  // resumes when they return).
  useEffect(() => {
    if (currentChat?.kind === 'agent' && currentChat.alias !== currentAlias) {
      setCurrentChat(null);
    }
  }, [currentAlias, currentChat]);

  useEffect(() => {
    if (autoOpenedRef.current) return;
    if (!agents.isSuccess) return;
    if (agents.data.length !== 0) return;
    if (currentChat) return;
    autoOpenedRef.current = true;
    setPendingAutoSize('large');
    setCurrentChat({ kind: 'manager', target: 'design-manager' });
  }, [agents.isSuccess, agents.data, currentChat]);

  useEffect(() => {
    if (!currentChat && pendingAutoSize !== 'default') {
      setPendingAutoSize('default');
    }
  }, [currentChat, pendingAutoSize]);

  // Pivot to a server-scope manager when an admin__navigate directive's
  // `target` is one of the manager keys (`config-manager`, etc.). Hooked
  // into every chat hook below so any console can hand off to a manager.
  // The key is not a wouter route — it's a signal to dock a different chat tab.
  const pivotToServerScope = useCallback((target: ServerScopeTarget) => {
    setCurrentChat({ kind: 'manager', target });
    if (!location.startsWith('/agents')) navigate('/agents');
  }, [location, navigate]);

  // All chat hooks project off the single multiplexed admin event stream
  // (`useAdminEventStream`). No per-hook SSE — the dispatcher receives all
  // (alias, channel) packets always, so unread badges work for closed
  // agents and inactive rail tabs without subscription topology games.
  const dmChat = useServerScopeChat('design-manager', {
    isActive: currentChat?.kind === 'manager' && currentChat.target === 'design-manager',
    onServerScopeTab: pivotToServerScope,
  });
  const cmChat = useServerScopeChat('config-manager', {
    isActive: currentChat?.kind === 'manager' && currentChat.target === 'config-manager',
    onServerScopeTab: pivotToServerScope,
  });
  const smChat = useServerScopeChat('security-manager', {
    isActive: currentChat?.kind === 'manager' && currentChat.target === 'security-manager',
    onServerScopeTab: pivotToServerScope,
  });

  const designActive = currentChat?.kind === 'agent'
    && currentChat.alias === currentAlias
    && currentChat.mode === 'design';
  const configureActive = currentChat?.kind === 'agent'
    && currentChat.alias === currentAlias
    && currentChat.mode === 'configure';
  const designChat = useAdminChat(currentAlias ?? '', '__design', !!currentAlias && designActive, {
    onServerScopeTab: pivotToServerScope,
  });
  const configureChat = useAdminChat(currentAlias ?? '', '__configure', !!currentAlias && configureActive, {
    onServerScopeTab: pivotToServerScope,
  });

  // Single tracker mounted at Layout: subscribes to every (alias, channel)
  // through the multiplexed event stream and writes unread state into
  // localStorage so AgentRow / RoleTile dots reflect activity for any
  // agent (not just the URL-active one).
  const aliases = useMemo(() => (agents.data ?? []).map((a) => a.alias), [agents.data]);
  const activeTarget = useMemo<Target | null>(() => {
    if (!currentChat) return null;
    if (currentChat.kind === 'manager') return { kind: 'manager', slug: currentChat.target };
    return {
      kind: 'agent',
      alias: currentChat.alias,
      channel: currentChat.mode === 'design' ? '__design' : '__configure',
    };
  }, [currentChat]);
  // Single source of truth for client-side message state + unread.
  // Subscribes to every (alias, channel) via the dispatcher; appends
  // packets to a per-target store, persists to IDB, and marks unread
  // when the target isn't active. Chat hooks read from this via
  // `useTargetMessages` — they own no message array of their own.
  useAdminGlobalState({ aliases, activeTarget });

  const badgeMap = new Map<string, number>();
  for (const r of pairingCounts.data ?? []) {
    badgeMap.set(r.alias, r.count);
  }

  const panelChat = resolveCurrentChatState(currentChat, { dmChat, cmChat, smChat, designChat, configureChat });

  const chatActiveModeFor = (alias: string): 'design' | 'configure' | null => {
    if (currentChat?.kind === 'agent' && currentChat.alias === alias) return currentChat.mode;
    return null;
  };

  // Toggle: clicking an already-active verb tile closes the chat.
  // Manager tiles (Design/Configure/Review under "All Agents") are
  // fleet-scope — clicking one from a server page navigates the
  // operator into the agent section so the docked chat lands in its
  // natural context. Already on /agents/* → no nav, just dock.
  const setOrToggleChat = useCallback((next: CurrentChat) => {
    if (currentChat && sameTarget(currentChat, next)) {
      setCurrentChat(null);
      return;
    }
    setCurrentChat(next);
    if (next.kind === 'manager' && !location.startsWith('/agents')) {
      navigate('/agents');
    }
  }, [currentChat, location, navigate]);

  const askHelp = useCallback(
    async ({ anchor, label }: { anchor?: string; label?: string }) => {
      const isAgentRoute = location.startsWith('/agents/') && !!currentAlias;
      const target: CurrentChat = isAgentRoute
        ? { kind: 'agent', alias: currentAlias!, mode: 'configure' }
        : { kind: 'manager', target: 'config-manager' };
      // Dock the chat if it's not already on this target. Don't toggle —
      // a click on (i) when the matching chat is already open should
      // re-focus and append, not close.
      if (!currentChat || !sameTarget(currentChat, target)) setCurrentChat(target);
      const what = label ?? anchor;
      const page = pageLabelForRoute(location);
      const text = what
        ? `HELP: I'm on the ${page} page looking at "${what}". What is it?`
        : `HELP: I'm on the ${page} page. What is it?`;
      try {
        if (isAgentRoute) await configureChat.send(text);
        else await cmChat.send(text);
      } catch (e) {
        console.error('[askHelp] send failed', e);
      }
    },
    [location, currentAlias, currentChat, configureChat.send, cmChat.send],
  );

  const sendToSecurityManager = useCallback(
    async (text: string) => {
      const target: CurrentChat = { kind: 'manager', target: 'security-manager' };
      // Dock SM if it's not already the active chat — don't toggle.
      if (!currentChat || !sameTarget(currentChat, target)) setCurrentChat(target);
      try {
        await smChat.send(text);
      } catch (e) {
        console.error('[sendToSecurityManager] send failed', e);
      }
    },
    [currentChat, smChat.send],
  );

  const chatSelectionValue = useMemo(
    () => ({ currentChat, setOrToggleChat, askHelp, sendToSecurityManager }),
    [currentChat, setOrToggleChat, askHelp, sendToSecurityManager],
  );

  const fleetActiveRole = currentChat?.kind === 'manager'
    ? managerToRole(currentChat.target)
    : null;
  const fleetUnread = (role: ConsoleRole): boolean => {
    if (role === 'design') return dmChat.unread;
    if (role === 'configure') return cmChat.unread;
    return smChat.unread; // 'review' (formerly 'secure') — security-manager address
  };

  const isAllAgentsActive = location === '/agents';
  const activeServerCat = SERVER_CATEGORIES.find((c) =>
    location === c.href || location.startsWith(c.href + '/')
  )?.id ?? null;

  return (
    // Frame layout — root holds the sidebar's deep-blue color and main
    // sits inset by 8px on top + left so a frame strip shows through.
    // Main's `rounded-tl-xl` echoes the chat panel's `rounded-t-xl`,
    // making panel-rounding the shared visual language across the
    // workspace.
    <ChatSelectionContext.Provider value={chatSelectionValue}>
    <ServerShutdownBanner />
    <ApiConnectingBanner />
    {/* Column wrapper so UpdateAvailableBanner takes its own strip and pushes
        the workspace down rather than overlaying it. ServerShutdownBanner
        stays a fixed overlay — it's transient and high-priority. */}
    <div class="flex flex-col h-screen bg-[#0a1028]">
    <UpdateAvailableBanner />
    <div class="flex flex-1 min-h-0 bg-[#0a1028]">
      {/* Sidebar — w-80 to fit the 4-tile grids without truncation. */}
      <aside class="w-80 bg-[#0a1028] flex flex-col h-full shrink-0">
        <BrandStrip href="/" title="Server overview" />

        {/* SERVER — server-itself config. 4-tile grid, forms only.
            Always visible — operator should always have one click to
            credentials/messaging/identities/settings. */}
        <SidebarSection tone="server" title="Server">
          <div class="grid grid-cols-4 gap-1.5">
            {SERVER_CATEGORIES.map((c) => (
              <ServerTile key={c.id} category={c} active={activeServerCat === c.id} />
            ))}
          </div>
        </SidebarSection>

        {/* AGENTS header + fleet-row tiles — fixed above the scrollable
            agent list. Fleet verbs dock chat at server-scope (the
            things formerly called "managers"). Review is fleet-only —
            per-agent Review is not a thing. */}
        <div class="px-3 pt-3 border-t border-gray-800/60 shrink-0">
          <div class={`px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] ${SCOPE_TEXT.agent}`}>
            Agents
          </div>
          <div class="grid grid-cols-4 gap-1.5">
            <AllAgentsTile active={isAllAgentsActive} />
            <RoleTile
              role="design"
              label="Design"
              active={fleetActiveRole === 'design'}
              unread={fleetUnread('design')}
              onClick={() => setOrToggleChat({ kind: 'manager', target: 'design-manager' })}
              dock
            />
            <RoleTile
              role="configure"
              label="Configure"
              active={fleetActiveRole === 'configure'}
              unread={fleetUnread('configure')}
              onClick={() => setOrToggleChat({ kind: 'manager', target: 'config-manager' })}
              dock
            />
            <RoleTile
              role="review"
              label="Review"
              active={fleetActiveRole === 'review'}
              unread={fleetUnread('review')}
              onClick={() => setOrToggleChat({ kind: 'manager', target: 'security-manager' })}
              dock
            />
          </div>

          {/* "On this server" disambiguates: tiles above are at
              all-agents scope; the list below is the actual agents
              on this Cast server. */}
          <div class="mt-4 mb-2 px-3 text-[10px] uppercase tracking-wider text-gray-500">
            On this server
          </div>
        </div>

        {/* Per-agent list — the only scrollable region. With many
            agents, the brand + Server tiles + fleet tiles + "On this
            server" header stay anchored and only the rows scroll.
            No row-gap so each row's border-l-[3px] stripe touches the
            next, forming one continuous gray/red line down the list.
            NewAgentRow extends the stripe to the bottom. */}
        <div class="flex-1 overflow-y-auto px-3 pb-3">
          {agents.data?.map((agent) => {
            const isUrlActive = currentAlias === agent.alias;
            return (
              <AgentRow
                key={agent.alias}
                alias={agent.alias}
                status={agent.status}
                badge={badgeMap.get(agent.alias)}
                isUrlActive={isUrlActive}
                href={`/agents/${agent.alias}`}
                chatActiveMode={chatActiveModeFor(agent.alias)}
                onSelectChat={(mode) =>
                  setOrToggleChat({ kind: 'agent', alias: agent.alias, mode })}
              />
            );
          })}
          <NewAgentRow onClick={() => setCreateOpen(true)} />
        </div>

        {/* Return to Chats — links back to the operator chat surface. */}
        <div class="border-t border-gray-800 shrink-0 p-3 space-y-2">
          <a
            href="/chat/"
            class="flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-white border border-white/75 rounded-lg transition-colors hover:bg-white/10"
          >
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            Return to Chats
          </a>
          <SidebarVersionLine />
        </div>
      </aside>

      {/* Main column — vertical flex so the chat panel docks at the
          bottom edge across the full middle-column width. The 2px
          top + left inset (`mt-2 ml-2`) plus rounded top-left corner
          make main read as a workspace card sitting inside the
          sidebar frame. The chat panel inside has its own
          `rounded-t-xl`, becoming a sub-drawer within the card. */}
      <main class="flex-1 flex flex-col bg-gray-950 min-w-0 mt-2 ml-2 rounded-tl-xl overflow-hidden relative">
        <div class="flex-1 overflow-y-auto">
          <div class="max-w-4xl mx-auto px-8 py-8">
            {children}
          </div>
        </div>
        {currentChat && panelChat && (
          <ChatPanel
            current={currentChat}
            onClose={() => setCurrentChat(null)}
            chat={panelChat}
            initialSize={pendingAutoSize}
          />
        )}
      </main>

      {createOpen && <CreateAgentModal onClose={() => setCreateOpen(false)} />}
    </div>
    </div>
    </ChatSelectionContext.Provider>
  );
}

/** Sticky top banner shown while the admin event stream hasn't reached
 *  `open` yet. Covers the cold-start case (operator opened the dashboard
 *  before the API on 5050 bound) and any reconnect-without-shutdown drop.
 *  Suppressed when ServerShutdownBanner is up to avoid stacking. */
function ApiConnectingBanner(): preact.JSX.Element | null {
  const { connectionState, serverShutdownReason } = useAdminEventStream();
  if (serverShutdownReason) return null;
  if (connectionState === 'open') return null;
  return (
    <div class="fixed top-0 inset-x-0 z-50 px-4 py-2 bg-gray-900/95 border-b border-gray-800 text-gray-200 text-sm flex items-center justify-center backdrop-blur">
      <span>Connecting to server…</span>
    </div>
  );
}

/** Sticky top banner shown while the server is shutting down. The SSE hook
 *  flips `serverShutdownReason` on the `shutdown` event the server emits
 *  before it closes the stream; the banner clears itself once a fresh
 *  `ready` handshake arrives (i.e. the server came back up) or when the
 *  user dismisses it. Styled amber rather than red — shutdown is an
 *  expected operator action, not an error. */
function ServerShutdownBanner(): preact.JSX.Element | null {
  const { serverShutdownReason, connectionState } = useAdminEventStream();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    // Reset dismissal whenever a new shutdown lands (e.g. operator triggers
    // again after a previous dismissal).
    if (serverShutdownReason) setDismissed(false);
  }, [serverShutdownReason]);
  if (!serverShutdownReason || dismissed) return null;
  const reconnecting = connectionState === 'reconnecting';
  return (
    <div class="fixed top-0 inset-x-0 z-50 px-4 py-2 bg-amber-900/90 border-b border-amber-700/60 text-amber-100 text-sm flex items-center justify-center gap-3 backdrop-blur">
      <span class="w-2 h-2 rounded-full bg-amber-300 animate-pulse" />
      <span>
        Server shutting down{serverShutdownReason !== 'server-shutdown' ? ` — ${serverShutdownReason}` : ''}.
        {reconnecting ? ' Waiting for it to come back…' : ' Connection will close shortly.'}
      </span>
      <button
        onClick={() => setDismissed(true)}
        class="ml-3 px-2 py-0.5 text-xs text-amber-200 hover:text-amber-50 hover:bg-amber-800/40 rounded"
        aria-label="Dismiss"
      >
        Dismiss
      </button>
    </div>
  );
}

/** Persistent version line in the sidebar footer. Reads from status.get
 *  (always-available, no network) rather than updateStatus (which is null
 *  until pollUpdates resolves). Upgrade-available state is its own banner. */
function SidebarVersionLine(): preact.JSX.Element | null {
  const { data } = trpc.status.get.useQuery();
  if (!data?.version) return null;
  return (
    <div class="text-center text-[11px] text-gray-600 font-mono">
      v{data.version}
    </div>
  );
}

/** Strip shown when cast-services reports a newer release. Links to the
 *  update guide — the manifest-supplied `url` when present, else the
 *  canonical docs page. Opens in a new tab; the dashboard is served locally
 *  while the docs live on the marketing site. */
function UpdateAvailableBanner(): preact.JSX.Element | null {
  const { data } = trpc.server.updateStatus.useQuery(undefined, { staleTime: 60 * 60 * 1000 });
  if (!data?.available) return null;
  const href = data.url ?? 'https://getcast.dev/docs/updating';
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      class="shrink-0 px-4 py-2 bg-teal-900 hover:bg-teal-800 border-b border-teal-700/60 text-teal-50 text-sm flex items-center justify-center gap-2 transition-colors"
    >
      <span class="w-2 h-2 rounded-full bg-teal-300 animate-pulse" />
      <span class="font-semibold">Update available</span>
      <span class="font-mono text-white">{data.latest}</span>
      <span class="text-teal-300/80">·</span>
      <span class="text-teal-200/90">you're running</span>
      <span class="font-mono text-teal-100">{data.current}</span>
      <span class="ml-1 text-teal-100 underline underline-offset-2">How to update →</span>
    </a>
  );
}

function managerToRole(target: ServerScopeTarget): ConsoleRole {
  if (target === 'design-manager') return 'design';
  if (target === 'config-manager') return 'configure';
  return 'review';
}

/** Friendly page name for HELP transcript text — keyed on wouter route shape.
 *  Bot-side comprehension uses the manual; this is purely cosmetic for the
 *  message the operator sees in their own transcript. */
function pageLabelForRoute(route: string): string {
  if (route === '/' || route === '') return 'Server Overview';
  if (route === '/identity') return 'Identities';
  if (route === '/identity/agents') return 'Identities → Agents';
  if (route === '/identity/users') return 'Identities → Users';
  if (route === '/routes') return 'Messaging';
  if (route === '/activity') return 'Activity';
  if (route === '/settings') return 'Server Settings';
  if (route === '/agents') return 'All Agents';
  const m = /^\/agents\/[^/]+(?:\/([^/]+))?(?:\/([^/]+))?/.exec(route);
  if (m) {
    const TAB: Record<string, string> = {
      settings: 'Settings', access: 'Access', capabilities: 'Capabilities', activity: 'Activity',
    };
    const tab = m[1];
    if (!tab) return 'Agent Overview';
    const sub = m[2];
    return sub ? `${TAB[tab] ?? tab} → ${sub}` : (TAB[tab] ?? tab);
  }
  return route;
}

function sameTarget(a: CurrentChat, b: CurrentChat): boolean {
  if (a.kind === 'manager' && b.kind === 'manager') return a.target === b.target;
  if (a.kind === 'agent' && b.kind === 'agent') return a.alias === b.alias && a.mode === b.mode;
  return false;
}

function resolveCurrentChatState(
  current: CurrentChat | null,
  chats: {
    dmChat: AdminChatState;
    cmChat: AdminChatState;
    smChat: AdminChatState;
    designChat: AdminChatState;
    configureChat: AdminChatState;
  },
): AdminChatState | null {
  if (!current) return null;
  if (current.kind === 'manager') {
    return current.target === 'design-manager' ? chats.dmChat
      : current.target === 'config-manager' ? chats.cmChat
      : chats.smChat;
  }
  return current.mode === 'design' ? chats.designChat : chats.configureChat;
}
