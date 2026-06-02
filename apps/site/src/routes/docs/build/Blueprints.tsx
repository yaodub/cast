import { DocsLayout, H2, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { Code } from '../../../components/ui/Code';
import { FileSpec } from '../../../components/docs/FileSpec';
import { ExtensionsServicesFigure } from '../../../components/docs/ExtensionsServicesFigure';

export function BuildBlueprints() {
  return (
    <DocsLayout
      url="/docs/build/blueprints"
      crumbs={['docs', 'build agents', 'authoring blueprints']}
      title="Authoring blueprints"
      lede="The blueprint is what makes the agent itself — identity, channels, capabilities. Markdown for who it is, JSON for its settings; the same files travel when you ship it."
      toc={[
        { label: 'Identity — who the agent is' },
        { label: 'Channels — the dynamic surface' },
        { label: 'Props — settings and capabilities' },
        { label: 'Agent-wide vs channel-specific' },
        { label: 'Agent service' },
        { label: 'What to read next' },
      ]}
    >
      <p style={proseP}>
        Three core surfaces under <code>blueprint/</code>:{' '}
        <strong>identity</strong> (markdown, rides every turn),{' '}
        <strong>channels</strong> (configured separately under{' '}
        <code>blueprint/channels/&lt;name&gt;/</code> — see{' '}
        <DocsLink href="/docs/concepts/channels">Channels</DocsLink> for the model),
        and <strong>props</strong> (JSON + a cron text file, server-consumed). Plus two
        optional add-ons: <code>service/</code> for host code (covered in{' '}
        <DocsLink href="/docs/build/services">Writing services</DocsLink>) and{' '}
        <code>assets/</code> for static read-only data mounted at{' '}
        <code>/assets</code>.
      </p>

      <H2>Identity — who the agent is</H2>
      <p style={proseP}>
        Four optional markdown files under <code>blueprint/identity/</code>. The server
        reads each as raw markdown and injects it into the agent's <DocsLink href="/docs/runtime/context">system prompt</DocsLink> on
        every turn. Identity is where most authoring happens — and every line is paid
        for on every conversation, forever.
      </p>

      <FileSpec name="prompt.md" meta="markdown · raw">
        <p style={proseP}>
          Core persona and behavior instructions. Voice, mandate, posture, hard rules.
          Injected as-is, no wrapper. No required structure; write it like a
          carefully-worded brief to a new colleague. Keep it scaffolding, not
          prescription — discipline in{' '}
          <DocsLink href="/docs/build/designing-well">Designing well</DocsLink>.
        </p>
      </FileSpec>

      <FileSpec name="whoami.md" meta="markdown · structured facts">
        <p style={proseP}>
          Stable identity facts the agent should always know about itself: name, role,
          preferences, persistent constraints. Conventionally bulleted, but the file is
          markdown — anything goes. Wrapped in <code>&lt;agent-identity&gt;</code>.
        </p>
        <Code lang="markdown" noHead>{`- Name: Smith
- Role: research assistant
- Operator: Alex (timezone: America/New_York)
- Always answer in plain text — no markdown rendering on the client.
`}</Code>
      </FileSpec>

      <FileSpec name="skills.md" meta="markdown · bullets, one line per tool">
        <p style={proseP}>
          Tool-usage guidance. One short bullet per tool or skill. Tutorial-prose here
          pays tokens on every conversation that loads the tool. Wrapped in{' '}
          <code>&lt;agent-skills&gt;</code>.
        </p>
        <Code lang="markdown" noHead>{`- task__schedule: defer self-actions to a future time; payload becomes the next session's input.
- web__fetch: fetch a URL and clean it through markdown/crawl4ai/raw pipelines.
- message_log__search: search past messages by keyword in the current conversation's history.
`}</Code>
      </FileSpec>

      <FileSpec name="peers.md" meta="markdown · peer aliases + channel + mechanism">
        <p style={proseP}>
          Declaration of intent: which peer agents this agent expects to consult, by
          alias, on which channels, for what purpose. Free-form markdown; conventionally
          one section per peer with bullet attributes. Wrapped in{' '}
          <code>&lt;agent-peers&gt;</code>.
        </p>
        <Code lang="markdown" noHead>{`## research-agent

Holds the shared research notebook and reference corpus.

- target_agent: \`research-agent\`
- channel: \`lookup\`
- mechanism: \`<cast:query target="research-agent" channel="lookup">…</cast:query>\`
- use for: looking up cited sources, checking definitions, finding prior work
`}</Code>
        <Callout kind="tip">
          <code>peers.md</code> names peers by <strong>alias</strong>, not by canonical
          key. Aliases are role-named slots the install resolves at lookup time. The
          actual ACL bits that authorize the edge live in <code>config/acl.json</code>{' '}
          (per install), not here. Only list peers the agent actually queries.
        </Callout>
      </FileSpec>

      <H2>Channels — the dynamic surface</H2>
      <p style={proseP}>
        Channels are configured under <code>blueprint/channels/&lt;name&gt;/</code> —
        one directory per channel, containing <code>channel.json</code> (lifecycle,
        tools, sharding) and the lifecycle markdown files (<code>prompt.md</code>,{' '}
        <code>bootstrap.md</code>, <code>cleanup.md</code>). Most agents start with
        just <code>default</code> — the implicit fallback (30 min idle, no lifecycle,
        logged) is a working user-chat config without any <code>channel.json</code>.
      </p>
      <p style={proseP}>
        The deep treatment — file shapes, conversation lifecycle, memory continuity,
        sharding, and when a second channel earns its place — lives on{' '}
        <DocsLink href="/docs/concepts/channels">Channels</DocsLink>.
      </p>

      <H2>Props — settings and capabilities</H2>
      <p style={proseP}>
        Three files under <code>blueprint/props/</code>, server-consumed (not mounted
        into the container).
      </p>

      <FileSpec name="settings.json" meta="json · profile + env">
        <Code lang="json" noHead>{`{
  "profile": "standard",
  "env": { "TZ": "America/New_York" }
}`}</Code>
        <p style={proseP}>
          <code>profile</code> is <code>standard</code> or <code>minimal</code> —
          chooses the behavioral baseline (filesystem conventions, tool descriptions)
          injected as prompt layers 2–3. <code>env</code> overrides environment
          variables on the agent runner process.
        </p>
      </FileSpec>

      <FileSpec name="capabilities.json" meta="json · extension + capability declarations">
        <p style={proseP}>
          Agent-wide tool restrictions, extension declarations, resource-slot
          declarations, Python package allowlists, external MCP server declarations —
          everything that decides what the agent <em>can</em> do at all.
        </p>
        <Code lang="json" noHead>{`{
  "disabled_tools": ["bash"],
  "additional_disabled_tools": { "unlocked": true, "value": [] },

  "pip": {
    "allowed_packages": ["requests", "pandas"],
    "extra_packages":   { "unlocked": true, "value": [] }
  },

  "resources": {
    "notes_dir": { "description": "Author's notes folder", "access": "ro", "required": true },
    "scratch":   { "access": "rw" }
  },

  "extensions": {
    "email": {
      "enabled": true,
      "channel": "email",
      "send_mode":        { "unlocked": true, "value": "disabled" },
      "read_window_days": { "unlocked": true, "value": 7 }
    }
  },

  "mcp_servers": {
    "github": {
      "transport": "stdio",
      "command":   "npx",
      "args":      ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_TOKEN":       { "unlocked": true, "required": true, "description": "PAT with repo scope" },
        "GITHUB_API_VERSION": "2022-11-28"
      }
    }
  }
}`}</Code>
        <p style={proseP}>
          Several fields take one of two forms: a bare value (locked — the operator
          can't override it) or <code>{`{ unlocked: true, value: ... }`}</code>{' '}
          (operator-fillable). The pattern shows up on{' '}
          <code>additional_disabled_tools</code>, <code>pip.extra_packages</code>, MCP
          env slots, and individual extension config fields. The decision is yours: lock
          fields that are part of the agent's identity or safety contract; unlock fields
          that legitimately vary per install — a credential, a calendar URL, the hour of
          a daily digest. Operator writes to locked fields are silently ignored at merge
          time.
        </p>
        <p style={proseP}>
          Slots and unlocked fields declared here are filled in by the operator —
          resources and pip in <code>config/provisions.json</code>, MCP env values in{' '}
          <code>config/mcp-servers.json</code>, extension overrides under{' '}
          <code>config/ext/&lt;name&gt;/</code>. See{' '}
          <DocsLink href="/docs/build/configuration">Configuring agents</DocsLink>. The
          deep treatment — what extensions are, how they differ from MCP, when to reach
          for an agent service — is on{' '}
          <DocsLink href="/docs/concepts/capabilities">Capabilities</DocsLink>.
        </p>
      </FileSpec>

      <FileSpec name="schedule.txt" meta="plain text · cron lines">
        <p style={proseP}>
          One line per scheduled self-message. Standard 5-field cron expression, then
          target channel (optionally <code>name/qualifier</code> for sharded channels),
          then the message text. Lines starting with <code>#</code> are comments.
        </p>
        <Code lang="bash" noHead>{`# minute hour dom month dow  channel[/qualifier]  message text...
0 9 * * *      default      Time for the morning briefing.
30 17 * * 5    reflection   Friday wrap-up — what shipped this week?
*/15 * * * *   default/poll Check the inbox.
`}</Code>
        <p style={proseP}>
          Messages are self-addressed — the agent receives its own message on the
          named channel. For cadences the agent or user decides at runtime, use the{' '}
          <DocsLink href="/docs/runtime/tools#task__schedule"><code>task__schedule</code></DocsLink> MCP tool instead; <code>schedule.txt</code> is for
          cadences the author fixes.
        </p>
      </FileSpec>

      <H2>Agent-wide vs channel-specific</H2>
      <p style={proseP}>
        Each directive belongs in one place — identity for rules that apply to every
        channel, the channel folder for rules that only apply to one.
      </p>
      <ul style={proseUl}>
        <li>
          <strong>Would this be true on every channel the agent will ever have?</strong>{' '}
          → identity (<code>prompt.md</code>). <em>"Always summarize before
          closing,"</em> <em>"never write outside /memory/."</em>
        </li>
        <li>
          <strong>Does it depend on which entry point is in play?</strong> → channel
          (<code>channels/&lt;name&gt;/prompt.md</code>).{' '}
          <em>"Wrap turns in <DocsLink href="/docs/runtime/wire-format">{`<cast:internal>`}</DocsLink> unless something genuinely warrants the
          user"</em> only makes sense in a quiet processing channel.{' '}
          <em>"On first turn, load the previous run's summary"</em> belongs in{' '}
          <code>bootstrap.md</code>.
        </li>
      </ul>

      <H2>Agent service</H2>
      <p style={proseP}>
        An agent service is where Cast's ceiling actually sits — host-side code under{' '}
        <code>blueprint/service/</code> that wraps any system (an internal API, a CLI,
        a private search index, a webhook listener) and exposes it to the agent as
        tools. It's how a Cast agent gets reach into the systems you actually work in.
      </p>

      <ExtensionsServicesFigure caption="Extensions and the agent service" />

      <p style={proseP}>
        Extensions stay the curated path — email, calendar, web-fetch, whatsapp —
        engineered for safety and token discipline, ready for anyone. A service is the
        open path: full credentials on the host, every safeguard you write yourself.
        The trade-off is the deal, and the reason it's a power-user surface. The deep
        treatment is in <DocsLink href="/docs/build/services">Writing services</DocsLink>.
      </p>

      <H2>What to read next</H2>
      <ul style={proseUl}>
        <li>
          <DocsLink href="/docs/build/configuration">Configuring agents</DocsLink> —
          the companion: how the blueprint gets wired to your install (model, ACL,
          secrets).
        </li>
        <li>
          <DocsLink href="/docs/concepts/channels">Channels</DocsLink> — what each{' '}
          <code>blueprint/channels/&lt;name&gt;/</code> folder configures, and the
          patterns multi-channel agents enable.
        </li>
        <li>
          <DocsLink href="/docs/concepts/capabilities">Capabilities</DocsLink> —
          extensions, agent services, external MCP; when to reach for which.
        </li>
        <li>
          <DocsLink href="/docs/build/multi-agent">Multi-agent composition</DocsLink> —
          when one agent isn't enough; how channels become the contract between them.
        </li>
        <li>
          <DocsLink href="/docs/build/designing-well">Designing well</DocsLink> — the
          discipline above the parts.
        </li>
      </ul>
    </DocsLayout>
  );
}
