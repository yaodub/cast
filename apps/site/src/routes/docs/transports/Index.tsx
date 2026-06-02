import { DocsLayout, H2, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { Code } from '../../../components/ui/Code';
import { FileSpec } from '../../../components/docs/FileSpec';
import { FieldTable } from '../../../components/docs/FieldTable';

export function TransportsIndex() {
  return (
    <DocsLayout
      url="/docs/transports"
      crumbs={['docs', 'plugins', 'transports']}
      title="Transports"
      lede="Transports are how you reach your agent — through an app you already use. Pick Telegram or Slack, switch it on, and the agent meets you there."
      toc={[
        { label: 'Ways to reach your agent' },
        { label: 'Turning one on' },
        { label: 'The contract' },
        { label: 'Config & credentials' },
        { label: 'Lifecycle & hot-reload' },
        { label: 'Authoring your own' },
      ]}
    >
      <H2>Ways to reach your agent</H2>
      <p style={proseP}>
        Your agent doesn't have an app of its own to download. Instead it shows up inside
        tools you already keep open — a Telegram chat, your inbox, a Slack message. Each of
        those connections is a <em>transport</em>. Switch on as many as you like; the same
        agent answers across all of them, and picks up the thread wherever you left it.
      </p>
      <ul style={proseUl}>
        <li>
          <DocsLink href="/docs/transports/telegram">Telegram</DocsLink> — chat with your
          agent one-on-one or pull it into a group. The quickest to set up.
        </li>
        {/* DISCONNECTED: email transport temporarily disabled. */}
        {/*
        <li>
          <DocsLink href="/docs/transports/email">Email</DocsLink> — write to your agent
          and get replies in your inbox. Good for longer, take-your-time back-and-forth.
        </li>
        */}
        <li>
          <DocsLink href="/docs/transports/slack">Slack</DocsLink> — message your agent in
          a Slack DM. Natural if your team already lives there.
        </li>
      </ul>

      <H2>Turning one on</H2>
      <p style={proseP}>
        Each app needs one credential from its side — a bot token from Telegram, a pair of
        tokens from Slack. You add that credential to your server through the admin
        dashboard, and it ties the app to a specific agent. From then on, messaging the
        app <em>is</em> messaging the agent. The page for each transport above walks
        through getting its credential, step by step.
      </p>
      <p style={proseP}>
        The rest of this page is the builder's view — how a transport is defined,
        registered, and configured under the hood.
      </p>

      <H2>The contract</H2>
      <p style={proseP}>
        A transport is a value returned by <code>defineTransport()</code>. It declares a{' '}
        <code>name</code>, a Zod <code>configSchema</code> that validates its{' '}
        <code>routes.json</code> slice, a <code>create()</code> factory, and an{' '}
        <code>admin</code> descriptor that drives its form in the dashboard. See{' '}
        <DocsLink href="/docs/transports/build">Creating a transport</DocsLink> for the
        full contract — the runtime interface, address namespaces, and how a transport
        registers with the server.
      </p>

      <H2>Config & credentials</H2>
      <p style={proseP}>
        Per-transport configuration lives in the server's <code>routes.json</code>, keyed
        by transport name. Each value is an <strong>array of route entries</strong>, and
        each entry's <code>address</code> field binds the transport to one agent — adding
        or removing an entry is the only enablement switch. There is no separate per-agent
        toggle.
      </p>

      <FileSpec name="routes.json" meta="json · per-transport credentials & bindings">
        <Code lang="json" noHead>{`{
  "telegram": [
    {
      "address": "assistant",
      "token": "123456:ABC-DEF...",
      "channel": "default"
    }
  ],
  "slack": [
    {
      "address": "assistant",
      "botToken": "xoxb-...",
      "appToken": "xapp-..."
    }
  ]
}`}</Code>
      </FileSpec>

      <p style={proseP}>
        Three fields are common to every bundled transport's entry. The rest —
        credentials, allowlists — are transport-specific and documented on each leaf page.
      </p>

      <FieldTable
        fields={[
          {
            name: 'address',
            type: 'string',
            required: true,
            effect: (
              <>
                Canonical agent address this entry routes to. Resolved against the
                server's address book at startup.
              </>
            ),
          },
          {
            name: 'channel',
            type: 'string',
            effect: (
              <>
                Channel preset for conversations this transport opens. Falls back to the
                agent's default channel when omitted.
              </>
            ),
          },
          {
            name: 'streaming',
            type: 'boolean',
            default: 'true',
            effect: (
              <>
                When true, responses stream with live edit-in-place. Set false to drop
                preview frames and deliver one sealed message. No admin field yet —
                hand-edit <code>routes.json</code> to flip it.
              </>
            ),
          },
        ]}
      />

      <Callout kind="security">
        Transports have <strong>no separate secrets file</strong>. Unlike extensions,
        credentials live as fields inside the <code>routes.json</code> entry itself. The
        admin form masks the credential inputs, but on disk they sit in the same JSON as
        the routing — treat <code>routes.json</code> as a secret.
      </Callout>

      <H2>Lifecycle & hot-reload</H2>
      <p style={proseP}>
        At startup the server walks the registry against <code>routes.json</code>,
        validates each slice through the transport's schema, constructs the instances, and
        calls <code>connect()</code>. A failure in one transport is logged and skipped — it
        doesn't block the others. Editing <code>routes.json</code> triggers a reconcile:
        new transports connect <em>before</em> the old ones disconnect, so there's no
        outbound gap.
      </p>

      <H2>Authoring your own</H2>
      <p style={proseP}>
        For building a new transport — Discord, SMS, a custom webhook bridge — see{' '}
        <DocsLink href="/docs/transports/build">Creating a transport</DocsLink>.
      </p>
    </DocsLayout>
  );
}
