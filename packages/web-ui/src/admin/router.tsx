import { useEffect } from 'preact/hooks';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { Layout } from './layout';
import { OverviewPage } from './pages/overview';
import { IdpPage } from './pages/idp';
import { SettingsPage } from './pages/settings';
import { ActivityPage } from './pages/activity';
import { RoutesPage } from './pages/routes';
import { AgentsListPage } from './pages/agents-list';
import { AgentDetailPage } from './pages/agent-detail';
import { useSessionCheck } from './hooks/use-session';
import { useChangesStream } from './hooks/use-changes-stream';
import { AdminEventStreamProvider } from './hooks/use-admin-event-stream';

export function AdminRouter() {
  useEffect(() => { document.title = 'Cast | Dashboard'; }, []);
  const { authenticated, loading } = useSessionCheck();

  // Blanket-invalidate tRPC queries whenever the server reports a file change.
  useChangesStream(authenticated);

  if (loading || !authenticated) {
    return <div class="flex items-center justify-center h-screen text-gray-500">Loading...</div>;
  }

  return (
    <AdminEventStreamProvider enabled={authenticated}>
      <WouterRouter base="/admin">
        <Switch>
          <Route>
            <Layout>
              <Switch>
                <Route path="/" component={OverviewPage} />
                <Route path="/identity" component={IdpPage} />
                <Route path="/identity/:subtab" component={IdpPage} />
                <Route path="/routes" component={RoutesPage} />
                <Route path="/activity" component={ActivityPage} />
                <Route path="/settings" component={SettingsPage} />
                <Route path="/agents" component={AgentsListPage} />
                <Route path="/agents/:alias" component={AgentDetailPage} />
                <Route path="/agents/:alias/:tab" component={AgentDetailPage} />
                <Route path="/agents/:alias/:tab/:subtab" component={AgentDetailPage} />
                <Route path="/agents/:alias/:tab/:subtab/:nested" component={AgentDetailPage} />
                <Route>
                  <div class="text-gray-500">Page not found</div>
                </Route>
              </Switch>
            </Layout>
          </Route>
        </Switch>
      </WouterRouter>
    </AdminEventStreamProvider>
  );
}
