import { DocsLayout, H2, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';

export function BuildDesigningWell() {
  return (
    <DocsLayout
      url="/docs/build/designing-well"
      crumbs={['docs', 'build agents', 'designing well']}
      title="Designing well"
      lede="Three things shape a blueprint that ages well: where you put the seams, what rides in the agent's context each turn, and how you refine the agent once it's been running."
      toc={[
        { label: 'A blueprint is a context-flow spec' },
        { label: 'Where to chop' },
        { label: 'Trim what doesn’t earn its place' },
        { label: 'Refining over time' },
        { label: 'What to read next' },
      ]}
    >
      <H2>A blueprint is a context-flow spec</H2>
      <p style={proseP}>
        A blueprint is not a prompt that paraphrases what you want. It's a spec for
        how context flows at runtime — which files hold what substrate, which channel
        reads which path on which trigger, which cleanup writes back where. Every
        joint named.
      </p>
      <p style={proseP}>
        Two layers. <strong>Shape</strong> decides what's available where — channels,
        ACL bits, mounts, lifecycle, tool surface. <strong>Verb</strong> is what
        happens inside — pushes, watches, fires, queries. Shape the surface so each
        verb is available exactly where it serves; pin the joints (paths, channel
        names, trigger verbs) and let the agent improvise inside the nodes.{' '}
        <em>"First do X, then Y, then Z"</em> is the drift signal — scaffolding has
        slipped into definition.
      </p>
      <Callout kind="tip">
        <strong>The done test.</strong> Read the blueprint and answer, per channel:{' '}
        <em>what arrow fires on what trigger, reading what file?</em> If the answer
        is <em>"the agent will reach for memory"</em> or <em>"the prompt teaches it
        to look,"</em> the joint is unnamed — at runtime the agent will improvise
        it, often wrongly.
      </Callout>

      <H2>Where to chop</H2>
      <p style={proseP}>
        The most expensive design mistake is splitting work where there's no real
        categorical difference. Each side of a boundary pays full overhead and
        re-pays it forever; work that should stay with one decision-maker fragments
        across handoffs that can't re-establish what the first side knew.
      </p>
      <p style={proseP}>
        The first seam you hit is between channels of one agent. Most agents start
        with one channel (<code>default</code>) and grow a second only when the work
        differs in posture, lifecycle, tool surface, or audience. Agent
        seams are the same judgment at higher stakes — split when work belongs to a
        different identity, memory, or trust posture, not just a different step in
        a process.
      </p>
      <p style={proseP}>
        The test at either layer: <em>if you removed this surface and gave its work
        back to the surfaces on either side, would anything be lost?</em> If no, you
        have a <strong>courier</strong> — collapse it. If yes, name what's lost;
        that's the surface's mandate. Three shapes typically earn their seam: a{' '}
        <strong>reviewer</strong> (applies a cross-cut no contributor has), a{' '}
        <strong>specialist</strong> (holds expertise or credentials the caller
        doesn't), a <strong>filter</strong> (decides what to escalate).
      </p>
      <Callout kind="tip">
        Courier shapes hide inside one agent too. A "publisher" channel whose only
        job is to call one tool with a passed payload is a courier — fold it into
        the channel that produced the payload. Chains like{' '}
        <em>writer → editor → publisher</em> with no judgment between them are
        courier chains. Once an agent seam earns its keep, see{' '}
        <DocsLink href="/docs/build/multi-agent">Multi-agent composition</DocsLink>{' '}
        for the wiring.
      </Callout>

      <H2>Trim what doesn’t earn its place</H2>
      <p style={proseP}>
        Each line in context should change the next decision. What doesn't gets in
        the way of what does.
      </p>
      <p style={proseP}>Things to watch on every turn:</p>
      <ul style={proseUl}>
        <li>
          <strong>Identity.</strong> Voice and principle in <code>prompt.md</code>,
          one-line bullets in <code>skills.md</code>. A three-page prescriptive
          identity drowns the channel prompt that should be salient.
        </li>
        <li>
          <strong>Bootstrap.</strong> Point at <code>/memory/</code> and let the
          agent Read mid-turn. An eager bootstrap that reads five files and
          narrates each fills attention with material the turn may not need.
        </li>
        <li>
          <strong>Capability load.</strong> Set <code>disabled_tools</code> per
          channel. A channel that doesn't use scheduling, push, or extension tools
          should drop them — tool descriptions are tokens, and each loaded tool is
          one more surface for the agent to misbehave on (or be manipulated
          through, if the description came from a third-party MCP server).
        </li>
        <li>
          <strong>Service-injected context</strong> (<code>agent-context.md</code>).
          Keep it terse; it re-assembles every turn.
        </li>
      </ul>
      <p style={proseP}>Things to watch at the joints:</p>
      <ul style={proseUl}>
        <li>
          <strong>Hand conclusions, not deliberation.</strong> A long "here's what
          I reasoned through" sent to a peer misdirects them. If they need
          reasoning, they ask.
        </li>
        <li>
          <strong>Pass payloads by reference.</strong> A 5KB article handed inline
          pays its bytes three times. Write to <code>/memory/</code> or a mount;
          have the push carry the path.
        </li>
        <li>
          <strong>Fire on signal, not anxiety.</strong> For any schedule, ask: of
          the last several fires, how many produced an action? If most produced
          none, raise the interval or convert to event-driven.
        </li>
        <li>
          <strong>Match <code>idle_timeout</code> to expected reply cadence.</strong>{' '}
          Two to five minutes on a channel where replies arrive every ten to
          fifteen minutes churns cleanup-and-bootstrap on every gap.
        </li>
        <li>
          <strong>Prefer feeds to broadcasts.</strong> Pushing the same event to
          ten peers pays ten cold-starts. A shared feed — an append-only file the
          producer writes and consumers watch — collapses that to one watch per
          consumer.
        </li>
        <li>
          <strong>Read with a question.</strong> <em>"Tell me about your work"</em>{' '}
          produces survey-mode output. <em>"Is the X case handled?"</em> produces
          an answer.
        </li>
      </ul>

      <H2>Refining over time</H2>
      <p style={proseP}>
        The first blueprint you ship is a starting point. After weeks of run
        history, you'll see what the operator actually uses the agent for, where
        they still do manual work it could absorb, which capabilities gather dust,
        which behaviors keep drifting. Most of an agent's design quality comes from
        this loop, not from the first pass.
      </p>
      <p style={proseP}>
        Refinement happens in advanced mode —
        (<code>/cast-refine &lt;folder&gt;</code>) in Claude Code — because
        it's the only surface that reads across blueprint, runtime state, SDK
        transcripts, memory, and admin history at once. The in-Cast consoles each
        see a partial view by design; introspection composes them. Its question is{' '}
        <em>"how can this agent become more itself?"</em> — not{' '}
        <em>"what's broken?"</em> The output is a dated proposal artifact at{' '}
        <code>~/.cast/agents/&lt;name&gt;/introspection/&lt;YYYY-MM-DD&gt;.md</code>,
        not edits; implementation happens via <code>/cast-build &lt;folder&gt;</code>{' '}
        afterwards.
      </p>
      <p style={proseP}>Disciplines that govern the session:</p>
      <ul style={proseUl}>
        <li>
          <strong>Earn the read.</strong> It pays off after weeks of run history,
          not days. Before that, there's no delta between intent and behavior to
          refine against.
        </li>
        <li>
          <strong>Cite evidence per proposal.</strong>{' '}
          <em>"In conversation 47, the agent did Y; that suggests Z."</em> Not{' '}
          <em>"you could add X."</em>
        </li>
        <li>
          <strong>Bias toward sharpening.</strong> When proposals tie:{' '}
          <em>sharpen</em> (tighten what's there) → <em>subtract</em> (stop what
          doesn't fit) → <em>compose</em> (pair with a peer, split a role) →{' '}
          <em>add</em> (when reach is lacking). Subtraction is a first move,
          not a last resort.
        </li>
        <li>
          <strong>Drift is a blueprint problem.</strong> If runtime has drifted,
          the cadence instructions maintaining it are too weak. Sharpen the
          bootstrap, cleanup, or reflection prompt; don't reach into runtime memory
          directly.
        </li>
      </ul>
      <p style={proseP}>Three structural moves the agent can grow into:</p>
      <ul style={proseUl}>
        <li>
          A <strong>feedback file</strong> the operator drops corrections into,
          synthesized by cleanup into rules the next bootstrap reads.
        </li>
        <li>
          A <strong>reflection channel</strong> scheduled to compress recent
          activity and surface what the operator didn't ask about.
        </li>
        <li>
          A <strong>self-tuning task</strong> that writes an evaluation after each
          fire and reschedules with refined parameters.
        </li>
      </ul>
      <Callout kind="warn">
        Some refinements widen what the agent can do — a new extension, a new peer
        ACL, a new resource mount, a new external surface. When those edits land
        in a Design session, the agent flips back to draft first; paired users see{' '}
        <em>"not yet ready"</em> until All-Agents Review walks through the diff
        with the operator and flips it live again. Cosmetic edits — prompt
        wording, schedule cadence, identity tweaks — land directly on a live
        blueprint.
      </Callout>

      <H2>What to read next</H2>
      <ul style={proseUl}>
        <li>
          <DocsLink href="/docs/build/multi-agent">Multi-agent composition</DocsLink>{' '}
          — once an agent seam earns its keep, the wiring.
        </li>
        <li>
          <DocsLink href="/docs/build/services">Writing services</DocsLink> — when a
          blueprint surface isn't enough and host code earns its place.
        </li>
        <li>
          <DocsLink href="/docs/build/blueprints">Authoring blueprints</DocsLink> —
          the field reference for every file named above.
        </li>
      </ul>
    </DocsLayout>
  );
}
