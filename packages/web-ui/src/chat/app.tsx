import { useEffect } from 'preact/hooks';
import { Route, Switch, Redirect, Router as WouterRouter } from 'wouter';
import { navigate as wouterNavigate } from 'wouter/use-browser-location';
import * as store from './lib/store';
import { getActiveHandle, getIdentities, getIdentityByHandle } from '../lib/identity';
import { Registration } from './components/registration';
import { MainLayout } from './components/main-layout';
import { ToastStack } from './components/toast-stack';

// ---------------------------------------------------------------------------
// Chat app root
//
// Layout intent:
//   - The URL → subscribe wiring (`<Sync>` and `<AutoRedirect>`) runs
//     ALWAYS — it is what kicks the worker into spawning and pulls the
//     identity-scoped snapshot that flips `phase` to `'main'`. Gating it
//     behind `phase === 'main'` would recreate a fixed chicken-and-egg bug
//     (subscribers never mounted → phase never advanced).
//   - The phase-driven visible view (`Registration` / connecting spinner /
//     `MainLayout`) is rendered in a separate region. `<Sync>` returns null,
//     so the two regions don't compete for space.
// ---------------------------------------------------------------------------

export function ChatApp() {
  useEffect(() => {
    document.title = 'Cast | Chats';
    store.init();
  }, []);

  return (
    <WouterRouter base="/chat">
      {/* URL → subscribe wiring. No visible output — Sync/AutoRedirect each
          return null. Runs regardless of `phase` so the worker subscription
          fires on first load and phase can advance to 'main'. */}
      <Switch>
        <Route path="/:handleId/:agent/:channel">
          {(params: { handleId: string; agent: string; channel: string }) => (
            <Sync handleId={params.handleId} agent={params.agent} channel={params.channel} />
          )}
        </Route>
        <Route path="/:handleId/:agent">
          {(params: { handleId: string; agent: string }) => (
            <Sync handleId={params.handleId} agent={params.agent} />
          )}
        </Route>
        <Route path="/:handleId">
          {(params: { handleId: string }) => (
            <Sync handleId={params.handleId} />
          )}
        </Route>
        <Route>
          <AutoRedirect />
        </Route>
      </Switch>

      <div class="h-screen flex flex-col">
        {store.phase.value === 'register' && (
          <Registration />
        )}
        {store.phase.value === 'connecting' && (
          <div class="flex-1 flex flex-col items-center justify-center gap-4">
            <div class="bg-gray-900 border border-gray-800 rounded-xl px-8 py-6 text-center space-y-3">
              <div class="relative w-6 h-6 mx-auto flex items-center justify-center">
                <span class="absolute w-3 h-3 bg-teal-400/60 rounded-full" />
                <span class="absolute w-full h-full border border-teal-400/40 rounded-full animate-[ripple_1.8s_ease-out_infinite]" />
                <span class="absolute w-full h-full border border-teal-400/40 rounded-full animate-[ripple_1.8s_ease-out_0.6s_infinite]" />
              </div>
              <span class="text-sm text-gray-300 font-medium">
                {store.connectionState.value === 'disconnected'
                  ? 'Server unreachable — retrying...'
                  : 'Connecting to server...'}
              </span>
            </div>
            <a href="/admin/" class="text-sm text-gray-500 hover:text-gray-300 transition-colors">Server Dashboard</a>
          </div>
        )}
        {store.phase.value === 'main' && <MainLayout />}
      </div>
      <ToastStack />
    </WouterRouter>
  );
}

// ---------------------------------------------------------------------------
// URL → store sync (single component for all route shapes)
// ---------------------------------------------------------------------------

function Sync({ handleId, agent, channel }: { handleId: string; agent?: string; channel?: string }) {
  useEffect(() => {
    const handle = `web:${handleId}`;
    const identity = getIdentityByHandle(handle);

    if (!identity) {
      wouterNavigate('/chat/', { replace: true });
      return;
    }

    // Bind THIS TAB to the URL-named identity. The worker creates the
    // ConnectionState lazily on first subscribe (here) and reuses it across
    // tabs of the same identity (refcounted).
    store.setActiveIdentity(handle);

    if (agent) {
      store.setActiveConversation(agent, channel ?? 'default');
    } else {
      store.clearActiveConversation();
    }
  }, [handleId, agent, channel]);

  return null;
}

// ---------------------------------------------------------------------------
// Redirect bare `/chat/` to the active identity, falling back to the first
// stored identity if `cast-active-identity` localStorage is missing (e.g. a
// freshly imported profile). Renders null when no identities exist at all
// — the phase-driven view shows Registration in that case.
// ---------------------------------------------------------------------------

function AutoRedirect() {
  const handle = getActiveHandle() ?? getIdentities()[0]?.handle ?? null;
  if (!handle) return null;
  const handleId = handle.startsWith('web:') ? handle.slice(4) : handle;
  return <Redirect to={`/${handleId}`} />;
}

/** Extract URL-safe ID from a web: handle. */
export function handleToUrlId(handle: string): string {
  return handle.startsWith('web:') ? handle.slice(4) : handle;
}
