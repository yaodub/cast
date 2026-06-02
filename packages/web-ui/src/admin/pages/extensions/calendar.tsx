/**
 * Calendar extension admin page — Google OAuth / CalDAV credentials,
 * calendar discovery, write policy.
 */
import { useState, useEffect } from 'preact/hooks';
import { CalendarAdminState } from '@getcast/ext-calendar/schemas';
import type { PageManualEntry } from '@getcast/admin-schema/v1';

export const pageManual: PageManualEntry = {
  purpose: 'Calendar extension config for this agent — Google OAuth or CalDAV credentials, calendar selection, read/write policy.',
  actions: [
    'Start Google OAuth or paste CalDAV credentials (secret write)',
    'Discover and select which calendars this agent can see',
    'Change write policy (read-only vs allow event creation)',
  ],
};

import { trpc, API_BASE } from '../../trpc';
import {
  SectionHeading,
  TextInput,
  SecretInput,
  SelectInput,
  StatusMessage,
  TestConnectionButton,
} from '../../components/inputs';
import { FormStatus, SubmitButton } from '../../components/form';
import { QueryView } from '../../components/query-view';
import { useAdminForm } from '../../hooks/use-admin-form';
import {
  CalendarFormSchema,
  calendarFormInitialValues,
  calendarFormToPayload,
  type CalendarServerData,
  type CalendarFormValues,
} from '../../schemas/calendar';

export function CalendarExtensionPage({ alias }: { alias: string }) {
  const configQuery = trpc.extension.calendar.getConfig.useQuery({ alias });
  return (
    <QueryView query={configQuery}>
      {(data) => <CalendarForm alias={alias} data={data} />}
    </QueryView>
  );
}

function CalendarForm({ alias, data }: { alias: string; data: CalendarServerData }) {
  const utils = trpc.useUtils();
  const connectMut = trpc.extension.shared.connect.useMutation();
  const discoverCals = trpc.extension.calendar.discoverCalendars.useMutation();
  const [discoveredCalendars, setDiscoveredCalendars] = useState<Array<{ id: string; name: string; primary: boolean }>>([]);

  const { form, message, formProps, submitProps } = useAdminForm({
    schema: CalendarFormSchema,
    values: calendarFormInitialValues(data),
    mutation: trpc.extension.calendar.setConfig,
    toPayload: (v) => calendarFormToPayload(alias, v, data),
    onSaved: () => utils.extension.calendar.getConfig.invalidate({ alias }),
  });

  const provider = form.watch('provider');
  const calendars = form.watch('calendars');
  const { secrets, config } = data;

  useEffect(() => {
    if (discoverCals.data?.ok && discoverCals.data.calendars.length > 0) {
      setDiscoveredCalendars(discoverCals.data.calendars);
    }
  }, [discoverCals.data]);

  useEffect(() => {
    if (connectMut.data?.ok && connectMut.data.state) {
      try {
        const state = CalendarAdminState.parse(connectMut.data.state);
        if (state.calendars.length > 0) {
          setDiscoveredCalendars(
            state.calendars.map((c) => ({ id: c.id, name: c.name, primary: c.primary ?? false })),
          );
        }
      } catch {
        /* empty state */
      }
    }
  }, [connectMut.data]);

  // OAuth status from URL after redirect
  const urlParams = new URLSearchParams(window.location.search);
  const oauthStatus = urlParams.get('oauth');

  const handleOAuthStart = () => {
    window.location.href = `${API_BASE}/api/oauth/google-calendar/start?agent=${encodeURIComponent(alias)}`;
  };

  return (
    <form {...formProps} class="space-y-6 max-w-lg">
      {oauthStatus === 'success' && (
        <StatusMessage type="ok" text="Google OAuth completed successfully. Refresh token saved." />
      )}
      {oauthStatus === 'error' && (
        <StatusMessage type="error" text={`OAuth failed: ${urlParams.get('message') ?? 'unknown error'}`} />
      )}

      <section class="space-y-3">
        <SectionHeading>Provider</SectionHeading>
        <SelectInput
          label="Calendar Provider"
          value={provider}
          options={[
            { value: 'google', label: 'Google Calendar' },
            { value: 'caldav', label: 'CalDAV (iCloud, Fastmail, Nextcloud)' },
          ]}
          onChange={(v) => form.setValue('provider', v as 'google' | 'caldav', { shouldDirty: true })}
        />
      </section>

      {provider === 'google' && (
        <section class="space-y-3">
          <SectionHeading>Google Credentials</SectionHeading>
          <TextInput
            label="Client ID"
            value={form.watch('googleClientId')}
            onInput={(v) => form.setValue('googleClientId', v, { shouldDirty: true })}
            placeholder={secrets['GOOGLE_CLIENT_ID']?.set ? secrets['GOOGLE_CLIENT_ID']!.value : ''}
            helpText="OAuth client ID from Google Cloud Console"
          />
          <SecretInput
            label="Client Secret"
            value={form.watch('googleClientSecret')}
            onInput={(v) => form.setValue('googleClientSecret', v, { shouldDirty: true })}
            isSet={secrets['GOOGLE_CLIENT_SECRET']?.set ?? false}
            helpText="OAuth client secret"
          />
          <TextInput
            label="Google Email"
            value={form.watch('googleEmail')}
            onInput={(v) => form.setValue('googleEmail', v, { shouldDirty: true })}
            placeholder={secrets['GOOGLE_EMAIL']?.set ? secrets['GOOGLE_EMAIL']!.value : 'Auto-filled by OAuth'}
            helpText="Google account email (auto-filled after OAuth)"
          />
          <div class="space-y-2">
            <button type="button" onClick={handleOAuthStart}
              class="px-4 py-2 bg-blue-700 hover:bg-blue-600 text-white text-sm rounded font-medium">
              Authorize with Google
            </button>
            {secrets['GOOGLE_REFRESH_TOKEN']?.set && (
              <p class="text-green-500 text-xs">Refresh token is set</p>
            )}
            <details class="border border-gray-800 rounded">
              <summary class="px-3 py-2 text-sm text-gray-400 hover:text-gray-200 cursor-pointer">
                Google Cloud setup instructions
              </summary>
              <div class="px-3 pb-3 text-xs text-gray-500 space-y-2 border-t border-gray-800 pt-2">
                <p class="font-medium text-gray-400">Prerequisites</p>
                <ol class="list-decimal list-inside space-y-1">
                  <li>A Google Cloud project —{' '}
                    <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener" class="underline text-blue-400">create one here</a>
                  </li>
                  <li>Enable the <strong>Google Calendar API</strong> in{' '}
                    <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noopener" class="underline text-blue-400">APIs &amp; Services &gt; Library</a>
                  </li>
                </ol>
                <p class="font-medium text-gray-400 mt-3">Create OAuth credentials</p>
                <ol class="list-decimal list-inside space-y-1">
                  <li>Go to{' '}
                    <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener" class="underline text-blue-400">APIs &amp; Services &gt; Credentials</a>
                  </li>
                  <li>Click <strong>Create Credentials &gt; OAuth client ID</strong></li>
                  <li>Application type: <strong>Web application</strong></li>
                  <li>Under <strong>Authorized redirect URIs</strong>, add:
                    <code class="block mt-1 mb-1 bg-gray-950 px-2 py-1 rounded select-all break-all">
                      {data.oauthRedirectUri ?? ''}
                    </code>
                  </li>
                  <li>Copy the <strong>Client ID</strong> and <strong>Client Secret</strong> into the fields above</li>
                  <li>Click <strong>Save</strong>, then <strong>Authorize with Google</strong></li>
                </ol>
                <p class="font-medium text-gray-400 mt-3">Required scope</p>
                <code>https://www.googleapis.com/auth/calendar</code>
                <p class="font-medium text-gray-400 mt-3">Testing vs Production</p>
                <p class="text-gray-500">
                  While the OAuth consent screen is in <strong>Testing</strong>, refresh
                  tokens expire after 7 days — you'll need to re-authorize weekly. Two options:
                </p>
                <ul class="list-disc list-inside space-y-1">
                  <li>Add the Google account under <strong>OAuth consent screen &gt; Audience &gt; Test users</strong> (still 7-day expiry).</li>
                  <li>Click <strong>Publish app</strong> on the <strong>Audience</strong> tab to switch to Production — no re-auth required. Capped at <strong>100 users</strong> before Google requires app verification, which is fine for personal/single-user setups.</li>
                </ul>
                <p class="text-gray-600">
                  Calendar is a "sensitive" scope, which is why the 100-user cap applies.
                </p>
              </div>
            </details>
          </div>
        </section>
      )}

      {provider === 'caldav' && (
        <section class="space-y-3">
          <SectionHeading>CalDAV Credentials</SectionHeading>
          <SelectInput
            label="Server Preset"
            value=""
            options={[
              { value: '', label: 'Custom URL' },
              { value: 'https://caldav.icloud.com', label: 'Apple iCloud' },
              { value: 'https://caldav.fastmail.com/dav/calendars', label: 'Fastmail' },
            ]}
            onChange={(v) => { if (v) form.setValue('caldavUrl', v, { shouldDirty: true }); }}
            helpText="Choose a preset or enter a custom URL below"
          />
          <TextInput
            label="CalDAV URL"
            value={form.watch('caldavUrl')}
            onInput={(v) => form.setValue('caldavUrl', v, { shouldDirty: true })}
            placeholder={secrets['CALDAV_URL']?.set ? secrets['CALDAV_URL']!.value : 'https://caldav.example.com'}
            helpText="CalDAV server URL"
          />
          <TextInput
            label="Username"
            value={form.watch('caldavUsername')}
            onInput={(v) => form.setValue('caldavUsername', v, { shouldDirty: true })}
            placeholder={secrets['CALDAV_USERNAME']?.set ? secrets['CALDAV_USERNAME']!.value : ''}
            helpText="Account username or email"
          />
          <SecretInput
            label="Password"
            value={form.watch('caldavPassword')}
            onInput={(v) => form.setValue('caldavPassword', v, { shouldDirty: true })}
            isSet={secrets['CALDAV_PASSWORD']?.set ?? false}
            helpText="Account or app-specific password"
          />
        </section>
      )}

      <div class="flex gap-3 items-start">
        <TestConnectionButton
          onClick={() => connectMut.mutate({ alias, extension: 'calendar' })}
          pending={connectMut.isPending}
          result={connectMut.data ? { ok: connectMut.data.ok, message: connectMut.data.message } : null}
        />
        {provider === 'google' && (
          <div class="space-y-2">
            <button type="button"
              onClick={() => discoverCals.mutate({ alias })}
              disabled={discoverCals.isPending}
              class="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 text-sm rounded font-medium">
              {discoverCals.isPending ? 'Discovering...' : 'Discover Calendars'}
            </button>
            {discoverCals.data && !discoverCals.data.ok && (
              <StatusMessage type="error" text={discoverCals.data.message} />
            )}
          </div>
        )}
      </div>

      {discoveredCalendars.length > 0 ? (
        <section class="space-y-2">
          <SelectInput
            label="Calendar"
            value={calendars[0] ?? ''}
            options={[
              { value: '', label: '(none)' },
              ...discoveredCalendars.map((cal) => ({
                value: provider === 'google' ? cal.id : cal.name,
                label: cal.primary ? `${cal.name} (primary)` : cal.name,
              })),
            ]}
            onChange={(v) => form.setValue('calendars', v ? [v] : [], { shouldDirty: true })}
            locked={config.calendars?.locked}
            helpText="The calendar the agent can access and write to"
          />
        </section>
      ) : calendars.length > 0 && (
        <section class="space-y-2">
          <TextInput
            label="Calendar"
            value={calendars[0] ?? ''}
            onInput={(v) => form.setValue('calendars', v ? [v] : [], { shouldDirty: true })}
            locked={config.calendars?.locked}
            helpText="Click Discover Calendars to see all available calendars"
          />
        </section>
      )}

      <section class="space-y-3">
        <SectionHeading>Policy</SectionHeading>
        <SelectInput
          label="Write Mode"
          value={form.watch('writeMode')}
          options={[
            { value: 'disabled', label: 'Disabled (read-only)' },
            { value: 'approval', label: 'Approval (every write prompts)' },
            { value: 'personal', label: 'Personal (attendee writes prompt)' },
            { value: 'full', label: 'Full (no prompts)' },
          ]}
          onChange={(v) => form.setValue('writeMode', v as 'disabled' | 'approval' | 'personal' | 'full', { shouldDirty: true })}
          locked={config.write_mode?.locked}
          helpText="Ladder. Disabled: read-only. Approval: every create/update/delete prompts. Personal: personal writes skip, attendee writes prompt (invitations send real emails). Full: all writes skip."
        />
      </section>

      <section class="space-y-3">
        <SectionHeading>View Window</SectionHeading>
        <TextInput
          label="View Past"
          value={form.watch('viewPast')}
          onInput={(v) => form.setValue('viewPast', v, { shouldDirty: true })}
          locked={config.view_past?.locked}
          placeholder="30d"
          helpText="How far back the agent can query (e.g. 30d, 4w, 3m)"
        />
        <TextInput
          label="View Future"
          value={form.watch('viewFuture')}
          onInput={(v) => form.setValue('viewFuture', v, { shouldDirty: true })}
          locked={config.view_future?.locked}
          placeholder="365d"
          helpText="How far forward the agent can query"
        />
      </section>

      <FormStatus message={message} />
      <SubmitButton submitProps={submitProps}>Save</SubmitButton>
    </form>
  );
}
