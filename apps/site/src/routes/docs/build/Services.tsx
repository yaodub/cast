import { DocsLayout, H2, H3, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { Code } from '../../../components/ui/Code';
import { FileSpec } from '../../../components/docs/FileSpec';

export function BuildServices() {
  return (
    <DocsLayout
      url="/docs/build/services"
      crumbs={['docs', 'build agents', 'writing services']}
      title="Writing services"
      lede="A service is host-side code bound to one agent. It does what no extension can — and every guardrail is yours to write."
      toc={[
        { label: 'Reach traded for responsibility' },
        { label: 'When to reach for one' },
        { label: 'Three handles into the agent' },
        { label: 'The contract' },
        { label: 'Lifecycle, and what you owe' },
        { label: 'What to read next' },
      ]}
    >
      <p style={proseP}>
        A service lives under <code>blueprint/service/</code> and ships with the
        blueprint. The server spawns it as a child process when the agent starts,
        supervises it across crashes, and shuts it down with the agent. It is the
        agent's private back-end — same trust as installing a package on your
        machine, because that's effectively what it is.
      </p>

      <H2>Reach traded for responsibility</H2>
      <p style={proseP}>
        A service runs <em>outside</em> the agent's container, on the host. Full
        network. Full host filesystem. Full credentials from{' '}
        <code>config/ext/service/.env</code>. The sandbox the agent runs inside
        does not apply. That is what makes services useful for the work no
        extension covers — an internal API behind a VPN, multi-account
        orchestration, an OAuth callback listener, a CLI that lives on your
        machine, anything that wants credentials the agent should never see.
      </p>
      <p style={proseP}>
        It is also what makes the trade real. Token discipline, approval gates,
        prompt-injection guards, capability gating — none of what the framework
        gives <DocsLink href="/docs/extensions">extensions</DocsLink> for free
        comes with a service. The author writes those guardrails by hand if the
        work needs them, or accepts their absence.
      </p>
      <Callout kind="security">
        Every line of service code runs with operator trust. A blueprint with a
        service is, for the operator who installs it, a package they're choosing
        to run on their host. Author services with that on the table — and when
        you ship a blueprint that contains one, name in the README what the
        service does and what credentials it expects.
      </Callout>

      <H2>When to reach for one</H2>
      <p style={proseP}>
        A service is not the first reach. Before writing one, check the two
        cheaper options.
      </p>
      <ul style={proseUl}>
        <li>
          <strong>A bundled extension does the job.</strong> Email, calendar,
          web-fetch, whatsapp ship with Cast and are engineered for safety and
          token discipline. If one fits, enable it in{' '}
          <code>capabilities.json</code> and move on. The full list is on{' '}
          <DocsLink href="/docs/extensions">Extensions</DocsLink>.
        </li>
        <li>
          <strong>A reputable third-party MCP server does the job.</strong> Cast
          can plug an external MCP server straight into the agent — no wrapper
          code. The trust posture is different (third-party code, no framework
          surfaces) but for read-only tools from a vendor you trust, it's the
          shorter path. See{' '}
          <DocsLink href="/docs/concepts/capabilities">Capabilities</DocsLink>{' '}
          for the trade-offs.
        </li>
      </ul>
      <p style={proseP}>
        A service is the right reach when the work has <em>state outside the
        conversation</em> — a long-running connection, a scheduled sync, a
        webhook listener, a queryable index that persists across sessions — or
        when the work needs host credentials the container should never see. If
        the work is a single stateless tool call, an extension or an MCP server
        is almost always the better shape.
      </p>
      <Callout kind="warn">
        Don't write a service to escape an extension's discipline. If the email
        extension's approval gate is in your way, the fix is in its config — not
        a custom email service that ships the gate off the boat. Services exist
        to extend reach, not to slip safety.
      </Callout>

      <H2>Three handles into the agent</H2>
      <p style={proseP}>
        A service has three ways to affect what the agent does. Most useful
        services use two of three; few need all three. Knowing which handle a
        given concern wants is the design decision that shapes everything else
        about the service.
      </p>

      <H3>MCP tools — synchronous, agent-pulled</H3>
      <p style={proseP}>
        The service hosts an MCP server on a Unix socket at{' '}
        <code>mcp/agent.sock</code> inside the agent folder. The agent runner
        discovers the socket on startup and the tools appear in the agent's tool
        list — indistinguishable, from the agent's side, from any other tool.
        The agent calls; the service answers; the result lands in the next turn.
        Use this handle when the agent needs to ask.
      </p>
      <Code lang="ts" title="src/index.ts (excerpt)">{`svc.tool(
  'crm__search',
  'Search the CRM by company name or domain.',
  { query: z.string(), limit: z.number().default(10) },
  async ({ query, limit }) => {
    const rows = await db.search(query, limit);
    return { content: [{ type: 'text', text: format(rows) }] };
  },
);`}</Code>

      <H3>Pushes — asynchronous, service-initiated</H3>
      <p style={proseP}>
        The service can drop a message into one of the agent's channels at any
        time — when a webhook fires, when a poll surfaces new data, when a long
        job finishes. The push opens a conversation on the named channel (or
        wakes an existing one) and the agent runs a turn with the message as
        input. Use this handle when something outside the agent's awareness
        happens and the agent should react.
      </p>
      <Code lang="ts" title="src/index.ts (excerpt)">{`const fresh = await pollCRM();
if (fresh.length > 0) {
  await svc.routeMessage(
    'inbox',
    \`\${fresh.length} new CRM leads — see /shared/service/leads.json\`,
  );
}`}</Code>

      <H3>Prompt context — passive, every turn</H3>
      <p style={proseP}>
        Writing <code>shared/ext/service/agent-context.md</code> contributes a
        block to the agent's <DocsLink href="/docs/runtime/context">system prompt</DocsLink>, wrapped in{' '}
        <code>&lt;service-context&gt;</code>, on every turn the agent runs. Use
        this handle to teach the agent what's available right now — which
        sources are synced, which tools are live, what state the service is in
        — without making the agent ask first.
      </p>
      <Code lang="ts" title="src/index.ts (excerpt)">{`svc.prompt.set('crm', \`## CRM
- \${count} leads synced (last poll \${ts})
- query with crm__search; data lives in /shared/service/leads.json\`);
svc.prompt.commit();`}</Code>
      <Callout kind="tip">
        This handle is load-bearing — and re-pays every turn forever. The
        discipline{' '}
        <DocsLink href="/docs/build/designing-well">Designing well</DocsLink>{' '}
        asks of <code>prompt.md</code> applies here too: write the one paragraph
        the agent needs to know right now, not a dump of everything the service
        could say. A growing <code>agent-context.md</code> is one of the most
        expensive mistakes a service author makes.
      </Callout>

      <H2>The contract</H2>
      <p style={proseP}>
        Small and explicit. A manifest, an entrypoint, three runtime directories
        with different write semantics, and one env var the server hands the
        process. The SDK,{' '}
        <code>@getcast/agent-service-base</code>, wraps the IPC handshake, the
        MCP socket, the prompt-context writer, and credential loading. A useful
        service is around thirty lines.
      </p>

      <FileSpec name="blueprint/service/manifest.json" meta="json · identity + entrypoint">
        <Code lang="json" noHead>{`{
  "name": "crm",
  "version": "0.1.0",
  "entry": "src/index.ts"
}`}</Code>
        <p style={proseP}>
          All fields optional. <code>name</code> and <code>version</code> are
          informational. <code>entry</code> resolves relative to{' '}
          <code>blueprint/service/</code>; a <code>.ts</code> or{' '}
          <code>.tsx</code> entry runs with <code>tsx</code>, anything else with{' '}
          <code>node</code>. With no <code>entry</code>, the server looks for{' '}
          <code>index.js</code>. With no manifest, no service.
        </p>
      </FileSpec>

      <FileSpec name="blueprint/service/" meta="source · portable, ships with the blueprint">
        <p style={proseP}>
          Your service source. During development, set{' '}
          <code>"entry": "src/index.ts"</code> and the server runs the
          TypeScript directly via <code>tsx</code> on every startup. For
          distribution, bundle to <code>index.js</code> (esbuild, node20) so
          operators don't need a TypeScript toolchain to install your blueprint.
        </p>
      </FileSpec>

      <FileSpec name="ext/service/" meta="runtime · private state, service CWD">
        <p style={proseP}>
          Server-created, the process's working directory. Your scratch space —
          SQLite databases, caches, OAuth tokens, anything the service alone
          needs to remember. Not mounted into the agent's container.
        </p>
      </FileSpec>

      <FileSpec name="shared/ext/service/" meta="runtime · agent-visible output">
        <p style={proseP}>
          Mounted read-only into the agent's container at{' '}
          <code>/shared/service</code>. Anything the agent should be able to
          read — a JSON dump for a tool to grep, an attachment to reference, the
          dynamic <code>agent-context.md</code> — goes here. The service writes;
          the agent reads.
        </p>
      </FileSpec>

      <FileSpec name="config/ext/service/.env" meta="config · operator-owned secrets">
        <p style={proseP}>
          Operator territory, not part of the blueprint, not committed. The SDK
          loads it for you as <code>svc.secrets</code>. When you ship a
          blueprint with a service, document which keys the operator needs to
          fill — the install can't be completed without them.
        </p>
      </FileSpec>

      <p style={proseP}>
        The raw IPC message catalog and the full <code>CAST_SERVICE_CONFIG</code>{' '}
        env shape live in <code>packages/agent-schema/src/v1/SPEC.md</code> §9.
        Reach for them only when writing a service without the SDK.
      </p>

      <H2>Lifecycle, and what you owe</H2>
      <p style={proseP}>
        The framework supervises the process so the author doesn't have to.
        Start with the agent. Restart on crash with jittered exponential backoff
        (one second to thirty). Trip a breaker if five crashes land inside five
        minutes — the service moves to <code>failed</code> and waits for an
        operator to restart it from the console, instead of looping forever.
        Graceful shutdown on a shutdown message, five seconds, then{' '}
        <code>SIGKILL</code>. Daemonization, restart loops, crash budgets — not
        your code to write.
      </p>
      <p style={proseP}>
        In return, the discipline the framework can't enforce:
      </p>
      <ul style={proseUl}>
        <li>
          <strong>No hot-reload.</strong> The entrypoint resolution is cached at
          server start. Edits to service source or manifest take effect on
          server restart, not service restart. The console's restart button
          reruns the existing entrypoint — it does not re-read the manifest.
        </li>
        <li>
          <strong>Log errors to stderr.</strong> What the agent sees when an MCP
          tool throws is whatever the protocol surfaces, often summarized once
          by the LLM before it reaches the operator. The server log is the only
          window into what really failed. <code>console.error</code> the
          exception or it's invisible.
        </li>
        <li>
          <strong>Write only to the dirs you own.</strong>{' '}
          <code>ext/service/</code> and <code>shared/ext/service/</code>.
          Writing into <code>memory/</code>, <code>state/</code>, or{' '}
          <code>config/</code> from a service can corrupt agent or server state
          — and the framework will not stop you.
        </li>
        <li>
          <strong>Keep <code>agent-context.md</code> terse.</strong> Re-paid
          every turn, forever. Same posture as identity files. A paragraph that
          changes shape per state beats a static dump that grows.
        </li>
        <li>
          <strong>Send the ready handshake.</strong> The SDK sends it for you.
          Without it, startup hangs until timeout — so if you bypass the SDK,
          send <code>{`{ type: 'ready' }`}</code> over IPC the moment the
          service is actually serving.
        </li>
      </ul>

      <H2>What to read next</H2>
      <ul style={proseUl}>
        <li>
          <DocsLink href="/docs/concepts/capabilities">Capabilities</DocsLink> —
          the framing this page deepens: extension, service, or external MCP,
          and how to pick.
        </li>
        <li>
          <DocsLink href="/docs/build/blueprints">Authoring blueprints</DocsLink>{' '}
          — the rest of the surfaces a blueprint exposes; the service is one of
          them.
        </li>
        <li>
          <DocsLink href="/docs/build/designing-well">Designing well</DocsLink>{' '}
          — context discipline above the parts; the prompt-context handle in
          particular lives or dies by it.
        </li>
        <li>
          <DocsLink href="/docs/extensions/build">Creating an extension</DocsLink>{' '}
          — when the capability is reusable across agents and ought to ship as
          one.
        </li>
      </ul>
    </DocsLayout>
  );
}
