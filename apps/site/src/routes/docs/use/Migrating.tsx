import { DocsLayout, H2, H3, proseP, proseUl, proseTable, proseTh, proseTd } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { LiveDangerouslyFigure, PlayItSafeFigure } from '../../../components/docs/TwoPathsFigure';

export function UseMigrating() {
  return (
    <DocsLayout
      url="/docs/use/migrating"
      crumbs={['docs', 'use cast', 'migrating']}
      title="Migrating from other platforms"
      lede="Cast doesn't ship a migration tool. Translating an existing agent runs through Claude Code — you describe what should come over, it reads your source and writes the equivalent Cast structure."
      toc={[
        { label: 'The security trade' },
        { label: 'Bringing your skills over' },
        { label: 'Bringing in a new transport' },
        { label: 'The translator: Claude Code' },
        { label: 'Conceptual mapping' },
        { label: 'What comes over' },
        { label: 'From OpenClaw' },
        { label: 'From Hermes' },
        { label: 'From other Claude-SDK projects' },
        { label: 'Where this is heading' },
        { label: 'What to read next' },
      ]}
    >
      <p style={proseP}>
        If your agent already lives on OpenClaw, Hermes, or a homegrown
        Claude Agent SDK project, the translation into Cast is mostly
        mechanical — but Cast has a stricter security model than these
        platforms, and a few of the migration paths reflect that.
      </p>

      <H2>The security trade</H2>
      <p style={proseP}>
        Cast runs each agent in its own container and won't load third-party
        plugins into its server process. That costs you stricter identity
        checks on inbound messages and re-homing plugins that used to run in
        the gateway. It buys you skills that can't reach the host,
        identity-faking bugs that don't compile, and channel compromises
        that stay scoped.
      </p>

      <H2>Bringing your skills over</H2>
      <p style={proseP}>
        OpenClaw and Hermes have deep skill catalogs; Cast's is just getting
        going. Most migrations bring over a capability no Cast extension
        covers yet, and there are two ways to handle it.
      </p>
      <p style={proseP}>
        The first is to widen the agent's reach — open up its network, give
        it broad host access, and let a skill instruct it to do the thing
        directly.
      </p>

      <LiveDangerouslyFigure caption="live dangerously" />

      <p style={proseP}>
        Cheap to set up, but the trust boundary now sits in the agent's
        head. A prompt injection or a confused turn that nudges the agent
        off-path scales its damage to whatever reach you opened up. The
        Cast-native alternative is to put the reach in code instead — write
        an agent service that does what the migrated skill did, host-side,
        and let the agent call it through a constrained set of MCP tools.
      </p>

      <PlayItSafeFigure caption="play it safe" />

      <p style={proseP}>
        Most migrated capabilities land here — it preserves what the source
        platform did (operator-authored code with real reach) while keeping
        the agent's view of it narrow. See{' '}
        <DocsLink href="/docs/build/services">Writing services</DocsLink>{' '}
        for the authoring shape.
      </p>

      <H2>Bringing in a new transport</H2>
      <p style={proseP}>
        If the migration includes a platform Cast doesn't bundle — Discord,
        Signal, Matrix, iMessage, anything beyond the small set Cast ships
        with — you add it as a new transport. Transports live in your Cast
        server's source tree and are registered at startup; unlike services
        and extensions, they aren't per-agent. One transport serves every
        agent on the install. See{' '}
        <DocsLink href="/docs/transports/build">Building a transport</DocsLink>{' '}
        for the contract and a worked example.
      </p>
      <H2>The translator: Claude Code</H2>
      <p style={proseP}>
        A host-side Claude Code session is the right surface for migration
        work. It has the full advanced-mode envelope: it reads your source
        platform's configs and code from anywhere on disk, then writes into
        a Cast agent folder. The in-Cast consoles can't do this — they don't
        have host access.
      </p>
      <p style={proseP}>
        Open Claude Code in the Cast repo. Point it at your existing source
        and describe what you want preserved: persona, memory, the channels
        the agent talks on, the integrations it uses. It'll propose a{' '}
        <code>blueprint/</code> structure and translate piece by piece.
        Iterate with the agent running locally; tighten as you discover what
        the source was doing that Cast handles differently.
      </p>

      <H2>Conceptual mapping</H2>
      <p style={proseP}>
        Most platforms hide the same primitives behind different names. The
        rough shape of how source concepts land in Cast:
      </p>
      <table style={proseTable}>
        <thead>
          <tr>
            <th style={proseTh}>Source concept</th>
            <th style={proseTh}>Cast destination</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={proseTd}>Agent persona, system prompt</td>
            <td style={proseTd}><code>blueprint/identity/*</code></td>
          </tr>
          <tr>
            <td style={proseTd}>Memory and state files</td>
            <td style={proseTd}><code>memory/</code>, <code>state/</code></td>
          </tr>
          <tr>
            <td style={proseTd}>Tool / function plugin (in-process)</td>
            <td style={proseTd}><DocsLink href="/docs/build/services">service</DocsLink> (per-agent custom code) or <DocsLink href="/docs/extensions">extension</DocsLink> (shipping across agents) or external MCP server</td>
          </tr>
          <tr>
            <td style={proseTd}>Background sync job, multi-source orchestration</td>
            <td style={proseTd}><DocsLink href="/docs/build/services">Service</DocsLink></td>
          </tr>
          <tr>
            <td style={proseTd}>Channel / platform adapter (bidirectional)</td>
            <td style={proseTd}><DocsLink href="/docs/transports">transport</DocsLink> + <DocsLink href="/docs/extensions">extension</DocsLink> — see callout</td>
          </tr>
          <tr>
            <td style={proseTd}>Skill — prose only</td>
            <td style={proseTd}>Identity prose for now; native skill loader pending</td>
          </tr>
          <tr>
            <td style={proseTd}>Skill — with scripts</td>
            <td style={proseTd}>Prose into identity; scripts into the agent's container</td>
          </tr>
          <tr>
            <td style={proseTd}>MCP server config</td>
            <td style={proseTd}>Cast's MCP proxy reads the same MCP-spec shape</td>
          </tr>
          <tr>
            <td style={proseTd}>Cron / scheduled jobs</td>
            <td style={proseTd}><code>schedule.txt</code> (design-time) or <DocsLink href="/docs/runtime/tools#task__schedule"><code>task__schedule</code></DocsLink> (runtime)</td>
          </tr>
          <tr>
            <td style={proseTd}>Webhook receiver</td>
            <td style={proseTd}><DocsLink href="/docs/build/services">Agent service</DocsLink> (no built-in webhook transport yet)</td>
          </tr>
          <tr>
            <td style={proseTd}>Multi-user surface</td>
            <td style={proseTd}>Per-participant conversations via access grants; channel ACL</td>
          </tr>
          <tr>
            <td style={proseTd}>Model-provider plugin</td>
            <td style={proseTd}>Not migratable — Cast is Claude-only</td>
          </tr>
          <tr>
            <td style={proseTd}>Memory backend / context-engine plugin</td>
            <td style={proseTd}>No slot — would need a custom service</td>
          </tr>
        </tbody>
      </table>

      <Callout kind="jargon">
        <strong>Why does one channel plugin become two Cast artifacts?</strong>{' '}
        On most platforms a "channel" handles inbound routing and
        agent-callable tools on the same protocol in one bundle. Cast splits
        them: a transport handles the wire, an extension provides the MCP
        tools the agent calls. The two roles have different security postures
        — the transport injects identity into every inbound message; the
        extension hands the agent a protocol it can drive — and the split is
        what lets branded identity types rule out a whole class of bugs at
        compile time. Cost on import: you write two Cast files, not one.
      </Callout>

      <H2>What comes over</H2>

      <H3>Cleanly</H3>
      <ul style={proseUl}>
        <li>Persona prose (SOUL.md, AGENTS.md, IDENTITY.md) — copy and rename into <code>blueprint/identity/</code></li>
        <li>Memory text files (MEMORY.md, USER.md) — copy into <code>memory/</code></li>
        <li>MCP server configurations — Cast reads the same MCP-spec shape</li>
        <li>Channels for protocols Cast already ships (Telegram, Slack, web, CLI)</li>
        <li>Pure-prose skills — paste into identity for now (loader pending; see below)</li>
      </ul>

      <H3>With hand-rewriting</H3>
      <p style={proseP}>
        Code-bearing skills split: the scripts drop into the agent's
        container (Cast agents have shell and Python natively); the prose
        lands as a skill or identity fragment. Everything else — tool
        plugins, webhook receivers, multi-source orchestration — becomes a
        service.
      </p>

      <H3>Not yet</H3>
      <ul style={proseUl}>
        <li>
          <strong>Model-provider plugins.</strong> Cast is Claude-only by
          deliberate design. The agent runner has no provider-abstraction
          layer to plug into.
        </li>
        <li>
          <strong>Memory backend and context-engine plugins.</strong> Cast's
          prompt assembly and memory layout are fixed. No plugin slot exists
          to swap them out.
        </li>
        <li>
          <strong>Lifecycle hooks beyond what Cast emits.</strong> Cast
          surfaces a handful of events (turn start, tool call, message
          delivery); platforms with rich hook surfaces have many that simply
          don't fire here.
        </li>
      </ul>

      <H2>From OpenClaw</H2>
      <p style={proseP}>
        Persona files (AGENTS.md, SOUL.md, IDENTITY.md, USER.md) drop into{' '}
        <code>blueprint/identity/</code> and <code>memory/</code> with light
        reformatting. Channel allowlists translate to Cast's channel ACL.
        MCP-configured tools come over via Cast's MCP proxy.
      </p>
      <p style={proseP}>
        One quirk worth knowing: OpenClaw "agents" share one gateway process
        — per-agent directories namespace state, not execution. A user with
        five OpenClaw agents may actually be modeling five channels of one
        identity, and Claude Code should ask which of those you want before
        scaffolding. ClawHub plugins don't transfer wholesale, but most tool
        plugins become services (or extensions if you want them shared);
        pure-prose skills come over cleanly.
      </p>

      <H2>From Hermes</H2>
      <p style={proseP}>
        One profile, one Cast agent. Hermes profiles (
        <code>~/.hermes/profiles/&lt;name&gt;/</code>) are full isolates with
        their own <code>config.yaml</code>, <code>.env</code>,{' '}
        <code>SOUL.md</code>, memories, sessions, skills, cron, state.db, and
        auth.json. That maps cleanly to a Cast agent folder.
      </p>
      <p style={proseP}>
        Platform adapters (<code>gateway/platforms/&lt;x&gt;.py</code>)
        become Cast Transports — Claude Code handles the Python-to-TypeScript
        rewrite. Backend plugins like spotify or image_gen become services
        (or extensions if you want them shared). Per-profile{' '}
        <code>mcp_servers</code> translate to Cast's MCP proxy. Cron becomes{' '}
        <code>schedule.txt</code>. Prose-only skills come straight over;
        skills with <code>scripts/</code> drop their scripts into the agent's
        container.
      </p>

      <H2>From other Claude-SDK projects</H2>
      <p style={proseP}>
        For a homegrown Claude Agent SDK project, the lift is mostly wrapping
        your loop in Cast's container model and inheriting the surfaces a
        bare SDK doesn't have opinions about — memory layout, access,
        scheduling, channels, ACL. Two paths: drop your loop into the agent's
        container as a custom runner (preserves your code), or restructure
        into Cast's blueprint shape and let the standard runner take over
        (inherits access, identity, and ACL for free). The standard runner
        is the cleaner long-term move.
      </p>

      <H2>Where this is heading</H2>
      <p style={proseP}>
        Three surfaces that would lower migration cost. None ship today —
        name-checked here because they shape the when-to-migrate decision.
      </p>
      <ul style={proseUl}>
        <li>
          <strong>Mechanical migration — scripts or Cast skills.</strong>{' '}
          Today every migration is bespoke through Claude Code. A repeatable
          importer — a CLI script, or a Cast skill an agent can invoke
          against a source folder — for the well-known OpenClaw and Hermes
          patterns would compress the common cases from hours to minutes,
          leaving Claude Code for the parts that actually need it.
        </li>
        <li>
          <strong>A skill loader for the agentskills.io format.</strong>{' '}
          Most prose-only skills from the OpenClaw and Hermes catalogs would
          import without intervention. Until then, the prose pastes into
          identity by hand.
        </li>
        <li>
          <strong>Built-in webhook ingestion as a transport.</strong>{' '}
          Both OpenClaw and Hermes treat webhooks (Gmail Pub/Sub, third-party
          callbacks) as built-in. Cast handles them through agent services
          today; a generic webhook transport would lift them onto the same
          surface as Telegram or Slack.
        </li>
      </ul>

      <H2>What to read next</H2>
      <ul style={proseUl}>
        <li>
          <DocsLink href="/docs/quickstart">Quickstart</DocsLink> — get a Cast
          install running before you migrate into it.
        </li>
        <li>
          <DocsLink href="/docs/build/blueprints">Authoring blueprints</DocsLink>{' '}
          — the shape you're translating into.
        </li>
        <li>
          <DocsLink href="/docs/extensions">Extensions</DocsLink> and{' '}
          <DocsLink href="/docs/transports">Transports</DocsLink> — the two
          surfaces source-platform "channels" and "plugins" split into.
        </li>
        <li>
          <DocsLink href="/docs/build/designing-well">Designing well</DocsLink>{' '}
          — the economy lens to apply once translation is done.
        </li>
      </ul>
    </DocsLayout>
  );
}
