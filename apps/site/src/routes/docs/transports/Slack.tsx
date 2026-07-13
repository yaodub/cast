import { DocsLayout, H2, H3, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { Code } from '../../../components/ui/Code';
import { FileSpec } from '../../../components/docs/FileSpec';
import { FieldTable } from '../../../components/docs/FieldTable';
import { Tabs } from '../../../components/docs/Tabs';

export function TransportsSlack() {
  return (
    <DocsLayout
      url="/docs/transports/slack"
      crumbs={['docs', 'plugins', 'transports', 'slack']}
      title="slack"
      lede="A Slack app over Socket Mode — direct messages reach an agent through a bot you create at api.slack.com and connect to the server."
      toc={[
        { label: 'Getting the tokens' },
        { label: 'Route configuration' },
        { label: 'What works in chat' },
        { label: 'Notes & gotchas' },
      ]}
    >
      <H2>Getting the tokens</H2>
      <p style={proseP}>
        Cast connects as a Slack app via Socket Mode. You need <strong>two tokens</strong>,
        both minted at{' '}
        <a href="https://api.slack.com/apps">api.slack.com/apps</a>: a workspace bot token
        (<code>xoxb-…</code>) and an app-level token (<code>xapp-…</code>). There are two
        ways to set the app up — paste a manifest in one shot, or click through each
        setting by hand. The manifest is faster when Slack offers it, but the modal that
        exposes it isn't always shown; if you only see "Create New App" with a name field,
        use the manual path.
      </p>

      <Tabs
        tabs={[
          {
            id: 'manifest',
            label: 'Path A — manifest',
            content: (
              <>
                <p style={proseP}>
                  At{' '}
                  <a href="https://api.slack.com/apps?new_app=1">
                    api.slack.com/apps?new_app=1
                  </a>
                  , in the <strong>Create New App</strong> modal, choose{' '}
                  <strong>From a manifest</strong>, select your workspace, and paste:
                </p>
                <Code lang="yaml" title="slack app manifest">{`display_information:
  name: Cast
  description: Personal AI assistant
features:
  bot_user:
    display_name: Cast
    always_online: true
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
      - chat:write
      - im:history
      - im:read
      - im:write
      - users:read
      - files:read
      - files:write
settings:
  event_subscriptions:
    bot_events:
      - message.im
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
  token_rotation_enabled: false`}</Code>
                <Callout kind="warn">
                  The <code>messages_tab_read_only_enabled: false</code> line is critical —
                  without it the bot's DM input is disabled ("Sending messages to this app
                  has been turned off").
                </Callout>
                <p style={proseP}>
                  After creating the app, install it to your workspace and copy the{' '}
                  <code>xoxb-…</code> bot token from <strong>OAuth &amp; Permissions</strong>,
                  plus the <code>xapp-…</code> app-level token from{' '}
                  <strong>Basic Information → App-Level Tokens</strong>.
                </p>
              </>
            ),
          },
          {
            id: 'manual',
            label: 'Path B — manual',
            content: (
              <>
                <Callout kind="warn">
                  <strong>Order matters.</strong> Steps 1–2 (app-level token, then Socket
                  Mode) must come before steps 4–5. Otherwise Slack demands a public HTTPS
                  Request URL for events and interactivity, which Cast does not provide.
                </Callout>
                <ol style={proseUl}>
                  <li>
                    <strong>Basic Information → App-Level Tokens → Generate Token</strong>{' '}
                    — add scope <code>connections:write</code>. Save the{' '}
                    <code>xapp-…</code> token.
                  </li>
                  <li>
                    <strong>Socket Mode</strong> — toggle on. Required before steps 4–5:
                    events and interactivity flow over this WebSocket instead of an HTTPS
                    endpoint.
                  </li>
                  <li>
                    <strong>OAuth &amp; Permissions → Bot Token Scopes</strong> — add{' '}
                    <code>chat:write</code>, <code>im:history</code>, <code>im:read</code>,{' '}
                    <code>im:write</code>, <code>users:read</code>, <code>files:read</code>,{' '}
                    <code>files:write</code>.
                  </li>
                  <li>
                    <strong>Event Subscriptions</strong> — enable, then under{' '}
                    <em>Subscribe to bot events</em> add <code>message.im</code>. Save. The
                    Request URL field should be hidden or marked "not required" — that
                    confirms Socket Mode is on.
                  </li>
                  <li>
                    <strong>Interactivity &amp; Shortcuts</strong> — toggle on. Save.
                  </li>
                  <li>
                    <strong>App Home</strong> — set an App Display Name if empty. Then under{' '}
                    <em>Show Tabs</em>, enable the Messages Tab <strong>and</strong> check
                    "Allow users to send Slash commands and messages from the messages
                    tab". Without this checkbox, the bot's DM input is disabled.
                  </li>
                  <li>
                    <strong>Install App → Install to Workspace</strong> — approve, then save
                    the <code>xoxb-…</code> Bot User OAuth Token from the OAuth &amp;
                    Permissions page.
                  </li>
                </ol>
              </>
            ),
          },
        ]}
      />

      <H2>Route configuration</H2>
      <p style={proseP}>
        Each entry binds one Slack app to one agent. To run multiple agents from one
        workspace, create one app per agent and add one entry each.
      </p>

      <FileSpec name="routes.json" meta="json · slack slice">
        <Code lang="json" noHead>{`{
  "slack": [
    {
      "address": "assistant",
      "botToken": "xoxb-...",
      "appToken": "xapp-...",
      "allowedUserIds": ["U012ABCDEF"]
    }
  ]
}`}</Code>
      </FileSpec>

      <FieldTable
        fields={[
          {
            name: 'botToken',
            type: 'string',
            required: true,
            effect: (
              <>
                Bot User OAuth token, must start with <code>xoxb-</code>.
              </>
            ),
          },
          {
            name: 'appToken',
            type: 'string',
            required: true,
            effect: (
              <>
                App-level token with <code>connections:write</code>, must start with{' '}
                <code>xapp-</code>. Powers the Socket Mode connection.
              </>
            ),
          },
          {
            name: 'address',
            type: 'string',
            required: true,
            effect: 'Canonical agent address this app routes to.',
          },
          {
            name: 'channel',
            type: 'string',
            effect: "Channel preset for conversations. Falls back to the agent's default.",
          },
          {
            name: 'allowedTeamIds',
            type: 'string[]',
            effect: 'Workspace allowlist. Empty or omitted means no filter — the gateway ACL is the gate.',
          },
          {
            name: 'allowedUserIds',
            type: 'string[]',
            effect: 'Per-user allowlist. Empty or omitted means no filter.',
          },
          {
            name: 'botUserId',
            type: 'string',
            effect: (
              <>
                Override for the bot's own user ID (self-message filtering). Discovered via{' '}
                <code>auth.test()</code> at connect when omitted.
              </>
            ),
          },
          {
            name: 'streaming',
            type: 'boolean',
            default: 'true',
            effect: 'Live edit-in-place streaming. Set false to deliver one sealed message per response.',
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
          <strong>Approvals</strong> — sensitive actions appear as Block Kit buttons;
          approve or reject and the message updates with the decision.
        </li>
        <li>
          <strong>Attachments</strong> — work in both directions. The{' '}
          <code>files:read</code> scope is required, or inbound images fail silently.
        </li>
        <li>
          <strong>DM-only</strong> — Cast subscribes solely to <code>message.im</code> and
          ignores @mentions in channels and shared spaces.
        </li>
        <li>
          <strong>No typing indicator</strong> — Slack DMs expose no typing API. Lifecycle
          notices (waking, working) still render as messages when you're recently active.
        </li>
      </ul>

      <H2>Notes &amp; gotchas</H2>
      <Callout kind="warn">
        Keep <strong>token rotation off</strong> — Cast does not implement Slack's
        refresh-token dance. If you see a "Refresh Token" alongside the bot token, rotation
        is on; toggle it off (OAuth &amp; Permissions → Token Rotation) and reinstall.
      </Callout>
      <H3>Why Socket Mode</H3>
      <p style={proseP}>
        Socket Mode lets the app receive events over an outbound WebSocket that Cast opens
        itself, so the server runs anywhere with internet access — a laptop, a box behind a
        firewall. The trade-off is the second (<code>xapp-</code>) token and the step
        ordering above. Credentials live in{' '}
        <code>routes.json</code> with no separate secrets file; see{' '}
        <DocsLink href="/docs/transports">Transports</DocsLink> for the shared config
        model.
      </p>
    </DocsLayout>
  );
}
