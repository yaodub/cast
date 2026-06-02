import { DocsLayout, H2, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { AskConsole, ConsoleChip } from '../../../components/docs/consoleTheme';

export function UseFirstAgent() {
  return (
    <DocsLayout
      url="/docs/use/first-agent"
      crumbs={['docs', 'use cast', 'your first agent']}
      title="Your first agent"
      lede="From an empty install to your own agent replying on the web. About ten minutes, mostly spent narrating to console agents."
      toc={[
        { label: 'Open the dashboard' },
        { label: 'Tell Design what you want' },
        { label: 'Let Configure wire it up' },
        { label: 'Promote it through Review' },
        { label: 'Open the web chat and pair' },
        { label: 'Talk to it' },
        { label: 'What to learn next' },
      ]}
    >
      <div
        style={{
          margin: '0 0 24px',
          padding: '14px 18px',
          background: 'var(--y2k-security-bg)',
          borderLeft: '3px solid var(--y2k-lime)',
          borderRadius: '0 4px 4px 0',
          fontSize: 15,
          lineHeight: 1.6,
          color: 'var(--fg)',
        }}
      >
        <strong style={{ color: 'var(--y2k-security-label)' }}>
          Console agents are an early preview
        </strong>{' '}
        — still being sharpened, so expect rough edges. The harness underneath is solid, and every
        agent is plain files — so if you hit any issues you can edit them by hand or hand the work
        to <DocsLink href="/docs/build/claude-code">Claude Code</DocsLink>, the mature terminal path.
      </div>

      <p style={proseP}>
        Building your first agent is mostly conversational. You don't click through forms to
        scaffold one — you describe what you want to <ConsoleChip kind="design" />, and it
        creates the agent for you. <ConsoleChip kind="configure" /> wires it to your install,{' '}
        <ConsoleChip kind="review" /> promotes it from draft to live, and then you switch to
        web and pair so you can chat with it.
      </p>

      <H2>Open the dashboard</H2>
      <p style={proseP}>
        Run <code>pnpm dev</code> and click the <code>Cast ready at http://localhost:&lt;port&gt;</code>{' '}
        line in the terminal. The dashboard opens.
      </p>
      <p style={proseP}>
        With no agents on the server, the dashboard docks <ConsoleChip kind="design" />{' '}
        automatically — it opens at a large size in the chat panel at the bottom of the
        screen. You don't have to find it. Start typing.
      </p>
      <Callout kind="tip">
        See <DocsLink href="/docs/use/server-dashboard">Server dashboard → Getting here</DocsLink>{' '}
        for the full first-load orientation — sidebar layout, the two surface kinds, what
        each console is for.
      </Callout>

      <H2>Tell Design what you want</H2>
      <p style={proseP}>
        Describe the agent the way you'd brief a person. What it's for, who'll talk to it,
        the tone, anything domain-specific:
      </p>

      <AskConsole kind="design">
        I want an agent that reads my morning emails and surfaces the ones worth replying to
        today. Keep it terse, no commentary on the obvious ones.
      </AskConsole>

      <p style={proseP}>
        Design creates the agent — picks an alias, writes the identity prompt, sets up
        channels and props, and registers it on the server. A new entry shows up in the
        sidebar with an amber <em>draft</em> badge. You can keep iterating: ask Design to
        adjust the tone, add a prop, change a channel. It hot-reloads each change.
      </p>
      <Callout kind="jargon">
        <strong>Draft</strong> means the agent isn't responding to anyone yet. Inbound
        messages bounce until you promote it. You can compose and test it freely while it's
        drafted.
      </Callout>
      <p style={proseP}>
        Design can also create more than one agent in the same brief. If you describe a
        team — "an inbox triager and a daily planner that work together" — it'll scaffold
        both and wire them to talk to each other. For more on that, see{' '}
        <DocsLink href="/docs/build/multi-agent">Multi-agent composition</DocsLink>.
      </p>

      <H2>Let Configure wire it up</H2>
      <p style={proseP}>
        Design produced the agent's blueprint — <em>what it is</em>. To make it work on your
        install, <ConsoleChip kind="configure" /> handles <em>how it's deployed</em>: model
        credentials, secrets, transports, extension config. Open All Agents Configure (top of
        sidebar) or Per-agent Configure (under the agent's row) and tell it what you need:
      </p>

      <AskConsole kind="configure">
        Set up this agent to read my Gmail. My username is alex@example.com.
      </AskConsole>

      <p style={proseP}>
        Notice the password isn't in chat. Configure is a secure surface — no internet
        egress — so it could take it, but secrets are best kept off the transcript. It opens the
        credentials page for you instead, then wires the rest as the panels flip green.
      </p>

      <Callout kind="security">
        Configure is a secure surface — no internet egress, so a secret it holds can't
        leak out. The caveat is the model provider: the conversation reaches Anthropic. Secrets
        still go through the form, not chat — log hygiene, not distrust.
      </Callout>

      <H2>Promote it through Review</H2>
      <p style={proseP}>
        Drafts bounce inbound messages, so promotion is mandatory before the agent can
        actually reply. The recommended path is{' '}
        <ConsoleChip kind="review" />, which gives the agent a once-over before flipping it
        to live:
      </p>
      <ul style={proseUl}>
        <li>
          On the agent's overview page, an amber "This agent is a draft" banner has a{' '}
          <strong>Request review</strong> button. Click it.
        </li>
        <li>
          <ConsoleChip kind="review" /> docks under All Agents and reviews the agent across
          four lenses — design, configure, economy, security. It surfaces anything risky and
          asks for your approval before promoting.
        </li>
        <li>
          On approval, the draft badge clears. The agent is live.
        </li>
      </ul>
      <p style={proseP}>
        For your own testing on a throwaway agent, you can skip Review entirely:{' '}
        <strong>Settings → Lifecycle → Make live (skip review)</strong>. The action is
        recorded in the audit log.
      </p>

      <H2>Open the web chat and pair</H2>
      <p style={proseP}>
        Now you need to talk to it. The dashboard is the build surface; for actual
        conversation, every agent has its own web chat URL on the same Cast server. Click
        the agent in the sidebar — its overview page lists the web chat link.
      </p>
      <p style={proseP}>
        Open that link in a new tab. The first time, you need to pair:
      </p>
      <ol style={{ ...proseP, paddingLeft: 22, listStyle: 'decimal' }}>
        <li>In the web chat, send <code>/pair</code>.</li>
        <li>
          A pairing code is generated, visible in the dashboard's pairing panel for this
          agent.
        </li>
        <li>Copy the code, switch back to web, paste it in.</li>
        <li>Paired.</li>
      </ol>
      <Callout kind="tip">
        Same flow when you pair someone else later on Telegram or Email — they send{' '}
        <code>/pair</code>, you share the code with them out-of-band. See{' '}
        <DocsLink href="/docs/use/pairing">Pairing</DocsLink> for the full reference.
      </Callout>

      <H2>Talk to it</H2>
      <p style={proseP}>
        Type a message in the web chat. The agent replies. That's the success moment.
      </p>
      <p style={proseP}>
        If something feels off — tone, focus, missing context — switch back to the dashboard
        and tell <ConsoleChip kind="design" /> what you want changed. Changes apply between
        messages; no rebuild step.
      </p>

      <H2>What to learn next</H2>
      <ul style={proseUl}>
        <li>
          <DocsLink href="/docs/use/pairing">Pairing</DocsLink> — give other people access on
          web, Telegram, or Slack (the three transports bundled at launch). Same{' '}
          <code>/pair</code> flow on each; ask <ConsoleChip kind="configure" /> to wire up
          whichever you want.
        </li>
        <li>
          <DocsLink href="/docs/build/blueprints">Authoring blueprints</DocsLink> — go
          deeper on what Design just wrote for you: identity, channels, props, the system
          prompt layers.
        </li>
      </ul>
    </DocsLayout>
  );
}
