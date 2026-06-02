import { DocsLayout, H2, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { Callout } from '../../../components/ui/Callout';
import { Code } from '../../../components/ui/Code';
import { FileSpec } from '../../../components/docs/FileSpec';
import { FieldTable } from '../../../components/docs/FieldTable';
import { ToolDoc } from '../../../components/docs/ToolDoc';

export function ExtensionsWhatsApp() {
  return (
    <DocsLayout
      url="/docs/extensions/whatsapp"
      crumbs={['docs', 'plugins', 'extensions', 'whatsapp']}
      title="whatsapp"
      lede="WhatsApp as a data source and action surface — the agent reads and sends messages and downloads media as a capability. It connects through the WhatsApp Web linked-device protocol, not a chat the agent talks over."
      toc={[
        { label: 'What the agent can do' },
        { label: 'Pairing your phone' },
        { label: 'Configuration' },
        { label: 'Tools' },
        { label: 'Watches' },
        { label: 'Notes & gotchas' },
      ]}
    >
      <H2>What the agent can do</H2>
      <ul style={proseUl}>
        <li>
          <strong>Orient → read → act</strong> — list recent chats with previews and unread
          counts, look up a conversation by name or number, then read, send, or download.
        </li>
        <li>
          <strong>Media</strong> — messages show a placeholder with an id; the agent
          downloads media to staging, and sends media by writing to staging first.
        </li>
        <li>
          <strong>Persistent history</strong> — messages stream into a local store and
          survive restarts; WhatsApp delivers the historical backfill once, at pairing.
        </li>
      </ul>

      <H2>Pairing your phone</H2>
      <p style={proseP}>
        Pairing happens in the admin dashboard, on this agent's WhatsApp extension page —
        there are no credentials to paste. The agent links to your account as a device, the
        same way WhatsApp Web does, and the session is stored under{' '}
        <code>ext/whatsapp/auth/</code>. Under <strong>Pairing Status</strong> on that page:
      </p>
      <ol style={proseUl}>
        <li>
          Optionally choose how much history to sync — Standard (~3 months) or Extended (~1
          year). It only takes effect at pairing.
        </li>
        <li>
          Enter your phone number with country code (e.g. <code>+1 415 555 0142</code>) and
          click <strong>Pair Device</strong>.
        </li>
        <li>
          A 6-digit code appears. On your phone, open WhatsApp → Settings → Linked Devices →
          Link a Device → Link with phone number, and enter it.
        </li>
        <li>
          The page polls for up to two minutes and flips to <strong>Paired</strong> once
          linked, syncing recent history into a local store.
        </li>
      </ol>
      <p style={proseP}>
        Once paired, the same page shows the linked status and synced-chat count, with an
        Unpair button to clear the session.
      </p>
      <Callout kind="warn">
        Right after pairing, the connection may report a one-off stream error and reconnect
        on its own — that's expected.
      </Callout>

      <H2>Configuration</H2>
      <FileSpec name="capabilities.json" meta="json · extensions.whatsapp slice">
        <Code lang="json" noHead>{`{
  "extensions": {
    "whatsapp": {
      "enabled": true,
      "read_mode": "approval",
      "send_mode": "disabled"
    }
  }
}`}</Code>
      </FileSpec>
      <FieldTable
        fields={[
          {
            name: 'read_mode',
            type: 'disabled | approval | open',
            default: 'approval',
            effect: 'Default policy for reading chats, messages, and media.',
          },
          {
            name: 'send_mode',
            type: 'disabled | approval | direct',
            default: 'disabled',
            effect: 'Default policy for sending. direct sends without prompting.',
          },
          {
            name: 'chats',
            type: 'Record<jid, overrides>',
            default: '{}',
            effect: 'Per-chat overrides — allow or deny read and send independently for a specific contact.',
          },
        ]}
      />
      <p style={proseP}>
        <code>pairing_history_depth</code> (standard or extended) sets how much history
        WhatsApp delivers, and applies only at pairing time — changing it means unpairing and
        pairing again.
      </p>

      <H2>Tools</H2>

      <ToolDoc
        name="whatsapp__chats"
        summary="List recent WhatsApp chats with names, last-message previews, unread counts, and group status."
        params={[
          { name: 'limit', type: 'integer 1–50', default: '20', desc: 'Max chats to return.' },
        ]}
        returns={[
          { value: 'CHAT_NAME (group) [N unread]\nCHAT_NAME\n…', when: 'chats exist' },
          { value: 'No chats yet.', when: 'empty store' },
          { value: 'Reading is disabled.', when: 'read_mode = disabled and no readable chats' },
        ]}
      />

      <ToolDoc
        name="whatsapp__messages"
        summary="Read messages from a WhatsApp chat by contact name, phone number, or JID. Optionally filter by keyword."
        params={[
          { name: 'chat', type: 'string', required: true, desc: 'Chat identifier — name, phone number, or JID.' },
          { name: 'count', type: 'integer 1–100', default: '20', desc: 'Number of messages to return.' },
          { name: 'query', type: 'string', desc: 'Keyword to filter messages — returns only those containing this text.' },
        ]}
        returns={[
          { value: '[YYYY-MM-DD HH:MM] SENDER: TEXT (ID: MESSAGE_ID)', when: 'standard message line' },
          { value: '[YYYY-MM-DD HH:MM] SENDER: [image|video|voice note|audio|document: FILENAME|sticker] [optional CAPTION] (ID: MESSAGE_ID)', when: 'media message line' },
          { value: 'No messages available for this chat yet.', when: 'empty chat' },
          { value: 'No messages matching "QUERY" in this chat.', when: 'keyword filter matches nothing' },
          { value: 'Multiple chats match "QUERY". Please specify:\nCHAT_NAME — JID (group)\n…', when: 'ambiguous chat identifier' },
          { value: 'No chat found matching "QUERY".', when: 'identifier does not resolve' },
          { value: 'Access to this chat is restricted.', when: 'ACL blocks read for this contact' },
          { value: 'WhatsApp not paired. Link a device in the admin panel first.', when: 'session not initialized' },
          { value: 'WhatsApp not ready — connection timeout. Try again in a moment.', when: 'connection stalled' },
        ]}
      />

      <ToolDoc
        name="whatsapp__download"
        summary="Download media from a WhatsApp message to /staging/in/ for inspection with the Read tool."
        params={[
          { name: 'message_id', type: 'string', required: true, desc: 'Message ID from whatsapp__messages output.' },
          { name: 'chat', type: 'string', required: true, desc: 'Chat identifier (name, phone, or JID) containing the message.' },
        ]}
        returns={[
          { value: 'Downloaded to /staging/in/FILENAME. Use the Read tool to view it.', when: 'success — filename from document metadata or media_<truncated-id>.<ext>' },
          { value: 'Message not found or no longer in buffer.', when: 'message ID not in store' },
          { value: 'Media download failed — the file may have expired. ERROR', when: 'download failure' },
          { value: 'Access to this chat is restricted.', when: 'ACL blocks read' },
          { value: 'WhatsApp not paired. Link a device in the admin panel first.', when: 'session not initialized' },
        ]}
      />

      <ToolDoc
        name="whatsapp__send"
        summary="Send a text or media message to a WhatsApp chat. Media is read from /staging/out/ with an optional caption."
        params={[
          { name: 'chat', type: 'string', required: true, desc: 'Chat identifier (name, phone, or JID).' },
          { name: 'text', type: 'string', desc: 'Message text. Required for text-only sends; used as caption when file is set.' },
          { name: 'file', type: 'string', desc: 'Filename in /staging/out/ to send as media.' },
        ]}
        returns={[
          { value: 'Message sent.', when: 'success' },
          { value: 'Provide at least text or file to send.', when: 'both text and file absent' },
          { value: 'File not found: /staging/out/FILENAME', when: 'file path does not exist' },
          { value: 'No routable address for this contact.', when: 'contact has no valid JID' },
          { value: 'Sending to this chat is disabled.', when: 'ACL blocks send' },
          { value: 'Send failed: ERROR', when: 'socket error or library exception' },
          { value: 'WhatsApp not connected.', when: 'socket is null' },
          { value: 'WhatsApp not paired. Link a device in the admin panel first.', when: 'session not initialized' },
        ]}
      />

      <ToolDoc
        name="whatsapp__watch"
        summary="Monitor a WhatsApp chat for new messages. Each new message is forwarded to the agent's channel with the configured instructions."
        params={[
          { name: 'chat', type: 'string', required: true, desc: 'Chat identifier (name, phone, or JID).' },
          { name: 'instructions', type: 'string', required: true, desc: 'Instructions delivered with each forwarded batch.' },
          { name: 'id', type: 'string', desc: 'Custom watch ID. Auto-generated as watch_<random> if omitted.' },
        ]}
        returns={[
          { value: 'Watch "ID" created for CHAT_NAME. New messages will be forwarded with your instructions.', when: 'success' },
          { value: 'Instructions are required.', when: 'empty instructions' },
          { value: 'Multiple chats match "QUERY". Please specify:\nCHAT_NAME — JID (group)\n…', when: 'ambiguous chat identifier' },
          { value: 'No chat found matching "QUERY".', when: 'identifier does not resolve' },
          { value: 'Access to this chat is restricted.', when: 'ACL blocks read' },
          { value: 'Watches require a participant context.', when: 'called outside an active conversation' },
          { value: 'WhatsApp not paired.', when: 'session not initialized' },
        ]}
        notes={`Delivery format: each fired batch arrives as a turn in the agent's channel —\n  New WhatsApp messages in "CHAT_NAME":\n\n  [YYYY-MM-DD HH:MM] SENDER: TEXT\n  [YYYY-MM-DD HH:MM] SENDER: [media placeholder] CAPTION\n  …\n\n  Watch instructions: INSTRUCTIONS`}
      />

      <ToolDoc
        name="whatsapp__unwatch"
        summary="Remove an active WhatsApp watch by ID."
        params={[
          { name: 'id', type: 'string', required: true, desc: 'Watch ID to remove. List with whatsapp__list_watches.' },
        ]}
        returns={[
          { value: 'Watch "ID" removed.', when: 'success' },
          { value: 'Watch "ID" not found.', when: 'unknown id' },
        ]}
      />

      <ToolDoc
        name="whatsapp__list_watches"
        summary="List all active WhatsApp watches with their chat, instructions, and creation timestamps."
        returns={[
          { value: 'ID: ID\n  Chat: CHAT_NAME\n  Instructions: INSTRUCTIONS\n  Created: ISO_TIMESTAMP', when: 'one block per watch, separated by blank lines' },
          { value: 'No active watches.', when: 'none registered' },
        ]}
      />

      <H2>Watches</H2>
      <p style={proseP}>
        With a dedicated <code>channel</code>, the agent can watch a chat in real time and
        have new messages forwarded to that channel with standing instructions, so it reacts
        as they arrive. Without a channel, the watch tools are hidden and the on-demand tools
        still work.
      </p>

      <H2>Notes &amp; gotchas</H2>
      <Callout kind="security">
        <code>send_mode: direct</code> lets the agent message contacts autonomously, as you —
        recipients see it from your number. Prefer <code>approval</code> (or{' '}
        <code>disabled</code>) and grant <code>direct</code> only to trusted chats via the
        per-chat overrides.
      </Callout>
      <Callout kind="warn">
        The agent holds a single WhatsApp connection. Opening another client for the same
        account elsewhere will conflict with it, so keep one live link per account.
      </Callout>
    </DocsLayout>
  );
}
