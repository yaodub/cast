import { useState, useRef, useEffect } from 'preact/hooks';
import * as store from '../lib/store';
import { getIdentities, getActiveHandle, getActiveIdentity, type StoredIdentity } from '../../lib/identity';
import type { Agent, DiscoverAgent } from '../../lib/protocol';
import { BrandStrip } from '../../lib/brand';
import { AgentAvatar } from '../../lib/components/agent-avatar';
import { LinkIcon } from '../../admin/components/icons';

export function Sidebar() {
  const identities = getIdentities();
  const activeIdentity = getActiveIdentity();
  const agentList = store.agents.value;
  const discoverList = store.discovered.value;

  const unpaired = discoverList.filter(
    (d: DiscoverAgent) => !agentList.some((a: Agent) => a.alias === d.alias),
  );

  const connStatus = store.connectionState.value;

  return (
    <aside class="w-64 bg-[#0a1a1f] flex flex-col h-full shrink-0">

      {/* Brand strip — anchors the surface to the Cast product family.
          Clicking returns to /chat/. Sits above the identity tile so
          the hierarchy reads "this is Cast → you are <handle>". */}
      <BrandStrip href="/" title="Cast — chats" />

      {/* Identity area — name, connection, identity actions */}
      <IdentityArea identity={activeIdentity} identities={identities} connStatus={connStatus} />

      {/* Conversations + directory */}
      <div class="flex-1 overflow-y-auto">

        {/* Conversations */}
        <div class="px-3 py-3">
          <div class="px-3 pb-2 text-sm font-semibold text-gray-400">Conversations</div>
          {agentList.length === 0 && (
            <div class="mx-2 px-3 py-3 text-sm text-gray-500 bg-gray-800/30 border border-gray-800 rounded-lg text-center">
              No conversations yet
            </div>
          )}
          <div class="space-y-1">
            {agentList.map((agent: Agent) => {
              const isActive = store.activeAgent.value === agent.alias;
              const prefix = `${agent.alias}/`;
              const unreadCount = Object.entries(store.unread.value)
                .filter(([k]) => k.startsWith(prefix))
                .reduce((sum, [, v]) => sum + v, 0);
              return (
                <button
                  key={agent.alias}
                  class={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2.5 ${
                    isActive
                      ? 'bg-teal-900/30 text-white'
                      : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                  }`}
                  onClick={() => store.navigateTo(agent.alias)}
                >
                  <AgentAvatar alias={agent.alias} size="md" active={isActive} />
                  <span class="truncate flex-1">{agent.alias}</span>
                  {unreadCount > 0 && (
                    <span class="bg-red-500 text-white text-xs font-bold rounded-full px-2 py-0.5 min-w-[20px] text-center">
                      {unreadCount}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Agent directory */}
        {unpaired.length > 0 && (
          <div class="px-3 py-3 border-t border-gray-800">
            <div class="px-3 pb-2 text-sm font-semibold text-gray-400">Directory</div>
            <div class="space-y-1">
              {unpaired.map((d: DiscoverAgent) => (
                <button
                  key={d.alias}
                  class="w-full text-left px-3 py-2 rounded-lg text-sm text-gray-300 hover:bg-gray-800 hover:text-white border border-transparent hover:border-gray-700 transition-colors flex items-center gap-2.5"
                  onClick={() => store.navigateTo(d.alias)}
                >
                  {/* Unpaired affordance — dashed ring + link glyph
                      (two interlocked rings). Evokes "pair / connect"
                      and is visually distinct from the filled initials
                      disc of paired conversations. */}
                  <span
                    class="w-8 h-8 rounded-full border border-dashed border-gray-600 text-gray-500 flex items-center justify-center shrink-0"
                    aria-hidden
                  >
                    <LinkIcon class="w-4 h-4" />
                  </span>
                  <span class="flex-1 min-w-0">
                    <span class="block font-medium truncate">{d.alias}</span>
                    {d.description && (
                      <span class="text-xs text-gray-500 block mt-0.5 truncate">{d.description}</span>
                    )}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

      </div>

      {/* Dashboard link */}
      <div class="p-3">
        <a
          href="/admin/"
          class="flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-white border border-white/75 rounded-lg transition-colors hover:bg-white/10"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          Server Dashboard
        </a>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Identity area — top of sidebar
// ---------------------------------------------------------------------------

function IdentityArea({
  identity,
  identities,
  connStatus,
}: {
  identity: StoredIdentity | null;
  identities: StoredIdentity[];
  connStatus: string;
}) {
  const [open, setOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent): void {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  function handleRename(e: Event): void {
    e.preventDefault();
    const trimmed = nameInput.trim();
    if (!trimmed) return;
    store.renameUser(trimmed);
    setEditingName(false);
    setNameInput('');
  }

  if (!identity) return null;

  return (
    <div ref={menuRef} class="relative border-b border-gray-800">
      {/* Clickable identity header */}
      <button
        onClick={() => { if (!editingName) setOpen(!open); }}
        class={`w-full px-4 py-4 text-left transition-colors ${open ? 'bg-gray-800/50' : 'hover:bg-gray-800/30'}`}
      >
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            {/* Avatar circle */}
            <div class="w-8 h-8 rounded-full bg-teal-700 flex items-center justify-center text-white text-sm font-medium shrink-0">
              {identity.name.charAt(0).toUpperCase()}
            </div>
            <div>
              <div class="text-sm font-medium text-white truncate">{identity.name}</div>
              <div class="flex items-center gap-1.5 mt-0.5">
                <span class={`w-1.5 h-1.5 rounded-full ${connStatus === 'connected' ? 'bg-green-400' : connStatus === 'connecting' ? 'bg-yellow-400' : 'bg-red-400'}`} />
                <span class={`text-xs ${connStatus === 'connected' ? 'text-gray-500' : connStatus === 'connecting' ? 'text-yellow-500' : 'text-red-400'}`}>
                  {connStatus === 'connected' ? 'Connected' : connStatus === 'connecting' ? 'Connecting...' : 'Disconnected'}
                </span>
              </div>
            </div>
          </div>
          <svg class={`w-3.5 h-3.5 text-gray-500 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* Dropdown menu */}
      {open && (
        <div class="absolute left-2 right-2 top-[calc(100%-4px)] z-20 bg-gray-800 border border-gray-700 rounded-lg shadow-2xl">

          {/* Rename */}
          {editingName ? (
            <form onSubmit={handleRename} class="p-3 space-y-2">
              <input
                type="text"
                value={nameInput}
                onInput={(e) => setNameInput((e.target as HTMLInputElement).value)}
                placeholder={identity.name}
                maxLength={64}
                class="w-full px-2 py-1 bg-gray-900 border border-gray-600 rounded text-sm text-white focus:border-teal-500 focus:outline-none"
                autoFocus
              />
              <div class="flex gap-2">
                <button type="submit" class="text-sm text-teal-400 hover:text-teal-300">Save</button>
                <button type="button" onClick={() => setEditingName(false)} class="text-sm text-gray-500 hover:text-gray-300">Cancel</button>
              </div>
            </form>
          ) : (
            <button
              onClick={() => { setNameInput(identity.name); setEditingName(true); }}
              class="w-full px-3 py-2.5 text-left text-sm text-gray-300 hover:text-white hover:bg-gray-700/50 transition-colors"
            >
              Rename
            </button>
          )}

          {/* Identity list — per-tab switch + open-in-new-tab + remove */}
          {identities.length >= 1 && (
            <>
              <div class="mx-3 border-t border-gray-700" />
              <div class="py-1">
                {identities.map((id: StoredIdentity) => {
                  const isActive = id.handle === identity.handle;
                  return (
                    <div
                      key={id.handle}
                      class={`group flex items-center gap-1 px-3 py-2 text-sm transition-colors ${
                        isActive ? 'text-teal-400' : 'text-gray-300 hover:bg-gray-700/30'
                      }`}
                    >
                      <div class={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-medium shrink-0 ${
                        isActive ? 'bg-teal-700 text-white' : 'bg-gray-600 text-gray-300'
                      }`}>
                        {id.name.charAt(0).toUpperCase()}
                      </div>
                      <button
                        onClick={() => { if (!isActive) store.switchIdentity(id.handle); setOpen(false); }}
                        class="flex-1 text-left truncate hover:text-white"
                        disabled={isActive}
                      >
                        {id.name}
                        {isActive && <span class="ml-2 text-xs text-teal-600">active in this tab</span>}
                      </button>
                      <button
                        onClick={() => { store.openIdentityInNewTab(id.handle); setOpen(false); }}
                        class="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-teal-400 px-1 transition-opacity"
                        title="Open in new tab"
                      >
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(`Remove identity "${id.name}"? This will sign out of any tab using it.`)) {
                            store.removeIdentityAndNotify(id.handle);
                            setOpen(false);
                          }
                        }}
                        class="opacity-0 group-hover:opacity-100 text-gray-500 hover:text-red-400 px-1 transition-opacity"
                        title="Remove identity"
                      >
                        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a2 2 0 012-2h2a2 2 0 012 2v3" />
                        </svg>
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Add identity */}
          <div class="mx-3 border-t border-gray-700" />
          {showAdd ? (
            <div class="p-3">
              <AddIdentityForm onDone={() => { setShowAdd(false); setOpen(false); }} />
            </div>
          ) : (
            <button
              onClick={() => setShowAdd(true)}
              class="w-full px-3 py-2.5 text-left text-sm text-teal-400 hover:text-teal-300 hover:bg-gray-700/50 transition-colors"
            >
              + Add Identity
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add identity form
// ---------------------------------------------------------------------------

function AddIdentityForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setFormError(null);

    try {
      await store.register(trimmed);
      setSubmitting(false);
      onDone();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Registration failed');
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} class="space-y-2">
      <input
        type="text"
        value={name}
        onInput={(e) => setName((e.target as HTMLInputElement).value)}
        placeholder="Name"
        maxLength={255}
        class="w-full px-2 py-1.5 bg-gray-800 border border-gray-700 rounded text-sm text-white placeholder-gray-500 focus:border-teal-500 focus:outline-none"
        autoFocus
      />
      {formError && <p class="text-sm text-red-400">{formError}</p>}
      <div class="flex gap-2">
        <button
          type="submit"
          disabled={!name.trim() || submitting}
          class="flex-1 px-2 py-1.5 bg-teal-600 hover:bg-teal-500 text-white text-sm rounded disabled:opacity-50 transition-colors"
        >
          {submitting ? 'Creating...' : 'Create'}
        </button>
        <button
          type="button"
          onClick={onDone}
          class="px-2 py-1.5 text-sm text-gray-500 hover:text-gray-300"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
