import { DocsLayout, H2, proseP } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { AskConsole, ConsoleChip } from '../../../components/docs/consoleTheme';

export function UseAccess() {
  return (
    <DocsLayout
      url="/docs/use/access"
      crumbs={['docs', 'use cast', 'access']}
      title="Access"
      lede="Cast doesn't let strangers in. The first message from anyone you haven't allowed is held, and you approve it from the dashboard, once or for good."
      toc={[
        { label: 'How access works' },
        { label: 'Approving yourself' },
        { label: 'Blocking and revoking' },
        { label: 'Channel scoping' },
        { label: 'Agents reaching agents' },
        { label: 'Transports' },
      ]}
    >
      <H2>How access works</H2>
      <p style={proseP}>
        Same flow on every transport. It begins the first time someone messages the agent.
      </p>
      <ol style={{ ...proseP, paddingLeft: 22, listStyle: 'decimal' }}>
        <li>
          Someone messages the agent. The server resolves who they are. If you haven't
          granted them, the message is held. It doesn't reach the agent yet.
        </li>
        <li>
          The held message surfaces as a pending approval in the dashboard, on the agent's
          row. You see who's asking and what they sent.
        </li>
        <li>
          You allow or deny it in place. <strong>Allow once</strong> lets this single
          message through. <strong>Allow always</strong> grants durable access, and the
          held message replays into the agent right away.
        </li>
        <li>After an always-grant, their messages reach the agent directly. No second step.</li>
      </ol>
      <p style={proseP}>
        Only the people you act on get through. A stranger you never approve stays held,
        and the agent never sees them.
      </p>

      <H2>Approving yourself</H2>
      <p style={proseP}>
        When the person is you, there's no waiting. Open the agent's chat URL (or message
        it on whatever transport you set up), then switch to the dashboard and allow
        yourself always. You're in. Same approval, no out-of-band step, because both ends
        are your own.
      </p>

      <H2>Blocking and revoking</H2>
      <p style={proseP}>
        Three states, not two. Someone is <strong>granted</strong> (their messages reach
        the agent), <strong>askable</strong> (a first contact held for your yes or no), or{' '}
        <strong>blocked</strong> (denied for good). Deny-always writes a block that drops
        future attempts without asking you again. Revoking a grant you made earlier returns
        that person to held. To block or revoke after the fact, tell{' '}
        <ConsoleChip kind="configure" />:
      </p>

      <AskConsole kind="configure">
        Block this sender and don't ask me about them again.
      </AskConsole>

      <H2>Channel scoping</H2>
      <p style={proseP}>
        Access is per channel. Approving someone into one channel makes them a member
        there, so the agent can see them alongside anyone else in that room and carry
        messages between them when the channel allows it. To reach a second channel, they
        get approved into that one too, and grants accumulate instead of replacing each
        other. To scope a person to certain channels, or move them off one, tell{' '}
        <ConsoleChip kind="configure" />:
      </p>

      <AskConsole kind="configure">
        Scope Sam to the briefings channel only, nothing else.
      </AskConsole>

      <H2>Agents reaching agents</H2>
      <p style={proseP}>
        Agents find and reach each other the same reactive way. One agent can discover
        another and request to reach it, and nothing crosses until the owner on the other
        side approves the edge. The shapes that edge can take (one agent querying another,
        handing a conversation across) live in{' '}
        <DocsLink href="/docs/build/multi-agent">Multi-agent composition</DocsLink>.
        Different surface, same idea: discovery is open, reaching is approved.
      </p>

      <H2>Transports</H2>
      <p style={proseP}>
        At launch: web, Telegram, Slack. Same held-and-approve flow on all three.
      </p>

      <Callout kind="tip">
        Held messages surface in the dashboard, on the agent's row, not in the chat
        consoles directly. <ConsoleChip kind="configure" /> can narrow, revoke, or block
        access for you, but the allow-or-deny of a held first contact is dashboard-driven.
      </Callout>
    </DocsLayout>
  );
}
