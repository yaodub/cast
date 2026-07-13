import { DocsLayout, H2, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { Code } from '../../../components/ui/Code';
import { FileSpec } from '../../../components/docs/FileSpec';
import { FieldTable } from '../../../components/docs/FieldTable';

export function TransportsTelegram() {
  return (
    <DocsLayout
      url="/docs/transports/telegram"
      crumbs={['docs', 'plugins', 'transports', 'telegram']}
      title="telegram"
      lede="The Telegram bot API — direct messages and group chats reach an agent through a bot you mint with BotFather and connect to the server."
      toc={[
        { label: 'Getting a bot token' },
        { label: 'Route configuration' },
        { label: 'What works in chat' },
        { label: 'Notes & gotchas' },
      ]}
    >
      <H2>Getting a bot token</H2>
      <p style={proseP}>
        Telegram bot tokens are minted by <strong>BotFather</strong>, an in-app bot you
        message directly.
      </p>
      <ol style={proseUl}>
        <li>
          Open Telegram and start a chat with{' '}
          <a href="https://t.me/BotFather">@BotFather</a>.
        </li>
        <li>
          Send <code>/newbot</code> and follow BotFather's prompts to name your bot.
        </li>
        <li>
          BotFather replies with a token of the form <code>123456:ABC-DEF…</code>. That's
          the credential.
        </li>
      </ol>

      <H2>Route configuration</H2>
      <p style={proseP}>
        Each Telegram entry binds one bot to one agent. Run multiple agents by adding more
        entries — one bot per agent.
      </p>

      <FileSpec name="routes.json" meta="json · telegram slice">
        <Code lang="json" noHead>{`{
  "telegram": [
    {
      "address": "assistant",
      "token": "123456:ABC-DEF...",
      "channel": "default"
    }
  ]
}`}</Code>
      </FileSpec>

      <FieldTable
        fields={[
          {
            name: 'address',
            type: 'string',
            required: true,
            effect: 'Canonical agent address this bot routes to.',
          },
          {
            name: 'token',
            type: 'string',
            required: true,
            effect: 'The BotFather token. Masked in the admin form; stored in routes.json.',
          },
          {
            name: 'channel',
            type: 'string',
            effect: "Channel preset for conversations. Falls back to the agent's default.",
          },
          {
            name: 'streaming',
            type: 'boolean',
            default: 'true',
            effect: (
              <>
                Live edit-in-place streaming. Set false where the editing UX is unwanted
                or Telegram rate limits make live edits flaky — the bubble never opens and
                each response is sent once, sealed.
              </>
            ),
          },
        ]}
      />

      <H2>What works in chat</H2>
      <ul style={proseUl}>
        <li>
          <strong>Live streaming</strong> — the bot posts a message and edits it in place
          as the agent writes, then seals it when the turn finishes.
        </li>
        <li>
          <strong>Approvals</strong> — sensitive actions appear as inline keyboard
          buttons; tap approve or reject and the message updates with the decision.
        </li>
        <li>
          <strong>DMs and groups</strong> — works one-on-one or in a group. In groups,
          Telegram's default privacy mode means the bot only sees messages directed at it
          — which suits assistant-style use, no change needed.
        </li>
        <li>
          <strong>Attachments</strong> — inbound photos, documents, voice, audio, video,
          and stickers reach the agent, along with structured payloads like contacts,
          locations, and polls. Outbound files are sent in the right format for their
          type.
        </li>
        <li>
          <strong>Typing indicator</strong> — shows while the agent is working.
        </li>
        <li>
          <strong>Command menu</strong> — Cast keeps the bot's <code>/</code> menu in sync
          with the server's system commands automatically.
        </li>
      </ul>

      <H2>Notes &amp; gotchas</H2>
      <Callout kind="tip">
        Privacy mode is on by default and needs no change for DM-style use. Cast manages
        the BotFather command menu (<code>/setcommands</code>) for you — don't set it
        manually.
      </Callout>
      <p style={proseP}>
        Credentials sit in <code>routes.json</code> with no separate secrets file — see{' '}
        <DocsLink href="/docs/transports">Transports</DocsLink> for the config model
        shared across all transports.
      </p>
    </DocsLayout>
  );
}
