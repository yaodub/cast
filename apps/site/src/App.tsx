import { useEffect } from 'preact/hooks';
import { LocationProvider, Router, Route, useLocation } from 'preact-iso';
import { NavBar } from './components/site/NavBar';
import { Footer } from './components/ui/Footer';
import { Home } from './routes/Home';
import { HIWIndex } from './routes/how-it-works/Index';
import { HIWDeep } from './routes/how-it-works/Deep';
import { ExamplesIndex } from './routes/examples/Index';
import { ExamplesStory } from './routes/examples/Story';
import { Quickstart } from './routes/docs/Quickstart';
import { Updating } from './routes/docs/Updating';
import { UseServerDashboard } from './routes/docs/use/ServerDashboard';
import { UseFirstAgent } from './routes/docs/use/FirstAgent';
import { UsePairing } from './routes/docs/use/Pairing';
import { UseMigrating } from './routes/docs/use/Migrating';
import { ConceptsConversations } from './routes/docs/concepts/Conversations';
import { ConceptsChannels } from './routes/docs/concepts/Channels';
import { ConceptsTriggers } from './routes/docs/concepts/Triggers';
import { ConceptsCapabilities } from './routes/docs/concepts/Capabilities';
import { ConceptsMultiUser } from './routes/docs/concepts/MultiUser';
import { ExtensionsIndex } from './routes/docs/extensions/Index';
import { ExtensionsEmail } from './routes/docs/extensions/Email';
import { ExtensionsCalendar } from './routes/docs/extensions/Calendar';
import { ExtensionsWebFetch } from './routes/docs/extensions/WebFetch';
import { ExtensionsWhatsApp } from './routes/docs/extensions/WhatsApp';
import { ExtensionsBuild } from './routes/docs/extensions/Build';
import { TransportsIndex } from './routes/docs/transports/Index';
import { TransportsTelegram } from './routes/docs/transports/Telegram';
// DISCONNECTED: email transport temporarily disabled — page file is preserved
// at routes/docs/transports/Email.tsx but unrouted.
// import { TransportsEmail } from './routes/docs/transports/Email';
import { TransportsSlack } from './routes/docs/transports/Slack';
import { TransportsBuild } from './routes/docs/transports/Build';
import { ProfilesIndex } from './routes/docs/profiles/Index';
import { ProfilesStandard } from './routes/docs/profiles/Standard';
import { ProfilesMinimal } from './routes/docs/profiles/Minimal';
import { BuildAgentFolder } from './routes/docs/build/AgentFolder';
import { BuildClaudeCode } from './routes/docs/build/ClaudeCode';
import { BuildBlueprints } from './routes/docs/build/Blueprints';
import { BuildConfiguration } from './routes/docs/build/Configuration';
import { BuildDesigningWell } from './routes/docs/build/DesigningWell';
import { BuildServices } from './routes/docs/build/Services';
import { BuildMultiAgent } from './routes/docs/build/MultiAgent';
import { BuildDistributing } from './routes/docs/build/Distributing';
import { ApiTools } from './routes/docs/runtime/Tools';
import { ApiContext } from './routes/docs/runtime/Context';
import { ApiWireFormat } from './routes/docs/runtime/WireFormat';
import { AdvancedDeployment } from './routes/docs/advanced/Deployment';
import { AdvancedRuntimeOptions } from './routes/docs/advanced/RuntimeOptions';
import { AdvancedBackups } from './routes/docs/advanced/Backups';

function NotFound() {
  return (
    <main class="container" style={{ padding: '60px 0' }}>
      <h1>404</h1>
      <p>Not found.</p>
    </main>
  );
}

function Redirect({ to }: { to: string }) {
  const { route } = useLocation();
  useEffect(() => {
    route(to, true);
  }, [to]);
  return null;
}

function DocsIndex() {
  return <Redirect to="/docs/quickstart" />;
}

export function App() {
  return (
    <LocationProvider>
      <NavBar />
      <Router>
        <Route path="/" component={Home} />

        <Route path="/examples" component={ExamplesIndex} />
        <Route path="/examples/:slug" component={ExamplesStory} />

        <Route path="/how-it-works" component={HIWIndex} />
        <Route path="/how-it-works/:slug" component={HIWDeep} />

        <Route path="/docs" component={DocsIndex} />
        <Route path="/docs/quickstart" component={Quickstart} />
        <Route path="/docs/updating" component={Updating} />

        <Route path="/docs/use/server-dashboard" component={UseServerDashboard} />
        <Route path="/docs/use/first-agent" component={UseFirstAgent} />
        <Route path="/docs/use/pairing" component={UsePairing} />
        <Route path="/docs/use/migrating" component={UseMigrating} />

        <Route path="/docs/concepts/conversations" component={ConceptsConversations} />
        <Route path="/docs/concepts/channels" component={ConceptsChannels} />
        <Route path="/docs/concepts/triggers" component={ConceptsTriggers} />
        <Route path="/docs/concepts/capabilities" component={ConceptsCapabilities} />
        <Route path="/docs/concepts/multi-user" component={ConceptsMultiUser} />

        <Route path="/docs/extensions" component={ExtensionsIndex} />
        <Route path="/docs/extensions/email" component={ExtensionsEmail} />
        <Route path="/docs/extensions/calendar" component={ExtensionsCalendar} />
        <Route path="/docs/extensions/web-fetch" component={ExtensionsWebFetch} />
        <Route path="/docs/extensions/whatsapp" component={ExtensionsWhatsApp} />
        <Route path="/docs/extensions/build" component={ExtensionsBuild} />

        <Route path="/docs/transports" component={TransportsIndex} />
        <Route path="/docs/transports/telegram" component={TransportsTelegram} />
        {/* DISCONNECTED: email transport — see import block above. */}
        {/* <Route path="/docs/transports/email" component={TransportsEmail} /> */}
        <Route path="/docs/transports/slack" component={TransportsSlack} />
        <Route path="/docs/transports/build" component={TransportsBuild} />

        <Route path="/docs/profiles" component={ProfilesIndex} />
        <Route path="/docs/profiles/standard" component={ProfilesStandard} />
        <Route path="/docs/profiles/minimal" component={ProfilesMinimal} />

        <Route path="/docs/build/agent-folder" component={BuildAgentFolder} />
        <Route path="/docs/build/blueprints" component={BuildBlueprints} />
        <Route path="/docs/build/configuration" component={BuildConfiguration} />
        <Route path="/docs/build/multi-agent" component={BuildMultiAgent} />
        <Route path="/docs/build/designing-well" component={BuildDesigningWell} />
        <Route path="/docs/build/claude-code" component={BuildClaudeCode} />
        <Route path="/docs/build/services" component={BuildServices} />
        <Route path="/docs/build/distributing" component={BuildDistributing} />

        <Route path="/docs/runtime/tools" component={ApiTools} />
        <Route path="/docs/runtime/context" component={ApiContext} />
        <Route path="/docs/runtime/wire-format" component={ApiWireFormat} />

        <Route path="/docs/advanced/deployment" component={AdvancedDeployment} />
        <Route path="/docs/advanced/runtime-options" component={AdvancedRuntimeOptions} />
        <Route path="/docs/advanced/backups" component={AdvancedBackups} />

        <Route default component={NotFound} />
      </Router>
      <Footer />
    </LocationProvider>
  );
}
