import type { ComponentChildren } from 'preact';
import { DocsLayout, H2, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import {
  consoleTheme,
  ConsoleChip,
  ConsoleAvatar,
  AskConsole,
  type ConsoleKind,
} from '../../../components/docs/consoleTheme';
import {
  DashboardLandingMock,
  PanelVsConsoleMock,
} from '../../../components/docs/dashboardMocks';

function ConsoleCard({
  kind,
  name,
  desc,
}: {
  kind: ConsoleKind;
  name: string;
  desc: string;
}) {
  const theme = consoleTheme[kind];
  return (
    <div
      style={{
        padding: '16px 18px',
        border: `1px solid ${theme.border}`,
        borderLeft: `3px solid ${theme.icon}`,
        borderRadius: 8,
        background: theme.bg,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          marginBottom: 8,
        }}
      >
        <ConsoleAvatar kind={kind} size={22} />
        <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--fg)' }}>{name}</div>
      </div>
      <div style={{ fontSize: 13.5, color: 'var(--fg-muted)', lineHeight: 1.5 }}>{desc}</div>
    </div>
  );
}

function ScopeHeader({ children }: { children: ComponentChildren }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontFamily: 'JetBrains Mono, monospace',
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--fg-subtle)',
        fontWeight: 600,
        marginBottom: 10,
      }}
    >
      {children}
    </div>
  );
}

const GRID_STYLE = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 12,
} as const;

export function UseServerDashboard() {
  return (
    <DocsLayout
      url="/docs/use/server-dashboard"
      crumbs={['docs', 'use cast', 'server dashboard']}
      title="Server dashboard"
      lede="Where you manage everything. A browser-based dashboard with two kinds of surface — panels for the mechanical stuff, and five console agents that handle the work that benefits from describing what you want in chat."
      toc={[
        { label: 'Getting here' },
        { label: 'What you land on' },
        { label: 'Two kinds of surface' },
        { label: 'The five console agents' },
        { label: 'When to open which' },
        { label: "What console agents won't do" },
      ]}
    >
      <H2>Getting here</H2>
      <p style={proseP}>
        The Cast server prints a URL when it starts. Run <code>pnpm dev</code> and a
        clickable <code>http://localhost:5051</code> shows up in the terminal — open it in
        any browser. By default the web UI listens on <code>5051</code>, and everything
        binds to <code>127.0.0.1</code> only (your machine, not the public internet).
      </p>
      <p style={proseP}>
        If this is your first time, the{' '}
        <DocsLink href="/docs/quickstart">Quickstart</DocsLink> walks through installation
        end-to-end. For pinning the port to a fixed value, see{' '}
        <DocsLink href="/docs/advanced/runtime-options">Advanced → Runtime options</DocsLink>. The
        dashboard stays on this machine by design; to reach your agents while you're away
        from it, wire up a transport — see{' '}
        <DocsLink href="/docs/advanced/deployment">Advanced → Deployment</DocsLink>.
      </p>

      <H2>What you land on</H2>
      <p style={proseP}>
        The landing view is <strong>All Agents</strong> — a fleet-wide rollup with a stat
        summary and anything needing your attention. A sidebar gives you the fleet-scope
        console agents (Design, Configure, Review) plus a per-agent view for each agent on
        the server.
      </p>

      <DashboardLandingMock />

      <p style={proseP}>
        Click an agent in the sidebar and you land on its page. Same layout structure, but
        everything is now scoped to that single agent — its prompt, its config, its
        channels, its per-agent console agents.
      </p>

      <H2>Two kinds of surface</H2>
      <p style={proseP}>
        Across the dashboard, two kinds of surface do the work. <strong>Panels</strong> for
        the mechanical stuff — adding a transport route, pasting an API key, toggling who
        can talk, watching a status indicator. <strong>Console agents</strong> for the work
        that benefits from describing what you want in chat — wiring up a transport for a
        specific agent, narrowing someone's access, reviewing whether a change is safe.
      </p>

      <PanelVsConsoleMock />

      <p style={proseP}>
        Most operator work hops between the two. You set the model in a panel; you ask
        Per-agent <ConsoleChip kind="configure" /> to wire up Telegram; you go back to the
        panel to check the status indicator turned green.
      </p>

      <H2>The five console agents</H2>
      <p style={proseP}>
        Console agents are LLM sessions with tightly-scoped tools, accessed by chat in the
        dashboard. They're the same kind of thing as the agents you author — but their job
        is to help you author and operate other agents.
      </p>
      <Callout kind="warn">
        Console agents are an early preview and still being sharpened. When one falls short, the
        work it does is all plain files you can edit by hand or hand to{' '}
        <DocsLink href="/docs/build/claude-code">Claude Code</DocsLink> — the mature terminal path
        with the full authoring envelope.
      </Callout>
      <p style={proseP}>
        Three live under <strong>All Agents</strong> and operate across the fleet —{' '}
        <ConsoleChip kind="design" />, <ConsoleChip kind="configure" />, and{' '}
        <ConsoleChip kind="review" />. The same Design and Configure shapes also exist
        scoped to a single agent — opened from inside that agent's page.
      </p>

      <div style={{ margin: '4px 0 10px' }}>
        <ScopeHeader>All Agents</ScopeHeader>
        <div style={GRID_STYLE}>
          <ConsoleCard
            kind="design"
            name="Design"
            desc="Compose multi-agent systems. Decompose a goal into draft agents and brief each per-agent Design session."
          />
          <ConsoleCard
            kind="configure"
            name="Configure"
            desc="Survey and bulk-edit across the fleet — rotate a secret, change the global model, audit who's wired to what."
          />
          <ConsoleCard
            kind="review"
            name="Review"
            desc="Read-only QA gate across the fleet. Reviews design, configure, economy, and security lenses before a change ships."
          />
        </div>
      </div>

      <div
        style={{
          height: 1,
          background: 'var(--border)',
          margin: '20px 0 18px',
        }}
      />

      <div style={{ marginBottom: 18 }}>
        <ScopeHeader>Per-agent</ScopeHeader>
        <div style={GRID_STYLE}>
          <ConsoleCard
            kind="design"
            name="Per-agent Design"
            desc="Author this agent's behavior — prompt, channels, props, capabilities. Designer territory; an Operator dips in to tweak operator-facing props."
          />
          <ConsoleCard
            kind="configure"
            name="Per-agent Configure"
            desc="Wire this agent to your install — model, secrets, transports, access, runtime knobs. Where an Operator spends most of their time."
          />
        </div>
      </div>

      <Callout kind="security">
        <ConsoleChip kind="design" /> has internet (for lookups) but no access to your
        secrets. <ConsoleChip kind="configure" /> has secrets but is locked to model-only
        egress. Neither can do both, by construction — a compromised Design can't leak
        keys; a compromised Configure can't dial out.
      </Callout>

      <H2>When to open which</H2>
      <p style={proseP}>
        For per-agent work the split is mechanical: Per-agent <ConsoleChip kind="design" />{' '}
        for changes to what the agent <em>is</em>; Per-agent{' '}
        <ConsoleChip kind="configure" /> for changes to how it's deployed on your install.
        The Operator persona lives mostly in Per-agent Configure:
      </p>

      <AskConsole kind="configure">
        Wire this agent up to Telegram. Bot token is in the route I added yesterday.
      </AskConsole>

      <p style={proseP}>
        Configure makes the change, reloads routes, and tells you when the Transports panel
        should turn green. The same pattern holds for every Configure-shaped task: you
        describe the outcome, Configure executes and reports back.
      </p>

      <p style={proseP}>
        For cross-agent work — composing a multi-agent system, auditing the fleet, agent-to-
        agent permissions — switch to one of the <strong>All Agents</strong> console agents.
        Per-agent <ConsoleChip kind="configure" /> handles <em>human</em> access only;
        agent-to-agent permissions and fleet-wide audits live under All Agents.
      </p>

      <H2>What console agents won't do</H2>
      <p style={proseP}>
        Console agents operate in a constrained envelope. Anything that runs as host code
        is outside what they'll attempt:
      </p>
      <ul style={proseUl}>
        <li>Service code (host-executable TypeScript that runs outside the container).</li>
        <li>Modifying Cast packages — extensions, transports, gateway internals.</li>
        <li>Cross-folder git operations, shell access, arbitrary file writes outside the agent.</li>
      </ul>
      <p style={proseP}>
        When you ask for one of these, the console agent tells you it's out of scope and
        suggests Claude Code on the host — where you have the full authoring envelope. See{' '}
        <DocsLink href="/docs/build/claude-code">Working in Claude Code</DocsLink> for that
        path.
      </p>
    </DocsLayout>
  );
}
