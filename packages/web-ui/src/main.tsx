import { render } from 'preact';
import { Route, Switch, Redirect } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { trpc, trpcClient } from './admin/trpc';
import { AdminRouter } from './admin/router';
import { useAdminCapture } from './admin/hooks/use-admin-capture';
import { ChatApp } from './chat/app';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { refetchOnWindowFocus: false, retry: false },
  },
});

/** Pick a landing surface based on whether any agents exist. A fresh server
 *  has none, so root sends the operator to the Dashboard to create their
 *  first agent; once agents exist, root lands in Chat. Uses the public
 *  `agent.list` query so it resolves on a cold install with no admin session
 *  (auth.getStatus is admin-gated and errors pre-session, which previously
 *  fell through to /chat/). One-shot decision at root only — `/chat/*` never
 *  redirects to the dashboard, so the user can keep their preferred entry
 *  point bookmarked. */
function RootRedirect() {
  const agents = trpc.agent.list.useQuery();
  // Render nothing until we know — avoids a flash redirect to the wrong
  // surface that immediately bounces on first paint.
  if (agents.isLoading) return null;
  const hasAgents = (agents.data?.length ?? 0) > 0;
  return <Redirect to={hasAgents ? '/chat/' : '/admin/'} />;
}

function App() {
  // Keep the worker's admin events pipeline connected for the whole operator
  // session — on both /admin and /chat — so server-scope messages that arrive
  // while the operator is on the chat surface are captured to IndexedDB rather
  // than dropped. See use-admin-capture.ts.
  useAdminCapture();
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <Switch>
          <Route path="/admin/*">
            <AdminRouter />
          </Route>
          <Route path="/chat/*">
            <ChatApp />
          </Route>
          <Route>
            <RootRedirect />
          </Route>
        </Switch>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

render(<App />, document.getElementById('app')!);
