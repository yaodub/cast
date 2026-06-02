import { DocsLayout, H2, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';

export function BuildClaudeCode() {
  return (
    <DocsLayout
      url="/docs/build/claude-code"
      crumbs={['docs', 'build agents', 'working in claude code']}
      title="Working in Claude Code"
      lede="Build, refine, and debug agents from your terminal. Same loop as the console agents, plus service code and diff-by-diff review."
      toc={[
        { label: 'When you reach for it' },
        { label: 'Three lanes, one envelope' },
        { label: 'The three skills' },
        { label: 'The trust model' },
        { label: 'What to read next' },
      ]}
    >
      <p style={proseP}>
        Cast ships with three Claude Code skills — <code>/cast-build</code> for
        authoring, <code>/cast-refine</code> for introspection-driven refinement,
        and <code>/cast-debug</code> for diagnosis. Each loads the right manuals and
        conventions and turns a generic Claude Code session into one fluent in Cast's
        vocabulary. The safety property is operator review, line by line.
      </p>

      <H2>When you reach for it</H2>
      <p style={proseP}>
        The in-Cast console agents (Design, Configure, the All-Agents managers) handle
        ordinary blueprint authoring and per-install wiring without leaving your
        browser. Claude Code is the place for the agent work they can't reach:
      </p>
      <ul style={proseUl}>
        <li>
          <strong>Service code</strong> — anything under{' '}
          <code>blueprint/service/</code>: custom MCP tools, cron jobs, OAuth
          handshakes, file watchers, connectors to systems you actually use. See{' '}
          <DocsLink href="/docs/build/services">Writing services</DocsLink>.
        </li>
        <li>
          <strong>Refinement and introspection</strong> — reading across an agent's
          blueprint, runtime state, memory, and admin history at once to propose
          changes grounded in evidence. See{' '}
          <DocsLink href="/docs/build/designing-well">Designing well</DocsLink>.
        </li>
        <li>
          <strong>Diagnosis</strong> — figuring out why an agent did (or didn't) do
          something, or why a message didn't arrive. Layer-by-layer reads of the
          gateway, agent state, runner log, and session transcripts.
        </li>
        <li>
          <strong>Cross-agent folder operations</strong> — rename, restore from
          backup, bulk delete, anything spanning more than one agent folder.
        </li>
      </ul>

      <H2>Three lanes, one envelope</H2>
      <p style={proseP}>
        Claude Code covers three distinct activities that share the same access
        surface and trust model. The lanes aren't enforced — each skill <em>can</em>{' '}
        do anything the envelope allows. They differ in what they prime Claude to read
        first, and what posture they encourage.
      </p>
      <p style={proseP}>
        <strong>Authoring</strong> writes new things — services, extensions, blueprint
        files, package changes. You describe what you want, Claude Code drafts the
        code, you review the diff, it lands.
      </p>
      <p style={proseP}>
        <strong>Introspection</strong> reads existing things — an agent's blueprint
        next to its runtime state, its memory, the operator's recent admin actions.
        The output isn't code; it's a grounded read of what the agent is actually
        doing and what changes might earn their place. Introspection is upstream of
        authoring: it's how you find <em>what</em> to refine before you start refining.
      </p>
      <p style={proseP}>
        <strong>Diagnosis</strong> reads the runtime — gateway DB, agent message log,
        agent-runner debug log, session transcripts — to answer{' '}
        <em>"why did this happen?"</em> or <em>"why didn't this arrive?"</em> The
        output is a named cause at a named layer; a fix follows separately (often
        back through the authoring lane).
      </p>

      <H2>The three skills</H2>
      <p style={proseP}>
        All three are available from Claude Code's slash menu. Each takes an
        optional <code>&lt;folder&gt;</code> argument — present narrows scope to one
        agent, absent opens server scope.
      </p>
      <ul style={proseUl}>
        <li>
          <code>/cast-build [folder]</code> — <strong>authoring inside agent
          folders</strong>. Blueprint files (identity, channels, props, assets) and
          per-agent service code under <code>blueprint/service/</code>. With a folder,
          the session anchors at one agent. Without a folder, cross-agent folder ops
          (rename, restore, bulk delete) across <code>$CAST_AGENTS_DIR/</code>.
        </li>
        <li>
          <code>/cast-refine [folder]</code> — <strong>introspection</strong>. Reads
          the agent against its blueprint and surfaces refinement proposals. Output
          is a dated artifact, not edits. Per-agent with a folder; with no folder, the
          unit of analysis is the fleet.
        </li>
        <li>
          <code>/cast-debug [folder]</code> — <strong>diagnosis</strong>. Layer-by-layer
          reads to find what broke. Per-agent with a folder; without a folder, the
          gateway and host server logs are the primary surface.
        </li>
      </ul>
      <p style={proseP}>
        The lines blur — refinement often finds a bug (switch to diagnosis), diagnosis
        often ends in a code change (switch to authoring). Each skill names its
        siblings so you can hand off mid-session.
      </p>

      <H2>The trust model</H2>
      <p style={proseP}>
        Cast cannot audit advanced mode — it lives outside the message log. The only
        safety property is your review: every diff Claude Code proposes is yours to
        approve, modify, or reject before it lands. That's why the skills emphasize
        narrow scope, naming the egress in <code>agent.json</code>, and documenting why
        a credential was added.
      </p>
      <Callout kind="security">
        Reviewing diffs you didn't write, in a language you don't work in, is closer to{' '}
        <strong>approving</strong> than <strong>reviewing</strong>. Approving without
        catching is the failure mode you take on in advanced mode. If you can't read
        the code Claude Code is writing, the right move is usually to stay in the
        console agents and shape the request differently — not to wave through code you don't
        understand.
      </Callout>

      <H2>What to read next</H2>
      <ul style={proseUl}>
        <li>
          <DocsLink href="/docs/build/services">Writing services</DocsLink> — the
          principal authoring target. Service shape, conventions, where the code runs.
        </li>
        <li>
          <DocsLink href="/docs/build/designing-well">Designing well</DocsLink> — how
          refinement uses introspection to find what to change next.
        </li>
      </ul>
    </DocsLayout>
  );
}
