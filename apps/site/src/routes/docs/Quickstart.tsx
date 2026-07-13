import { DocsLayout, H2, proseP, proseUl } from '../../components/docs/DocsLayout';
import { DocsLink } from '../../components/docs/DocsLink';
import { Code } from '../../components/ui/Code';
import { Callout } from '../../components/ui/Callout';
import { Tabs } from '../../components/docs/Tabs';
import { AskConsole, ConsoleChip } from '../../components/docs/consoleTheme';

export function Quickstart() {
  return (
    <DocsLayout
      url="/docs/quickstart"
      crumbs={['docs', 'get started', 'quickstart']}
      title="Quickstart"
      lede="From a clean machine to your first agent. Clone, run, then author from the server dashboard or from Claude Code."
      toc={[
        { label: 'Prerequisites' },
        { label: '1. Clone and run' },
        { label: '2. Author your first agent' },
        { label: "What's next" },
      ]}
    >
      <p style={proseP}>
        Cast runs on your own machine — a Node process that orchestrates Claude agents in
        isolated containers. Setup is honest about what it needs (a container runtime is
        not optional) but doesn't ask you anything twice.
      </p>

      <H2>Prerequisites</H2>
      <ul style={proseUl}>
        <li>macOS (preferred), Linux, or Windows via WSL2</li>
        <li>Node.js 20+</li>
        <li>
          A container runtime: Apple Container (macOS 26+) or Docker. <strong>Required.</strong>{' '}
          Without it, agents can't run.
        </li>
      </ul>

      <H2>1. Clone and run</H2>
      <Code lang="bash">{`git clone https://github.com/yaodub/cast.git
cd cast
npm i -g pnpm
pnpm start`}</Code>
      <p style={proseP}>
        <code>pnpm start</code> does the rest: installs dependencies, builds the
        dashboard and server bundle, builds the agent container image (~2 min on first
        run), then starts the server. Your browser opens to the dashboard at{' '}
        <code>http://localhost:5051/admin/</code>.
      </p>
      <Callout kind="tip">
        Subsequent runs skip the build steps. To update Cast,{' '}
        <code>git pull && pnpm start</code> — the script detects what changed and
        rebuilds only what's needed (usually under a minute).
      </Callout>
      <Callout kind="warn">
        If <code>pnpm start</code> reports "container runtime not running," start the
        daemon: <code>container system start</code> on Apple Container, or launch Docker
        Desktop.
      </Callout>

      <H2>2. Author your first agent</H2>
      <p style={proseP}>
        Cast has two authoring modes. They write the same agent files on disk — switch
        between them anytime. The in-browser consoles are an early preview we're still
        sharpening; Claude Code is mature terminal tooling. Either way the agent you ship is
        the same, and if a console stalls, every agent is plain files you can edit by hand or
        hand to Claude Code. Pick whichever fits how you work:
      </p>

      <Tabs
        tabs={[
          {
            id: 'dashboard',
            label: 'Server dashboard',
            content: (
              <>
                <p style={proseP}>
                  All in the browser. On first launch the dashboard pops a credential
                  modal. Two options:
                </p>
                <ul style={proseUl}>
                  <li>
                    <strong>Anthropic API key</strong> — create one at{' '}
                    <code>console.anthropic.com/settings/keys</code>, paste, save. Billed
                    per token to your Anthropic account.
                  </li>
                  <li>
                    <strong>Claude OAuth token</strong> — if you have a Claude.ai plan and
                    the Claude Code CLI installed, run <code>claude setup-token</code> in
                    your terminal and paste the result. Usage draws from your Claude plan.
                  </li>
                </ul>
                <p style={proseP}>
                  Save verifies the credential against Claude before accepting. The server
                  hot-reloads — no restart.
                </p>
                <p style={proseP}>
                  With Claude wired up and no agents on the server, the dashboard
                  automatically docks <ConsoleChip kind="design" /> at the bottom of the
                  screen. Describe the agent you want:
                </p>

                <AskConsole kind="design">
                  I want an agent that reads my morning emails and surfaces the ones worth
                  replying to today. Keep it terse, no commentary on the obvious ones.
                </AskConsole>

                <p style={proseP}>
                  Design scaffolds the agent — picks an alias, writes its identity, sets
                  up channels and props, registers it on the server. From there{' '}
                  <ConsoleChip kind="configure" /> wires it to your install (model,
                  secrets, transports), <ConsoleChip kind="review" /> promotes it from
                  draft to live, and you open its web chat URL, let yourself in, and talk. Full
                  walkthrough: <DocsLink href="/docs/use/first-agent">Your first agent</DocsLink>.
                </p>
              </>
            ),
          },
          {
            id: 'claude-code',
            label: 'Claude Code',
            content: (
              <>
                <p style={proseP}>
                  Author from your terminal. Skip the in-browser credential modal and put
                  credentials in a <code>.env</code> file at the repo root:
                </p>
                <Code title=".env">{`AUTH_MODE=api-key
ANTHROPIC_API_KEY=sk-ant-...`}</Code>
                <p style={proseP}>
                  Or <code>AUTH_MODE=setup-token</code> with{' '}
                  <code>CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-...</code> for OAuth. The
                  server picks this up on next boot — no modal, no in-browser step.
                </p>
                <p style={proseP}>
                  Then open the repo in Claude Code and pick the skill that matches the
                  work: <code>/cast-build</code> to author blueprint files or per-agent
                  service code; <code>/cast-refine</code> to introspect a running agent
                  and surface refinement proposals; <code>/cast-debug</code> to diagnose
                  agent or pipeline behavior. Each takes an optional{' '}
                  <code>&lt;folder&gt;</code> arg to narrow the scope to one agent.
                </p>
                <Callout kind="security">
                  Claude Code operates outside Cast's message log — the only safety
                  property is your review of each diff. See{' '}
                  <DocsLink href="/docs/build/claude-code">Working in Claude Code</DocsLink>{' '}
                  for the full trust model.
                </Callout>
              </>
            ),
          },
        ]}
      />

      <H2>What's next</H2>
      <ul style={proseUl}>
        <li>
          <strong>Dashboard path:</strong>{' '}
          <DocsLink href="/docs/use/first-agent">Your first agent</DocsLink> — the
          end-to-end walkthrough from "Design just scaffolded it" to "it's replying on
          web".
        </li>
        <li>
          <strong>Claude Code path:</strong>{' '}
          <DocsLink href="/docs/build/claude-code">Working in Claude Code</DocsLink> —
          full envelope, trust model, and what the two skills can each do.
        </li>
        <li>
          <DocsLink href="/docs/use/server-dashboard">Server dashboard</DocsLink> — panels
          and console agents (relevant either way).
        </li>
        <li>
          <DocsLink href="/docs/build/agent-folder">Agent folder anatomy</DocsLink> —
          what's inside <code>~/.cast/agents/&lt;name&gt;/</code>.
        </li>
      </ul>
    </DocsLayout>
  );
}
