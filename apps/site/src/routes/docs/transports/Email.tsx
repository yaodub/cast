// DISCONNECTED: email transport temporarily disabled. This page is preserved
// but not routed in App.tsx and not linked from the sidebar or the transports
// index. The reverse callout on routes/docs/extensions/Email.tsx is also
// commented out so it doesn't point at an unrouted URL. To re-enable: restore
// the route in App.tsx, the sidebar entry in sidebar.ts, the bullet + lede
// in transports/Index.tsx, and the callout in extensions/Email.tsx.
import { DocsLayout, H2, H3, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { DocsLink } from '../../../components/docs/DocsLink';
import { Callout } from '../../../components/ui/Callout';
import { Code } from '../../../components/ui/Code';
import { FileSpec } from '../../../components/docs/FileSpec';
import { FieldTable } from '../../../components/docs/FieldTable';
import { Tabs } from '../../../components/docs/Tabs';

export function TransportsEmail() {
  return (
    <DocsLayout
      url="/docs/transports/email"
      crumbs={['docs', 'plugins', 'transports', 'email']}
      title="email"
      lede="Generic IMAP/SMTP — inbound mail to a dedicated mailbox becomes a turn, and the agent's response comes back as a threaded reply. Works with any provider."
      toc={[
        { label: 'Getting mailbox credentials' },
        { label: 'Route configuration' },
        { label: 'What works in chat' },
        { label: 'Notes & gotchas' },
      ]}
    >
      <Callout kind="warn">
        The email <strong>transport</strong> lets you chat with the agent by emailing it.
        Don't confuse it with the{' '}
        <DocsLink href="/docs/extensions/email">email extension</DocsLink>, which gives the
        agent its own tools to read and send mail.
      </Callout>

      <H2>Getting mailbox credentials</H2>
      <p style={proseP}>
        Cast watches a mailbox over <strong>IMAP</strong> (reading inbound mail with IDLE)
        and sends replies over <strong>SMTP</strong>. Give the agent a{' '}
        <strong>dedicated mail account</strong> — credentials are stored on disk, so keep
        it separate from your personal account.
      </p>
      <ol style={proseUl}>
        <li>
          Pick or create a mail account the agent will own, e.g.{' '}
          <code>myagent@gmail.com</code>.
        </li>
        <li>
          If the provider uses 2FA (Gmail, iCloud, Outlook all do), generate an{' '}
          <strong>app-specific password</strong> — the normal account password is rejected
          over IMAP/SMTP.
        </li>
        <li>Look up the provider's IMAP and SMTP host and port (common ones below).</li>
        <li>
          The username is usually the full email address; the password is the
          app-specific one from step 2.
        </li>
      </ol>

      <Tabs
        tabs={[
          {
            id: 'gmail',
            label: 'Gmail',
            content: (
              <ul style={proseUl}>
                <li>
                  IMAP <code>imap.gmail.com:993</code>, SMTP{' '}
                  <code>smtp.gmail.com:465</code>.
                </li>
                <li>
                  App password at{' '}
                  <a href="https://myaccount.google.com/apppasswords">
                    myaccount.google.com/apppasswords
                  </a>
                  .
                </li>
              </ul>
            ),
          },
          {
            id: 'icloud',
            label: 'iCloud',
            content: (
              <ul style={proseUl}>
                <li>
                  IMAP <code>imap.mail.me.com:993</code>, SMTP{' '}
                  <code>smtp.mail.me.com:587</code>.
                </li>
                <li>
                  App password at <a href="https://account.apple.com">account.apple.com</a>{' '}
                  → Sign-In and Security.
                </li>
              </ul>
            ),
          },
          {
            id: 'outlook',
            label: 'Outlook / 365',
            content: (
              <ul style={proseUl}>
                <li>
                  IMAP <code>outlook.office365.com:993</code>, SMTP{' '}
                  <code>smtp.office365.com:587</code>.
                </li>
              </ul>
            ),
          },
          {
            id: 'fastmail',
            label: 'Fastmail',
            content: (
              <ul style={proseUl}>
                <li>
                  IMAP <code>imap.fastmail.com:993</code>, SMTP{' '}
                  <code>smtp.fastmail.com:465</code>.
                </li>
                <li>App password under Settings → Privacy &amp; Security.</li>
              </ul>
            ),
          },
        ]}
      />

      <H2>Route configuration</H2>
      <p style={proseP}>
        Each entry binds one mailbox to one agent. The <code>imap</code> and{' '}
        <code>smtp</code> connection details are nested objects. To run multiple agents,
        give each its own mailbox and add one entry each.
      </p>

      <FileSpec name="routes.json" meta="json · email slice">
        <Code lang="json" noHead>{`{
  "email": [
    {
      "address": "assistant",
      "email": "myagent@gmail.com",
      "whitelist": ["you@example.com", "*@yourteam.com"],
      "requireAuth": true,
      "imap": {
        "host": "imap.gmail.com",
        "port": 993,
        "user": "myagent@gmail.com",
        "pass": "app-specific-password",
        "tls": true
      },
      "smtp": {
        "host": "smtp.gmail.com",
        "port": 465,
        "user": "myagent@gmail.com",
        "pass": "app-specific-password",
        "secure": true
      }
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
            effect: 'Canonical agent address this mailbox routes to.',
          },
          {
            name: 'email',
            type: 'string',
            required: true,
            effect: "The agent's own address. Used as the From on replies and to drop its own outbound mail seen on IMAP.",
          },
          {
            name: 'channel',
            type: 'string',
            effect: "Channel preset for conversations. Falls back to the agent's default.",
          },
          {
            name: 'whitelist',
            type: 'string[]',
            effect: (
              <>
                Sender allowlist. Supports exact addresses and{' '}
                <code>*@domain.com</code> wildcards. Omitted means any sender; pair with{' '}
                <code>requireAuth</code> when restricting.
              </>
            ),
          },
          {
            name: 'requireAuth',
            type: 'boolean',
            default: 'false',
            effect: (
              <>
                Drop inbound mail unless DKIM/DMARC alignment with the From-domain holds.
                Set <code>true</code> whenever <code>whitelist</code> is used — the
                From-header is otherwise spoofable.
              </>
            ),
          },
          {
            name: 'imap.host',
            type: 'string',
            required: true,
            effect: 'IMAP server hostname for reading inbound mail.',
          },
          {
            name: 'imap.port',
            type: 'number',
            default: '993',
            effect: 'IMAP port.',
          },
          {
            name: 'imap.user',
            type: 'string',
            required: true,
            effect: 'IMAP username, usually the full email address.',
          },
          {
            name: 'imap.pass',
            type: 'string',
            required: true,
            effect: 'IMAP password. Masked in the admin form; stored in routes.json.',
          },
          {
            name: 'imap.tls',
            type: 'boolean',
            default: 'true',
            effect: 'Use implicit TLS for the IMAP connection.',
          },
          {
            name: 'smtp.host',
            type: 'string',
            required: true,
            effect: 'SMTP server hostname for sending replies.',
          },
          {
            name: 'smtp.port',
            type: 'number',
            default: '465',
            effect: 'SMTP port.',
          },
          {
            name: 'smtp.user',
            type: 'string',
            required: true,
            effect: 'SMTP username, usually the full email address.',
          },
          {
            name: 'smtp.pass',
            type: 'string',
            required: true,
            effect: 'SMTP password. Masked in the admin form; stored in routes.json.',
          },
          {
            name: 'smtp.secure',
            type: 'boolean',
            default: 'true',
            effect: 'Use implicit TLS for the SMTP connection.',
          },
        ]}
      />

      <H2>What works in chat</H2>
      <ul style={proseUl}>
        <li>
          <strong>Threaded replies</strong> — a new message's subject is folded into the
          first turn for context, and the agent's reply ships with{' '}
          <code>In-Reply-To</code> and <code>References</code> set to the original
          Message-ID, so the exchange stays a single thread in the sender's client. The
          reply subject reuses the original with a single <code>Re:</code> prefix.
        </li>
        <li>
          <strong>Approvals over email</strong> — a sensitive action arrives as an{' '}
          <code>[Approval]</code> email; reply with "approve" or "reject" (optionally
          followed by a reason) and Cast records the decision. The reply's From must match
          the address the request was sent to, so a forwarded Message-ID can't be used to
          approve on someone else's behalf.
        </li>
        <li>
          <strong>Attachments</strong> — inbound files reach the agent (those over the
          size limit are skipped), and outbound files are attached to the reply. Bodies
          prefer <code>text/plain</code>, falling back to stripped HTML.
        </li>
        <li>
          <strong>Sealed responses</strong> — each turn arrives as one complete email once
          the agent finishes, which fits the async rhythm of mail. (The live edit-in-place
          streaming of the chat transports simply folds into a single sent message here.)
        </li>
        <li>
          <strong>Commands</strong> — a message whose body starts with <code>/</code> is
          passed through verbatim, so system commands work over email.
        </li>
      </ul>

      <H2>Notes &amp; gotchas</H2>
      <Callout kind="warn">
        Use a <strong>dedicated mailbox</strong> with an <strong>app-specific
        password</strong> — providers with 2FA reject the normal password over IMAP/SMTP,
        and the credentials live on disk in <code>routes.json</code>.
      </Callout>
      <Callout kind="security">
        When you set a <code>whitelist</code>, also set <code>requireAuth: true</code>.
        Without it, the allowlist trusts the visible From-header, which a sender can forge;
        DKIM/DMARC alignment is what actually pins the sending domain.
      </Callout>
      <H3>How inbound delivery works</H3>
      <p style={proseP}>
        Each route holds one persistent IMAP IDLE connection that wakes on new mail, with
        a UID watermark so only messages newer than the last seen one are processed — on
        first run the watermark seeds to the current inbox so old mail is ignored. The
        connection reconnects with backoff and catches up from the watermark, and threading
        state lives in a transport-owned <code>transport-email.db</code>. Credentials sit
        in <code>routes.json</code>; see{' '}
        <DocsLink href="/docs/transports">Transports</DocsLink> for the config model shared
        across all transports.
      </p>
    </DocsLayout>
  );
}
