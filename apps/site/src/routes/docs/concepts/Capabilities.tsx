import { DocsLayout, H2, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { ChatMockup } from '../../../components/site/ChatMockup';

export function ConceptsCapabilities() {
  return (
    <DocsLayout
      url="/docs/concepts/capabilities"
      crumbs={['docs', 'concepts', 'capabilities']}
      title="Capabilities"
      lede="A Cast agent on its own can think and talk. Capabilities are how it acts in the world — reading your email, fetching a page, watching your calendar, messaging a colleague."
      toc={[
        { label: 'Use an extension' },
        { label: 'Write a service' },
        { label: 'Plug in an MCP server' },
        { label: 'What to read next' },
      ]}
    >
      <p style={proseP}>
        Cast deliberately ships with nothing built in. Every capability comes from an
        extension, a service you write, or an MCP server plugged in from outside.
      </p>

      <H2>Use an extension</H2>
      <p style={proseP}>
        An extension wraps a real-world capability — reading email, watching a calendar,
        fetching a page — and exposes it as tools the agent can call. An agent opts in to
        the extensions it needs, and the tools appear. See{' '}
        <DocsLink href="/docs/extensions">Extensions</DocsLink> for what Cast ships with.
      </p>

      <ChatMockup
        agentName="agent"
        script={[
          {
            from: 'user',
            text: 'Did anyone email about the launch?',
          },
          {
            from: 'agent',
            tools: [
              {
                icon: '✉',
                source: 'email',
                detail: 'search inbox — "launch"',
              },
            ],
            text:
              'Three threads this week. Sarah confirmed Tuesday, marketing wants a draft by Friday, and Alex flagged a copy issue.',
          },
        ]}
      />

      <Callout kind="jargon">
        <strong>Aren't these just MCP servers?</strong> Under the hood, an extension's
        tools reach the agent through the same MCP protocol an external MCP server would.
        But an extension does more — it can hold long-running state (an IMAP IDLE
        connection, say), push messages into a conversation, contribute to the agent's
        system prompt, and gate sensitive actions behind approvals. MCP is the wire; an
        extension is the package around it.
      </Callout>

      <H2>Add an agent service</H2>
      <p style={proseP}>
        When you need a capability no extension provides, an agent service fills the gap.
        It is custom, ad-hoc code that runs alongside one specific agent — a private
        extension authored for that agent alone. The service runs on the host, outside
        the sandbox, so its reach is effectively unlimited: any API your machine can talk
        to, any subprocess it can run, any port it can listen on.
      </p>
      <p style={proseP}>
        You author a service in <em>advanced mode</em> — the supervised coding loop. From
        Claude Code, run <code>/cast-build &lt;folder&gt;</code> and describe what
        you want the agent to be able to do. Claude Code writes the code; you review
        every diff before it lands.
      </p>

      <p style={proseP}>What a service can do:</p>
      <ul style={proseUl}>
        <li>
          Hold a long-running connection — websocket, IMAP IDLE, a polling loop — and
          push to the agent the moment something happens.
        </li>
        <li>
          Listen for webhooks: OAuth callbacks, third-party event deliveries, anything
          that calls back to your machine.
        </li>
        <li>
          Talk to internal or proprietary APIs with credentials the agent never sees.
        </li>
        <li>
          Spawn and manage subprocesses — CLIs, Python scripts, anything the host can
          run — and feed the output back to the agent.
        </li>
        <li>
          Maintain a queryable index that persists across conversations, exposed to the
          agent as a search tool.
        </li>
      </ul>

      <Callout kind="jargon">
        Services run host-side, outside the agent's container. That is why the capability
        ceiling is the host's, not the agent's. The trade-off: a service is fully trusted
        code on your machine. See{' '}
        <DocsLink href="/docs/build/services">Writing services</DocsLink> for the
        framework and IPC contract.
      </Callout>

      <H2>Plug in an MCP server</H2>
      <p style={proseP}>
        When someone has already published an MCP server for what you need, Cast can plug
        it in directly — no need to rewrite it as an extension or a service. The
        trade-off lives in the trust column.
      </p>

      <Callout kind="tip">
        External MCP support is experimental for now. Expect rough edges and possible
        breaking changes as it matures.
      </Callout>

      <Callout kind="warn">
        An MCP server is third-party code that can do whatever its code allows. The
        agent reads its tool descriptions and outputs as context, so a compromised server
        can manipulate the agent through either. MCP servers also lack the framework
        surfaces an extension provides — no lifecycle hooks, no typed config, no approval
        gates, no prompt contribution, no way to push into a conversation. Prefer
        reputable vendors and read-only tools when you do use one. For anything
        load-bearing, an extension or a service is the safer reach.
      </Callout>

      <H2>What to read next</H2>
      <ul style={proseUl}>
        <li>
          <DocsLink href="/docs/build/services">Writing services</DocsLink> — the
          authoring guide for an agent service.
        </li>
        <li>
          <DocsLink href="/docs/extensions/build">Build an extension</DocsLink> — how to
          author a brand-new extension to ship to others.
        </li>
        <li>
          <DocsLink href="/docs/concepts/triggers">Scheduling &amp; triggers</DocsLink>{' '}
          — both extensions and services participate in the push pipeline.
        </li>
      </ul>
    </DocsLayout>
  );
}
