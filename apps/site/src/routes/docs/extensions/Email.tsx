import { DocsLayout, H2, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { Code } from '../../../components/ui/Code';
import { FileSpec } from '../../../components/docs/FileSpec';
import { FieldTable } from '../../../components/docs/FieldTable';
import { Tabs } from '../../../components/docs/Tabs';
import { ToolDoc } from '../../../components/docs/ToolDoc';

export function ExtensionsEmail() {
  return (
    <DocsLayout
      url="/docs/extensions/email"
      crumbs={['docs', 'plugins', 'extensions', 'email']}
      title="email"
      lede="IMAP/SMTP as a capability — the agent can search and read your mail, send and reply, and stand up subscriptions that wake it when matching mail arrives. Works with any provider."
      toc={[
        { label: 'What the agent can do' },
        { label: 'Getting mailbox credentials' },
        { label: 'Secrets' },
        { label: 'Configuration' },
        { label: 'Tools' },
        { label: 'Subscriptions' },
        { label: 'Notes & gotchas' },
      ]}
    >
      {/* DISCONNECTED: email transport temporarily disabled — this callout
          pointed at /docs/transports/email which is no longer routed. Restore
          when the email transport is re-enabled. */}
      {/*
      <Callout kind="warn">
        The email <strong>extension</strong> gives the agent its own tools to read and send
        mail. Don't confuse it with the{' '}
        <DocsLink href="/docs/transports/email">email transport</DocsLink>, which lets you
        chat with the agent by emailing it.
      </Callout>
      */}

      <H2>What the agent can do</H2>
      <ul style={proseUl}>
        <li>
          <strong>Triage → fetch → act</strong> — search returns envelope summaries; fetch
          downloads a chosen message to staging as <code>.md</code> and <code>.eml</code>;
          send composes or replies in-thread.
        </li>
        <li>
          <strong>Browse folders</strong> — list the mailbox's folders, filtered by the
          configured allowlist.
        </li>
        <li>
          <strong>Scope is enforced server-side</strong> — the sender allow/deny lists are
          pushed into the IMAP query, so out-of-scope mail never comes back.
        </li>
      </ul>

      <H2>Getting mailbox credentials</H2>
      <p style={proseP}>
        Give the agent a dedicated mail account — credentials are stored on disk, so keep it
        separate from your personal account. You'll need the IMAP and SMTP host and port,
        and a password; providers with 2FA require an app-specific password.
      </p>
      <Tabs
        tabs={[
          {
            id: 'gmail',
            label: 'Gmail',
            content: (
              <ul style={proseUl}>
                <li>IMAP <code>imap.gmail.com:993</code>, SMTP <code>smtp.gmail.com:465</code>.</li>
                <li>
                  App password at{' '}
                  <a href="https://myaccount.google.com/apppasswords">myaccount.google.com/apppasswords</a>.
                </li>
              </ul>
            ),
          },
          {
            id: 'icloud',
            label: 'iCloud',
            content: (
              <ul style={proseUl}>
                <li>IMAP <code>imap.mail.me.com:993</code>, SMTP <code>smtp.mail.me.com:587</code>.</li>
                <li>App password at <a href="https://account.apple.com">account.apple.com</a> → Sign-In and Security.</li>
              </ul>
            ),
          },
          {
            id: 'outlook',
            label: 'Outlook / 365',
            content: (
              <ul style={proseUl}>
                <li>IMAP <code>outlook.office365.com:993</code>, SMTP <code>smtp.office365.com:587</code>.</li>
              </ul>
            ),
          },
          {
            id: 'fastmail',
            label: 'Fastmail',
            content: (
              <ul style={proseUl}>
                <li>IMAP <code>imap.fastmail.com:993</code>, SMTP <code>smtp.fastmail.com:465</code>.</li>
                <li>App password under Settings → Privacy &amp; Security.</li>
              </ul>
            ),
          },
        ]}
      />

      <H2>Secrets</H2>
      <FileSpec name="secrets.json" meta="json · config/ext/email/">
        <Code lang="json" noHead>{`{
  "EMAIL_ADDRESS": "agent@example.com",
  "EMAIL_PASSWORD": "app-specific-password",
  "IMAP_HOST": "imap.gmail.com",
  "IMAP_PORT": 993,
  "SMTP_HOST": "smtp.gmail.com",
  "SMTP_PORT": 465
}`}</Code>
      </FileSpec>

      <H2>Configuration</H2>
      <p style={proseP}>
        Config splits into <code>inbound</code> (search and subscribe) and{' '}
        <code>outbound</code> (send), each with an approval mode and scope lists. The mode is
        a ladder: <code>disabled</code> doesn't register the tool, <code>approval</code>{' '}
        prompts per call, <code>enabled</code> runs within scope without prompting.
      </p>
      <FileSpec name="capabilities.json" meta="json · extensions.email slice">
        <Code lang="json" noHead>{`{
  "extensions": {
    "email": {
      "enabled": true,
      "channel": "email",
      "inbound": { "default": "approval", "senders": ["@acme.com"] },
      "outbound": { "default": "approval", "recipients": [] }
    }
  }
}`}</Code>
      </FileSpec>
      <FieldTable
        fields={[
          {
            name: 'inbound.default',
            type: 'disabled | approval | enabled',
            default: 'approval',
            effect: 'Approval policy for search and subscribe.',
          },
          {
            name: 'inbound.senders',
            type: 'string[]',
            default: '[]',
            effect: (
              <>
                Sender allowlist — exact (<code>alice@acme.com</code>) or domain (
                <code>@acme.com</code>). Empty means any. Enforced in the IMAP query.
              </>
            ),
          },
          {
            name: 'inbound.blocked',
            type: 'string[]',
            default: '[]',
            effect: 'Sender denylist; same syntax.',
          },
          {
            name: 'outbound.default',
            type: 'disabled | approval | enabled',
            default: 'approval',
            effect: 'Approval policy for send.',
          },
          {
            name: 'outbound.recipients',
            type: 'string[]',
            default: '[]',
            effect: 'Recipient allowlist. Empty means any.',
          },
          {
            name: 'outbound.blocked',
            type: 'string[]',
            default: '[]',
            effect: 'Recipients the agent may never send to.',
          },
        ]}
      />
      <p style={proseP}>
        Finer knobs tune scope and approval bypass: <code>inbound.folders</code>,{' '}
        <code>inbound.window_days</code>, <code>inbound.max_results</code>, the{' '}
        <code>always_allow</code> lists on each side (senders/recipients that skip the
        prompt), and <code>inbound.require_auth</code> (require DKIM/DMARC alignment on
        subscriptions).
      </p>

      <H2>Tools</H2>

      <ToolDoc
        name="email__search"
        summary="Search emails via IMAP, returning envelope summaries (id, from, to, subject, date, snippet)."
        params={[
          { name: 'from', type: 'string', desc: 'Filter by sender address.' },
          { name: 'to', type: 'string', desc: 'Filter by recipient address.' },
          { name: 'subject', type: 'string', desc: 'Filter by subject (substring match).' },
          { name: 'body', type: 'string', desc: 'Filter by body content.' },
          { name: 'folder', type: 'string', default: 'INBOX', desc: 'IMAP folder name.' },
        ]}
        returns={[
          { value: 'ID: EMAIL_ID\nFrom: FROM\nTo: TO\nDate: DATE\nSubject: SUBJECT\nSnippet: SNIPPET', when: 'one block per match, separated by blank lines' },
          { value: '(Showing N of TOTAL matches)', when: 'appended when result count exceeds max_results' },
          { value: 'No emails found.', when: 'zero matches' },
          { value: 'Search failed: ERROR', when: 'IMAP error' },
        ]}
      />

      <ToolDoc
        name="email__fetch"
        summary="Download emails to staging as .md (parsed text with headers, attachment summary, image stats) and .eml (raw MIME)."
        params={[
          { name: 'ids', type: 'string[]', desc: 'Email IDs to fetch (batch). Use this or emailId.' },
          { name: 'emailId', type: 'string', desc: 'Single email ID (alternative to ids).' },
          { name: 'folder', type: 'string', default: 'INBOX', desc: 'IMAP folder name.' },
        ]}
        returns={[
          { value: 'Fetched N email(s) to /staging/in/\n  ID: ID | From: FROM | Subject: SUBJECT\n    FILENAME.md, FILENAME.eml\n\nUse Read to access .md files. Use .eml for raw MIME / attachments.', when: 'success' },
          { value: 'Rejected N email(s):\n  ID: ID — REASON', when: 'partial success with rejections' },
          { value: 'Missing required field: ids or emailId', when: 'no id provided' },
          { value: 'Fetch failed: ERROR', when: 'IMAP error' },
        ]}
      />

      <ToolDoc
        name="email__send"
        summary="Compose and send an email. Reply in-thread by passing replyToMessageId."
        params={[
          { name: 'to', type: 'string', required: true, desc: 'Recipient email address.' },
          { name: 'subject', type: 'string', required: true, desc: 'Email subject.' },
          { name: 'body', type: 'string', required: true, desc: 'Plain text email body.' },
          { name: 'replyToMessageId', type: 'string', desc: 'RFC Message-ID to reply to (from an email__fetch result).' },
        ]}
        returns={[
          { value: 'Email sent. Message-ID: MESSAGE_ID', when: 'success' },
          { value: 'Invalid arguments: ERROR', when: 'validation failure' },
          { value: 'Email sending is disabled for this agent.', when: 'outbound.default = disabled' },
          { value: 'Send failed: ERROR', when: 'SMTP error' },
        ]}
      />

      <ToolDoc
        name="email__list_folders"
        summary="List all available IMAP mailbox folders."
        returns={[
          { value: 'FOLDER_PATH\nFOLDER_PATH — DISPLAY_NAME\n…', when: 'one per line, optionally showing folder name and special-use attribute' },
          { value: 'No folders found.', when: 'empty mailbox' },
          { value: 'Failed to list folders: ERROR', when: 'IMAP error' },
        ]}
      />

      <ToolDoc
        name="email__subscribe"
        summary="Watch for new emails matching criteria. Matches arrive on the configured channel as new turns with the agent's standing instructions."
        params={[
          { name: 'schedule', type: 'string', required: true, desc: '"realtime" for IMAP IDLE push, or a cron expression like "*/15 * * * *".' },
          { name: 'instructions', type: 'string', required: true, desc: 'Instructions delivered with each matching email.' },
          { name: 'from', type: 'string', desc: 'Filter by sender address.' },
          { name: 'subject', type: 'string', desc: 'Filter by subject.' },
          { name: 'folder', type: 'string', default: 'INBOX', desc: 'IMAP folder to watch.' },
          { name: 'id', type: 'string', desc: 'Custom subscription ID (auto-generated if omitted).' },
          { name: 'timezone', type: 'IANA timezone', desc: 'Timezone for cron schedule. Defaults to agent timezone.' },
        ]}
        returns={[
          { value: 'Subscription created:\n  ID: ID\n  Folder: FOLDER\n  Schedule: SCHEDULE\n  Target: PARTICIPANT\n  Watermark: WATERMARK', when: 'success' },
          { value: 'Missing required fields: schedule, instructions', when: 'incomplete input' },
          { value: 'Subscriptions require a participant context.', when: 'called outside an active conversation' },
          { value: 'Invalid cron expression: ERROR', when: 'malformed cron' },
        ]}
      />

      <ToolDoc
        name="email__unsubscribe"
        summary="Remove an email subscription."
        params={[
          { name: 'id', type: 'string', required: true, desc: 'Subscription ID to remove.' },
        ]}
        returns={[
          { value: 'Subscription "ID" removed.', when: 'success' },
          { value: 'Missing required field: id', when: 'no id provided' },
          { value: 'Subscription not found: ID', when: 'unknown id' },
        ]}
      />

      <ToolDoc
        name="email__list_subscriptions"
        summary="List all email subscriptions and their status."
        returns={[
          { value: 'ID: ID\n  Folder: FOLDER\n  Schedule: SCHEDULE\n  Target: TARGET\n  Status: active|paused\n  Watermark: WATERMARK\n  Created: ISO_TIMESTAMP\n  Criteria: CRITERIA_JSON', when: 'one block per subscription, separated by blank lines' },
          { value: 'No email subscriptions.', when: 'none registered' },
        ]}
      />

      <H2>Subscriptions</H2>
      <p style={proseP}>
        With a dedicated <code>channel</code>, the agent can subscribe to matching mail —
        either real-time (IMAP IDLE) or on a schedule. New mail is delivered to that channel
        with each subscription's standing instructions, and the agent acts on it without
        being asked. Without a channel, the subscription tools are hidden and the on-demand
        tools still work.
      </p>

      <H2>Notes &amp; gotchas</H2>
      <Callout kind="security">
        Start <code>outbound.default</code> at <code>disabled</code> and widen with a narrow{' '}
        <code>outbound.recipients</code> only when the agent needs to send; keep{' '}
        <code>inbound.default</code> at <code>approval</code> unless you're deliberately
        opening reads. Broad subscriptions widen the agent's input surface.
      </Callout>
      <Callout kind="warn">
        Credentials live on disk in <code>secrets.json</code>. Use a dedicated mailbox and an
        app-specific password.
      </Callout>
    </DocsLayout>
  );
}
