import { DocsLayout, H2, proseP } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { AskConsole, ConsoleChip } from '../../../components/docs/consoleTheme';

export function UsePairing() {
  return (
    <DocsLayout
      url="/docs/use/pairing"
      crumbs={['docs', 'use cast', 'pairing']}
      title="Pairing"
      lede="Cast doesn't let strangers in. Each person pairs once per transport before the agent will talk to them."
      toc={[
        { label: 'How pairing works' },
        { label: 'Pairing yourself' },
        { label: 'Channel access' },
        { label: 'Transports you can pair to' },
      ]}
    >
      <H2>How pairing works</H2>
      <p style={proseP}>
        Same flow on every transport:
      </p>
      <ol style={{ ...proseP, paddingLeft: 22, listStyle: 'decimal' }}>
        <li>
          The person sends <code>/pair</code> to the agent on their transport.
        </li>
        <li>
          The server captures their handle and generates a pairing code. It appears in the
          agent's pairing panel in the dashboard, paired with the new handle.
        </li>
        <li>
          You — the operator — recognize the request and approve it by sharing the code
          with the person out-of-band (text, voice, in-person).
        </li>
        <li>
          They enter the code on their transport (<code>/pair &lt;code&gt;</code> for
          Telegram, Slack; paste into the prompt for web).
        </li>
        <li>Paired. They can now message the agent.</li>
      </ol>
      <p style={proseP}>
        Only forward the code to the person you actually recognize. A stranger who sends{' '}
        <code>/pair</code> never gets the code back, so the request sits in the panel
        unfulfilled.
      </p>

      <H2>Pairing yourself</H2>
      <p style={proseP}>
        When you're the person pairing, you play both sides. Open the agent's chat URL (or
        message it on whatever transport you wired up), send <code>/pair</code>, switch to
        the dashboard, copy the code, switch back, paste it in. Same flow — no out-of-band
        step because you're ferrying between your own tabs.
      </p>

      <H2>Channel access</H2>
      <p style={proseP}>
        You pair with one channel at a time. Pairing into a channel makes you a member of
        it, so the agent can see you alongside anyone else there and carry messages between
        you, if the channel's configuration allows it. To reach a second channel, you pair
        into that one too, and the grants accumulate instead of replacing each other. To
        scope a person to certain channels, or move them off one, tell{' '}
        <ConsoleChip kind="configure" />:
      </p>

      <AskConsole kind="configure">
        Scope Sam to the briefings channel only, nothing else.
      </AskConsole>

      <p style={proseP}>
        For agent-to-agent permissions (one agent querying another, pushing a conversation
        across), see{' '}
        <DocsLink href="/docs/build/multi-agent">Multi-agent composition</DocsLink>.
        Different surface, different file underneath, same idea.
      </p>

      <H2>Transports you can pair to</H2>
      <p style={proseP}>
        At launch: web, Telegram, Slack. Same <code>/pair</code> flow on all three.
      </p>

      <Callout kind="tip">
        Pairing requests appear in the agent's pairing panel in the dashboard — not in the
        chat consoles directly. Configure can help with operations like narrowing or
        revoking access, but the basic accept-pairing-code workflow is panel-driven.
      </Callout>
    </DocsLayout>
  );
}
