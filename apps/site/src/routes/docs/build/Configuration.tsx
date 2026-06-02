import { DocsLayout, H2, proseP, proseUl, proseTable, proseTh, proseTd } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { Code } from '../../../components/ui/Code';
import { FileSpec } from '../../../components/docs/FileSpec';

export function BuildConfiguration() {
  return (
    <DocsLayout
      url="/docs/build/configuration"
      crumbs={['docs', 'build agents', 'configuring agents']}
      title="Configuring agents"
      lede="The blueprint says what the agent is. Configuration says how it runs on this install — model, access, extension credentials."
      toc={[
        { label: 'agent.json — runtime settings' },
        { label: 'acl.json — who can reach the agent' },
        { label: 'provisions.json — resource mounts and operator slots' },
        { label: 'Per-extension config and secrets' },
        { label: 'mcp-servers.json — env values for external MCP servers' },
        { label: 'What to read next' },
      ]}
    >
      <p style={proseP}>
        An agent's configuration is the install-specific layer — model picks, who can
        reach it, the credentials its extensions need. Holding it separate from the
        blueprint keeps the blueprint shippable: one design can run on many installs.
        A handful of files under <code>config/</code> carry it: <code>agent.json</code>{' '}
        for runtime settings, <code>acl.json</code> for access control,{' '}
        <code>provisions.json</code> for resource mounts and operator-fillable slots,
        per-extension subfolders under <code>config/ext/</code> for credentials and
        overrides, and <code>mcp-servers.json</code> for env values on external MCP
        servers.
      </p>

      <H2>agent.json — runtime settings</H2>
      <p style={proseP}>
        Every field is optional; the server fills in defaults. The two that matter
        most: the model the agent runs on, and the container network mode.
      </p>

      <FileSpec name="agent.json" meta="json · operator-set runtime config">
        <Code lang="json" noHead>{`{
  "model": "claude-sonnet-4-5",
  "modelOverrides": [
    { "channel": "reflection", "model": "claude-haiku-4-5" }
  ],
  "containerNetwork": "sdk-only",
  "timezone": "America/New_York"
}`}</Code>
        <ul style={proseUl}>
          <li>
            <code>model</code> — default Claude model the agent runs on. Channels
            inherit unless overridden.
          </li>
          <li>
            <code>modelOverrides</code> — per-channel (optionally per-phase) model
            substitutions. Each entry is{' '}
            <code>{`{ channel, phase?, model }`}</code>. Useful for pinning a cheaper
            model to a lightweight channel.
          </li>
          <li>
            <code>containerNetwork</code> — egress firewall mode.{' '}
            <code>sdk-only</code> (default) lets the agent reach the model provider and
            nothing else; <code>full</code> opens the container to the internet;{' '}
            <code>none</code> disables egress entirely. Pair with{' '}
            <code>containerAllowedEndpoints</code> to permit specific domains.
          </li>
          <li>
            <code>timezone</code> — IANA timezone for cron schedules and time-of-day
            prompts. Falls back to the server's TZ.
          </li>
        </ul>
        <p style={proseP}>
          Other optional knobs: <code>backup</code> (snapshot interval and retention),{' '}
          <code>fileWatch</code> (preview limits), <code>maxOutputBytes</code> (cap on
          user-visible output), <code>showSteps</code> /{' '}
          <code>showConsoleSteps</code> (reasoning-stream visibility).
        </p>
      </FileSpec>

      <H2>acl.json — who can reach the agent</H2>
      <p style={proseP}>
        Access is granted per peer, per channel, as a set of permission bits. An empty{' '}
        <code>peers</code> map means only the owner can talk to the agent.
      </p>

      <FileSpec name="acl.json" meta="json · access control list">
        <Code lang="json" noHead>{`{
  "owner": "local",
  "peers": {
    "research-agent": { "lookup": "q" }
  },
  "reject_message": "Not authorized. Use /pair <code> to get access."
}`}</Code>
        <ul style={proseUl}>
          <li>
            <code>owner</code> — identity with full access. Default <code>"local"</code>{' '}
            (you, on the host).
          </li>
          <li>
            <code>peers</code> — nested map: peer identity → channel name → bit string.
            Channel <code>"*"</code> matches any user-defined channel (not the
            console-only <code>__*</code> channels).
          </li>
          <li>
            <code>reject_message</code> — what unauthorized callers see when denied.
          </li>
        </ul>

        <p style={proseP}>
          Permission bits, all from <em>this agent's</em> view of the edge:
        </p>
        <table style={proseTable}>
          <thead>
            <tr>
              <th style={proseTh}>Bit</th>
              <th style={proseTh}>Direction</th>
              <th style={proseTh}>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr><td style={proseTd}><code>q</code></td><td style={proseTd}>outbound</td><td style={proseTd}>this agent queries the peer; reply enters next-turn context</td></tr>
            <tr><td style={proseTd}><code>r</code></td><td style={proseTd}>outbound</td><td style={proseTd}>this agent queries the peer; reply is dropped before context</td></tr>
            <tr><td style={proseTd}><code>p</code></td><td style={proseTd}>outbound</td><td style={proseTd}>this agent hands its user over to the peer</td></tr>
            <tr><td style={proseTd}><code>a</code></td><td style={proseTd}>inbound</td><td style={proseTd}>this agent answers queries (<code>q</code> or <code>r</code>) from the peer</td></tr>
            <tr><td style={proseTd}><code>h</code></td><td style={proseTd}>inbound</td><td style={proseTd}>this agent hosts pushes (<code>p</code>) from the peer</td></tr>
          </tbody>
        </table>

        <p style={proseP}>
          Bits describe what <em>this agent</em> does on the edge, not what the peer
          does. A cross-agent edge needs two entries — one in each agent's{' '}
          <code>acl.json</code> — with complementary bits: sender writes <code>q</code>{' '}
          (or <code>r</code>), receiver writes <code>a</code>; sender writes{' '}
          <code>p</code>, receiver writes <code>h</code>. The receiver's <code>a</code>{' '}
          covers both <code>q</code> and <code>r</code> from the sender. Missing either
          side blocks the edge silently.
        </p>
      </FileSpec>

      <Callout kind="security">
        Human callers don't appear in <code>acl.json</code> — they're paired explicitly,
        and their grants live in a separate file managed by the pairing flow. See{' '}
        <DocsLink href="/docs/use/pairing">Pairing</DocsLink>.
      </Callout>

      <H2>provisions.json — resource mounts and operator slots</H2>
      <Callout kind="jargon">
        Several fields below — and in the per-extension and{' '}
        <code>mcp-servers.json</code> sections that follow — are gated by the blueprint.
        In <code>capabilities.json</code>, a bare value means the field is{' '}
        <strong>locked</strong> (the author fixed it);{' '}
        <code>{`{ unlocked: true, value: ... }`}</code> means the operator can override.
        Writes here to locked fields are silently ignored. See{' '}
        <DocsLink href="/docs/build/blueprints">Authoring blueprints</DocsLink> for the
        author-side decision.
      </Callout>
      <p style={proseP}>
        Some agents need host-side things the author can't ship — a folder of notes to
        mount, an extra Python package, a tool to disable on this install.{' '}
        <code>provisions.json</code> is where you fill in those values. The blueprint
        declares what's needed (in <code>blueprint/props/capabilities.json</code>);
        provisions binds it to your host.
      </p>

      <FileSpec name="provisions.json" meta="json · operator-filled deployment values">
        <Code lang="json" noHead>{`{
  "resources": {
    "notes_dir": "/Users/alex/notes",
    "scratch":   { "path": "/Users/alex/scratch", "access": "rw" }
  },
  "pip": { "extra_packages": ["pandas"] },
  "additional_disabled_tools": ["bash"]
}`}</Code>
        <ul style={proseUl}>
          <li>
            <code>resources</code> — host paths bound to resource slots the blueprint
            declared. Each key matches a slot name; the value is either a bare path
            string (read-only) or an object with explicit{' '}
            <code>access: "ro" | "rw"</code>. Paths are mounted into the agent container
            at runtime.
          </li>
          <li>
            <code>pip.extra_packages</code> — extra Python packages to install. Only
            honored if the blueprint marked <code>pip.extra_packages</code> unlocked.
          </li>
          <li>
            <code>additional_disabled_tools</code> — tools to disable on top of what the
            blueprint already disabled. Only honored if the blueprint marked the field
            unlocked.
          </li>
        </ul>
        <p style={proseP}>
          Slots the blueprint marked <code>required: true</code> must be bound here
          before the agent will start. Optional slots can be left unbound.
        </p>
      </FileSpec>

      <H2>Per-extension config and secrets</H2>
      <p style={proseP}>
        Each extension the agent uses gets its own subfolder under{' '}
        <code>config/ext/&lt;name&gt;/</code>. Two files live there:{' '}
        <code>config.json</code> for operator overrides of the extension's settings,
        and <code>secrets.json</code> for credentials.
      </p>
      <p style={proseP}>
        What an operator can override is set by the blueprint. In{' '}
        <code>blueprint/props/capabilities.json</code>, each extension field is either
        locked (the value is fixed by the author) or unlocked (the operator can
        override). Locked fields never accept operator changes; unlocked fields are
        what <code>config.json</code> writes to. Secrets are always operator-set —
        blueprints never carry credentials.
      </p>

      <FileSpec name="config/ext/email/config.json" meta="json · operator overrides">
        <Code lang="json" noHead>{`{
  "send_mode": "enabled",
  "read_window_days": 14
}`}</Code>
      </FileSpec>

      <FileSpec name="config/ext/email/secrets.json" meta="json · credentials">
        <Code lang="json" noHead>{`{
  "imap_user": "alex@example.com",
  "imap_password": "..."
}`}</Code>
      </FileSpec>

      <Callout kind="security">
        Files under <code>config/ext/</code> are <strong>not mounted into the
        container</strong>. The extension code runs on the host and reads them there;
        the agent never sees the raw secret. This is how an extension can hold a
        credential the LLM can't reach. One exception: the Configure assistant can read
        these values to help you set them up, and when it does, the value goes to the
        model (Anthropic), like anything else in that chat. Entering them on the form
        keeps them out of the model entirely.
      </Callout>

      <H2>mcp-servers.json — env values for external MCP servers</H2>
      <p style={proseP}>
        Extensions are the curated path; external MCP servers are the open one. If the
        blueprint declares any (in <code>capabilities.json::mcp_servers</code>), each
        server may need env values the author can't ship — API keys, hosts, anything
        install-specific. <code>mcp-servers.json</code> holds them.
      </p>

      <FileSpec name="mcp-servers.json" meta="json · operator env for external MCP servers">
        <Code lang="json" noHead>{`{
  "github":   { "GITHUB_TOKEN": "ghp_..." },
  "postgres": { "DB_URL": "postgresql://..." }
}`}</Code>
        <p style={proseP}>
          Top-level key is the MCP server's name from <code>capabilities.json</code>;
          the inner map is env-var name → value. Only unlocked env slots can be written
          here — locked slots are vendor-hardcoded and rejected at write time. Required
          unlocked slots must be filled before the agent will start.
        </p>
      </FileSpec>

      <H2>What to read next</H2>
      <ul style={proseUl}>
        <li>
          <DocsLink href="/docs/build/blueprints">Authoring blueprints</DocsLink> — the
          companion: everything an agent IS before it's wired to your install.
        </li>
        <li>
          <DocsLink href="/docs/use/pairing">Pairing</DocsLink> — the human-access
          flow. ACL covers agent-to-agent; pairing covers people.
        </li>
        <li>
          <DocsLink href="/docs/concepts/capabilities">Capabilities</DocsLink> — what
          extensions are and why they can hold secrets the agent can't see.
        </li>
      </ul>
    </DocsLayout>
  );
}
