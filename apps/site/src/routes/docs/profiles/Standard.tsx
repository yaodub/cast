import { DocsLayout, H2, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';

export function ProfilesStandard() {
  return (
    <DocsLayout
      url="/docs/profiles/standard"
      crumbs={['docs', 'plugins', 'profiles', 'standard']}
      title="standard"
      lede="The full briefing — everything a capable, self-directed agent needs to operate well in Cast, from the start."
      toc={[
        { label: 'What it covers' },
        { label: 'The lifecycle it sets up' },
        { label: 'When standard fits' },
      ]}
    >
      <p style={proseP}>
        Standard is the default for good reason: an agent running it arrives knowing how
        Cast works, so the blueprint can stay focused on who the agent is rather than how to
        operate. It's the right starting point for almost any agent.
      </p>

      <H2>What it covers</H2>
      <p style={proseP}>The briefing spans the things an agent needs to act with judgment:</p>
      <ul style={proseUl}>
        <li>
          <strong>Its surroundings</strong> — the filesystem it works in, where durable
          memory lives, and how to keep an address book of the people it talks to.
        </li>
        <li>
          <strong>Its tools</strong> — the full catalog of built-ins: scheduling work for
          later, searching past messages, managing conversations, querying other agents,
          checking the time. It learns what each is for, not just that it exists.
        </li>
        <li>
          <strong>The framework's signals</strong> — the <DocsLink href="/docs/runtime/wire-format"><code>cast:</code> tags</DocsLink> Cast uses
          to mark machine stimulus (a scheduled fire, a push from another agent) as distinct
          from a real person talking, so the agent reacts to each appropriately.
        </li>
        <li>
          <strong>Memory discipline</strong> — how to organize what it remembers, and the
          habit of checking before claiming it does or doesn't know something, rather than
          guessing in either direction.
        </li>
        <li>
          <strong>Talking to other agents</strong> — how to query a peer and how to answer
          one, including keeping the attribution on secondhand information.
        </li>
      </ul>

      <H2>The lifecycle it sets up</H2>
      <p style={proseP}>
        Standard shapes how a conversation opens and closes. Before the first reply, a
        read-only bootstrap pass lets the agent re-immerse in the recent thread without
        acting — mutating tools are held back so the pass stays strictly read-only. When
        the exchange reaches a natural resting point, the agent is guided to close it, which
        triggers a cleanup turn: distill what's worth keeping, file it into memory, and leave
        a summary for next time. This is the loop that lets an agent carry context across
        conversations instead of starting cold each time.
      </p>

      <H2>When standard fits</H2>
      <p style={proseP}>
        Almost always. Choose standard whenever you want the agent to be a full participant
        in Cast — using its tools well, keeping disciplined memory, collaborating with peers.
        The reason to look elsewhere is if you want to author that protocol-level behavior
        yourself rather than inherit Cast's defaults — see{' '}
        <DocsLink href="/docs/profiles/minimal">minimal</DocsLink>.
      </p>
    </DocsLayout>
  );
}
