import { DocsLayout, H2, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { Code } from '../../../components/ui/Code';
import { ChatMockup } from '../../../components/site/ChatMockup';

export function ConceptsTriggers() {
  return (
    <DocsLayout
      url="/docs/concepts/triggers"
      crumbs={['docs', 'concepts', 'scheduling & triggers']}
      title="Scheduling and triggers"
      lede="A Cast agent isn't limited to acting when you talk to it. It can wake on a schedule, react to an inbox or calendar, or be poked by its own code."
      toc={[
        { label: 'Wake on the clock' },
        { label: "Wake on the agent's initiative" },
        { label: 'Wake on triggers' },
        { label: 'Wake on your own code' },
        { label: 'What to read next' },
      ]}
    >
      <H2>Wake on the clock</H2>
      <p style={proseP}>
        The simplest way to wake a Cast agent is writing a schedule into its blueprint.
        The agent wakes at the appointed time, reads its own message, and acts on it.
        Reach for this when you know the rhythm up front: a morning briefing, a nightly
        reflection, a weekly plan.
      </p>

      <Callout kind="jargon">
        The schedule lives in <code>blueprint/props/schedule.txt</code>. One line per
        scheduled message — standard 5-field cron with an optional <code>TZ=</code>{' '}
        prefix, then the channel, then the message text. Hot-reloaded; edits land on the
        next message. See{' '}
        <DocsLink href="/docs/build/blueprints">Authoring blueprints</DocsLink> for the
        full grammar.
      </Callout>

      <Code lang="bash" noHead>{`# Daily briefing on weekdays
0 7 * * 1-5    default     Send the morning briefing.

# Nightly reflection
0 22 * * *     reflection  Look back over the day.

# Sunday-evening planning
0 21 * * 0     default     Plan the week ahead.
`}</Code>

      <H2>Wake on the agent's initiative</H2>
      <p style={proseP}>
        The author can't anticipate every future fire. The agent sets the schedule itself
        mid-conversation. You mention a deadline. The agent calls a tool, and the turn
        fires later. The cadence belongs to the agent, set by what you just said rather
        than written into the blueprint.
      </p>

      <Callout kind="jargon">
        The agent calls <DocsLink href="/docs/runtime/tools#task__schedule"><code>task__schedule</code></DocsLink> — one-shot or recurring, tied to a
        channel. The task persists in <code>state/tasks.json</code> and survives restart.
        Companion tools (<code>task__list</code>, <code>task__pause</code>,{' '}
        <code>task__cancel</code>) let the agent manage what it has set.
      </Callout>

      <ChatMockup
        agentName="agent"
        script={[
          {
            from: 'user',
            text: 'This refactor should only take a weekend.',
          },
          {
            from: 'agent',
            text: "Noted. I'll check back in two weeks.",
          },
          {
            from: 'agent',
            time: '2 weeks later',
            text:
              "Two weeks ago you thought the refactor would take a weekend. How's it going?",
          },
        ]}
      />

      <H2>Wake on triggers</H2>
      <p style={proseP}>
        An email arrives, the calendar fires a reminder — and your agent reacts. Cast
        ships with extensions that watch your inbox and calendar. When the extension sees
        what it's watching for, it wakes the agent.
      </p>

      <Callout kind="jargon">
        Extensions are typed packages installed on the server. An agent opts in through
        its capabilities config; the extension handles the watching, the auth, the
        parsing. See <DocsLink href="/docs/concepts/capabilities">Capabilities</DocsLink>{' '}
        for what's bundled.
      </Callout>

      <ChatMockup
        agentName="agent"
        script={[
          {
            from: 'agent',
            time: 'Calendar reminder',
            text:
              'Your retro starts in 10 minutes. Want me to pull the issues you opened this sprint?',
          },
          {
            from: 'user',
            text: 'yes please',
          },
        ]}
      />

      <H2>Wake on your own code</H2>
      <p style={proseP}>
        For the use cases that aren't covered by extensions — a webhook, a private API,
        etc. — the agent can run its own code on the side. The code runs outside the
        sandbox, decides when to act, and pings the agent through the same delivery path.
      </p>

      <Callout kind="jargon">
        Service code lives at <code>blueprint/service/</code> and runs as a child process
        the framework supervises. See{' '}
        <DocsLink href="/docs/build/services">Writing services</DocsLink> for the trust
        model and the IPC contract.
      </Callout>

      <H2>What to read next</H2>
      <ul style={proseUl}>
        <li>
          <DocsLink href="/docs/concepts/capabilities">Capabilities</DocsLink> — extensions
          and services in depth, including their trust and isolation properties.
        </li>
        <li>
          <DocsLink href="/docs/concepts/channels">Channels</DocsLink> — every trigger
          lands on a channel; the channel's config shapes the turn the agent receives.
        </li>
        <li>
          <DocsLink href="/docs/concepts/multi-user">Conversation grid</DocsLink> — when
          people share one agent, each gets their own cell; a shared file lets those cells
          coordinate.
        </li>
      </ul>
    </DocsLayout>
  );
}
