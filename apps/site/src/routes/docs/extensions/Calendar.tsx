import {
  DocsLayout,
  H2,
  proseP,
  proseUl,
  proseTable,
  proseTh,
  proseTd,
  monoTd,
} from '../../../components/docs/DocsLayout';
import { Callout } from '../../../components/ui/Callout';
import { Code } from '../../../components/ui/Code';
import { FileSpec } from '../../../components/docs/FileSpec';
import { FieldTable } from '../../../components/docs/FieldTable';
import { Tabs } from '../../../components/docs/Tabs';
import { ToolDoc } from '../../../components/docs/ToolDoc';

export function ExtensionsCalendar() {
  return (
    <DocsLayout
      url="/docs/extensions/calendar"
      crumbs={['docs', 'plugins', 'extensions', 'calendar']}
      title="calendar"
      lede="CalDAV calendar access as a capability — list and inspect events, create, update, or delete them through an approval ladder, with an append-only audit trail. Works with Google, iCloud, Fastmail, and Nextcloud."
      toc={[
        { label: 'What the agent can do' },
        { label: 'Connecting a calendar' },
        { label: 'Configuration' },
        { label: 'Tools' },
        { label: 'Notes & gotchas' },
      ]}
    >
      <H2>What the agent can do</H2>
      <ul style={proseUl}>
        <li>
          <strong>Read</strong> — list events in a time range, and fetch one by id.
        </li>
        <li>
          <strong>Write</strong> — create, update, and delete events, gated by{' '}
          <code>write_mode</code>.
        </li>
        <li>
          <strong>Audit</strong> — every write is appended to a changelog the agent can
          review, with before/after snapshots.
        </li>
      </ul>

      <H2>Connecting a calendar</H2>
      <p style={proseP}>
        Two paths, depending on the provider. Google uses OAuth; everything else uses CalDAV
        with an app-specific password.
      </p>
      <Tabs
        tabs={[
          {
            id: 'google',
            label: 'Google (OAuth)',
            content: (
              <>
                <ol style={proseUl}>
                  <li>Create a Google Cloud project with the Calendar API enabled.</li>
                  <li>
                    Create an OAuth 2.0 Web-application client; register the redirect URI the
                    admin shows you.
                  </li>
                  <li>Paste the Client ID and Secret into the admin, then run the consent flow.</li>
                  <li>
                    The flow writes the refresh token and account email into{' '}
                    <code>secrets.json</code> for you.
                  </li>
                </ol>
                <FileSpec name="secrets.json" meta="json · config/ext/calendar/">
                  <Code lang="json" noHead>{`{
  "PROVIDER": "google",
  "GOOGLE_CLIENT_ID": "...",
  "GOOGLE_CLIENT_SECRET": "...",
  "GOOGLE_REFRESH_TOKEN": "...",
  "GOOGLE_EMAIL": "you@gmail.com"
}`}</Code>
                </FileSpec>
                <Callout kind="warn">
                  Publish the OAuth consent screen. While it's in Testing mode Google expires
                  the refresh token after 7 days.
                </Callout>
              </>
            ),
          },
          {
            id: 'caldav',
            label: 'CalDAV',
            content: (
              <>
                <p style={proseP}>
                  For iCloud, Fastmail, or Nextcloud: the server URL, your username, and an
                  app-specific password.
                </p>
                <FileSpec name="secrets.json" meta="json · config/ext/calendar/">
                  <Code lang="json" noHead>{`{
  "PROVIDER": "caldav",
  "CALDAV_URL": "https://caldav.icloud.com",
  "CALDAV_USERNAME": "you@icloud.com",
  "CALDAV_PASSWORD": "app-specific-password"
}`}</Code>
                </FileSpec>
              </>
            ),
          },
        ]}
      />

      <H2>Configuration</H2>
      <FileSpec name="capabilities.json" meta="json · extensions.calendar slice">
        <Code lang="json" noHead>{`{
  "extensions": {
    "calendar": {
      "enabled": true,
      "write_mode": "approval",
      "calendars": ["Work"]
    }
  }
}`}</Code>
      </FileSpec>
      <FieldTable
        fields={[
          {
            name: 'write_mode',
            type: 'disabled | approval | personal | full',
            default: 'disabled',
            effect: 'Approval ladder for create / update / delete. Reads never prompt.',
          },
          {
            name: 'calendars',
            type: 'string[]',
            default: '[]',
            effect: 'Calendar display names to operate on, resolved over CalDAV.',
          },
          {
            name: 'calendar_urls',
            type: 'string[]',
            default: '[]',
            effect: 'Pre-resolved CalDAV URLs — required for Google, and takes priority over names.',
          },
        ]}
      />
      <p style={proseP}>
        The read window is set by <code>view_past</code> (default <code>30d</code>) and{' '}
        <code>view_future</code> (default <code>365d</code>), as durations like{' '}
        <code>7d</code> or <code>3m</code>.
      </p>
      <p style={proseP}>The write ladder has four rungs:</p>
      <table style={proseTable}>
        <thead>
          <tr>
            <th style={proseTh}>Mode</th>
            <th style={proseTh}>Behavior</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style={monoTd}>disabled</td>
            <td style={proseTd}>Write tools aren't registered — read-only.</td>
          </tr>
          <tr>
            <td style={monoTd}>approval</td>
            <td style={proseTd}>Every write prompts for approval.</td>
          </tr>
          <tr>
            <td style={monoTd}>personal</td>
            <td style={proseTd}>
              Personal writes run without prompting; writes with attendees still prompt, since
              attendees trigger real invitations.
            </td>
          </tr>
          <tr>
            <td style={monoTd}>full</td>
            <td style={proseTd}>All writes run without prompting.</td>
          </tr>
        </tbody>
      </table>

      <H2>Tools</H2>

      <ToolDoc
        name="calendar__list"
        summary="List calendar events in a time range, sorted by start time."
        params={[
          { name: 'after', type: 'ISO date', desc: 'Only events after this timestamp.' },
          { name: 'before', type: 'ISO date', desc: 'Only events before this timestamp.' },
        ]}
        returns={[
          { value: 'UID: UID\nTitle: TITLE\nTime: START — END\nLocation: LOCATION\nDescription: DESCRIPTION\nAttendees: EMAIL, EMAIL, …\nRecurrence: RECURRENCE\nStatus: STATUS', when: 'one block per event, separated by blank lines' },
          { value: 'No events found.', when: 'empty range' },
          { value: 'Calendar error: ERROR', when: 'connection or config error' },
        ]}
      />

      <ToolDoc
        name="calendar__get"
        summary="Retrieve a single calendar event by UID with full details."
        params={[
          { name: 'uid', type: 'string', required: true, desc: 'Event UID.' },
        ]}
        returns={[
          { value: 'UID: UID\nTitle: TITLE\nTime: START — END\n…', when: 'event found (same format as calendar__list)' },
          { value: 'Event not found.', when: 'uid not matched' },
          { value: 'Calendar error: ERROR', when: 'connection error' },
        ]}
      />

      <ToolDoc
        name="calendar__changes"
        summary="List recent calendar changes (create, update, delete) from the audit log."
        params={[
          { name: 'limit', type: 'integer', default: '50', desc: 'Max entries to return.' },
        ]}
        returns={[
          { value: '[ISO_TIMESTAMP] CREATE — UID\n  After: TITLE (START)\n[ISO_TIMESTAMP] UPDATE — UID\n  Before: TITLE (START)\n  After: TITLE (START)', when: 'audit entries present' },
          { value: 'No changes recorded.', when: 'empty log' },
          { value: 'Calendar error: ERROR', when: 'file read error' },
        ]}
      />

      <ToolDoc
        name="calendar__create"
        summary="Create a calendar event. Approval/auto-execution depends on write_mode."
        params={[
          { name: 'title', type: 'string', required: true, desc: 'Event title.' },
          { name: 'start', type: 'ISO datetime or YYYY-MM-DD', required: true, desc: 'Start time. Use date-only for all-day events.' },
          { name: 'end', type: 'ISO datetime or YYYY-MM-DD', required: true, desc: 'End time. Use date-only for all-day events.' },
          { name: 'allDay', type: 'boolean', default: 'false', desc: 'Mark as an all-day event.' },
          { name: 'location', type: 'string', desc: 'Event location.' },
          { name: 'description', type: 'string', desc: 'Event description.' },
          { name: 'attendees', type: 'string[]', desc: 'Attendee email addresses. In personal mode, presence of attendees forces an approval prompt.' },
        ]}
        returns={[
          { value: 'Created: TITLE (START — END)\nUID: UID', when: 'success' },
          { value: 'Missing required arguments: title, start, end', when: 'incomplete input' },
          { value: 'Calendar error: ERROR', when: 'writes disabled, no calendar, or server error' },
        ]}
      />

      <ToolDoc
        name="calendar__update"
        summary="Update a calendar event by UID. Only specified fields are changed."
        params={[
          { name: 'uid', type: 'string', required: true, desc: 'Event UID.' },
          { name: 'title', type: 'string', desc: 'New title.' },
          { name: 'start', type: 'ISO datetime or YYYY-MM-DD', desc: 'New start.' },
          { name: 'end', type: 'ISO datetime or YYYY-MM-DD', desc: 'New end.' },
          { name: 'allDay', type: 'boolean', desc: 'Mark as all-day.' },
          { name: 'location', type: 'string', desc: 'New location.' },
          { name: 'description', type: 'string', desc: 'New description.' },
          { name: 'attendees', type: 'string[]', desc: 'Replaces the existing attendee list.' },
        ]}
        returns={[
          { value: 'Updated: TITLE (START — END)', when: 'success' },
          { value: 'Missing required argument: uid', when: 'uid absent' },
          { value: 'Calendar error: ERROR', when: 'event not found, writes disabled, or server error' },
        ]}
      />

      <ToolDoc
        name="calendar__delete"
        summary="Delete a calendar event by UID."
        params={[
          { name: 'uid', type: 'string', required: true, desc: 'Event UID.' },
        ]}
        returns={[
          { value: 'Deleted event: UID', when: 'success' },
          { value: 'Missing required argument: uid', when: 'uid absent' },
          { value: 'Calendar error: ERROR', when: 'event not found, writes disabled, or server error' },
        ]}
      />

      <H2>Notes &amp; gotchas</H2>
      <Callout kind="security">
        Start <code>write_mode</code> at <code>disabled</code> and step up to{' '}
        <code>approval</code> when the agent is actively scheduling. Reserve{' '}
        <code>personal</code> and <code>full</code> for when you mean it — <code>full</code>{' '}
        sends meeting invitations without asking.
      </Callout>
    </DocsLayout>
  );
}
