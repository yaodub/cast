import { DocsLayout, H2, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { Code } from '../../../components/ui/Code';

export function ExtensionsIndex() {
  return (
    <DocsLayout
      url="/docs/extensions"
      crumbs={['docs', 'plugins', 'extensions']}
      title="Extensions"
      lede="An extension gives an agent a real-world capability — reaching your inbox, watching your calendar, fetching a page — exposed as tools the agent can call."
      toc={[
        { label: 'What an extension does' },
        { label: 'What Cast ships with' },
        { label: 'Turning one on' },
        { label: 'From a service' },
        { label: 'Config & secrets' },
        { label: 'Extensions, services & MCP' },
        { label: 'Authoring your own' },
      ]}
    >
      <H2>What an extension does</H2>
      <p style={proseP}>
        On its own an agent can think and talk. An extension is how it acts: each one wraps
        an outside system and hands the agent tools for it — search this mailbox, create
        that event, fetch this page. The agent opts into the extensions it needs, and the
        tools appear in its kit. Some extensions also watch for change and push into a
        conversation the moment something happens, so the agent can react without being
        asked.
      </p>

      <H2>What Cast ships with</H2>
      <ul style={proseUl}>
        <li>
          <DocsLink href="/docs/extensions/email">email</DocsLink> — search and read mail,
          send and reply, and subscribe to matching mail.
        </li>
        <li>
          <DocsLink href="/docs/extensions/calendar">calendar</DocsLink> — list and inspect
          events, and create, update, or delete them through an approval ladder.
        </li>
        <li>
          <DocsLink href="/docs/extensions/web-fetch">web-fetch</DocsLink> — pull a URL,
          render it, and return clean text the agent can read.
        </li>
        <li>
          <DocsLink href="/docs/extensions/whatsapp">whatsapp</DocsLink> — read, send, and
          download WhatsApp messages and media.
        </li>
      </ul>

      <H2>Turning one on</H2>
      <p style={proseP}>
        An agent opts into an extension in its blueprint —{' '}
        <code>blueprint/props/capabilities.json</code> lists each one under{' '}
        <code>extensions</code> with <code>enabled: true</code>, plus an optional dedicated{' '}
        <code>channel</code> for push. Enablement is per-agent: the same extension can be on
        for one agent and off for another, which is what lets a blueprint ship to many
        installs.
      </p>

      <H2>From a service</H2>
      <p style={proseP}>
        The bundled extensions are registered with the Cast server and enabled per-agent. But
        an extension doesn't have to be registered fleet-wide to be used — an agent service
        can wire one up itself, with no change to the Cast runtime. The extension then lives
        inside that one agent's service.
      </p>
      <p style={proseP}>
        The extension contract is portable: it depends only on{' '}
        <code>@getcast/extension-schema</code>, never on server internals. So the service
        imports the package and calls <code>create()</code> with a context built from its own
        directory, secrets, and message routing.
      </p>
      <Code lang="ts" noHead>{`import { email } from '@getcast/ext-email';

const mail = email.create({
  config: { /* ... */ },
  secrets: svc.secrets,
  privateDir: svc.serviceDir,
  sharedDir: svc.sharedDir,
  deliver: (text) => svc.routeMessage('default', text),
  log: console,
});

const hits = await mail.search({ query: 'invoice' });`}</Code>
      <p style={proseP}>
        The methods a service calls this way run below the tool layer, where the approval
        gates live, so the service is the trusted caller and applies its own policy.
      </p>
      <Callout kind="tip">
        This is the lighter path for a one-off or experimental capability you're not ready to
        register across the fleet. Authoring an extension to be driven this way is covered in{' '}
        <DocsLink href="/docs/extensions/build">Creating an extension</DocsLink>.
      </Callout>

      <H2>Config & secrets</H2>
      <p style={proseP}>
        Two install-specific things live outside the blueprint, per agent: behavioral{' '}
        <strong>config</strong> (overrides in <code>config/ext/&lt;name&gt;/config.json</code>)
        and <strong>credentials</strong> (<code>config/ext/&lt;name&gt;/secrets.json</code>).
        The blueprint decides what an operator may change — a value is locked by default, or
        marked overridable. The files and the locking rule are covered in{' '}
        <DocsLink href="/docs/build/configuration">Configuring agents</DocsLink>.
      </p>

      <Callout kind="security">
        Files under <code>config/ext/</code> are <strong>not mounted into the
        container</strong>. The extension runs on the host and reads them there, so a
        credential can power a tool the agent uses without the agent ever seeing the secret
        itself.
      </Callout>

      <H2>Extensions, services &amp; MCP</H2>
      <p style={proseP}>
        An extension is the curated path — framework-backed, with typed config, a lifecycle,
        approval gates, and a contribution to the agent's prompt. When no extension fits, a
        service you write or an external MCP server can fill the gap, with different
        trade-offs.{' '}
        <DocsLink href="/docs/concepts/capabilities">Capabilities</DocsLink> lays out the
        three side by side.
      </p>

      <H2>Authoring your own</H2>
      <p style={proseP}>
        Extensions are standalone packages, built to ship to others. To write one, see{' '}
        <DocsLink href="/docs/extensions/build">Creating an extension</DocsLink>.
      </p>
    </DocsLayout>
  );
}
