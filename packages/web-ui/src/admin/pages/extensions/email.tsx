/**
 * Email extension admin page — IMAP/SMTP credentials + inbound/outbound policy.
 */
import { useState } from 'preact/hooks';
import { EmailAdminState } from '@getcast/ext-email/schemas';
import type { PageManualEntry } from '@getcast/admin-schema/v1';

export const pageManual: PageManualEntry = {
  purpose: 'Email extension config for this agent — IMAP/SMTP credentials, inbound scope + read policy, outbound recipients + send policy. Secret writes (EMAIL_PASSWORD, IMAP/SMTP hosts) happen through this form, not chat.',
  actions: [
    'Fill EMAIL_ADDRESS / EMAIL_PASSWORD / IMAP & SMTP host+port (secret write)',
    'Test IMAP/SMTP connection',
    'Set inbound scope (senders, folders, blocked) and read default',
    'Set outbound recipients/blocked and send default',
  ],
};

import { trpc } from '../../trpc';
import {
  SectionHeading,
  TextInput,
  NumberInput,
  SecretInput,
  SelectInput,
  ListInput,
  TestConnectionButton,
} from '../../components/inputs';
import { FormStatus, SubmitButton } from '../../components/form';
import { QueryView } from '../../components/query-view';
import { useAdminForm } from '../../hooks/use-admin-form';
import {
  EmailFormSchema,
  emailFormInitialValues,
  emailFormToPayload,
  type EmailServerData,
} from '../../schemas/email';

type FolderInfo = { path: string; name: string };

const MODE_OPTIONS = [
  { value: 'disabled', label: 'Disabled' },
  { value: 'approval', label: 'Approval' },
  { value: 'enabled', label: 'Enabled' },
];

// Account + Server form fields — the slice the credentials Save button persists
// independently of the inbound/outbound policy sections.
const CREDENTIAL_FIELDS = [
  'emailAddress',
  'emailPassword',
  'imapHost',
  'imapPort',
  'smtpHost',
  'smtpPort',
] as const;

export function EmailExtensionPage({ alias }: { alias: string }) {
  const configQuery = trpc.extension.email.getConfig.useQuery({ alias });
  return (
    <QueryView query={configQuery}>
      {(data) => <EmailForm alias={alias} data={data} />}
    </QueryView>
  );
}

function EmailForm({ alias, data }: { alias: string; data: EmailServerData }) {
  const utils = trpc.useUtils();
  const [discoveredFolders, setDiscoveredFolders] = useState<FolderInfo[]>([]);
  const connectMut = trpc.extension.shared.connect.useMutation();
  const credsMut = trpc.extension.email.setConfig.useMutation();

  const { form, message, formProps, submitProps } = useAdminForm({
    schema: EmailFormSchema,
    values: emailFormInitialValues(data),
    mutation: trpc.extension.email.setConfig,
    toPayload: (v) => emailFormToPayload(alias, v, data),
    onSaved: () => utils.extension.email.getConfig.invalidate({ alias }),
  });

  const { secrets, config } = data;
  const inboundLocked = config.inbound?.locked ?? false;
  const outboundLocked = config.outbound?.locked ?? false;

  // Reading dirtyFields subscribes to it; the page already re-renders on every
  // form.watch, so this stays current. Drives the credentials Save button.
  const dirtyFields = form.formState.dirtyFields;
  const credentialsDirty = CREDENTIAL_FIELDS.some((f) => dirtyFields[f]);

  const handleConnect = async () => {
    // Test against the live form, not just saved secrets. emailFormToPayload
    // already yields the non-empty secret set (blank password = keep existing).
    const { secrets: secretOverrides } = emailFormToPayload(alias, form.getValues(), data);
    const result = await connectMut.mutateAsync({ alias, extension: 'email', secretOverrides });
    if (result.ok && result.state) {
      try {
        const state = EmailAdminState.parse(result.state);
        setDiscoveredFolders(state.folders);
      } catch {
        /* empty state */
      }
    }
  };

  // Save the Account + Server secrets only — the same secret payload the full
  // Save sends, minus the inbound/outbound config (blank = keep existing). On
  // success, rebaseline the form (clears isDirty so the button settles) the same
  // way the full Save does, then refetch to pull the masked secrets back in.
  const handleSaveCredentials = () => {
    const { secrets: secretUpdates } = emailFormToPayload(alias, form.getValues(), data);
    credsMut.mutate(
      { alias, secrets: secretUpdates },
      {
        onSuccess: () => {
          form.reset(form.getValues());
          void utils.extension.email.getConfig.invalidate({ alias });
        },
      },
    );
  };

  // Editing any credential invalidates the last connection test — drop its
  // result banner and the folders it discovered so neither lingers as stale.
  // Guarded so steady-state typing after the clear is a no-op.
  const setCredential = (field: (typeof CREDENTIAL_FIELDS)[number], value: string) => {
    form.setValue(field, value, { shouldDirty: true });
    if (connectMut.data) connectMut.reset();
    if (discoveredFolders.length > 0) setDiscoveredFolders([]);
  };

  const addFolderToInbound = (path: string) => {
    const current = form.watch('inboundFolders');
    if (!current.includes(path)) {
      form.setValue('inboundFolders', [...current, path], { shouldDirty: true });
    }
  };

  return (
    <form {...formProps} class="space-y-6 max-w-lg">
      <section class="space-y-3">
        <SectionHeading>Account</SectionHeading>
        <TextInput
          label="Email Address"
          value={form.watch('emailAddress')}
          onInput={(v) => setCredential('emailAddress', v)}
          placeholder={secrets.EMAIL_ADDRESS?.set ? secrets.EMAIL_ADDRESS.value : ''}
          helpText="Email address used for sending and IMAP login"
        />
        <SecretInput
          label="Email Password"
          value={form.watch('emailPassword')}
          onInput={(v) => setCredential('emailPassword', v)}
          isSet={secrets.EMAIL_PASSWORD?.set ?? false}
          helpText="App password (Gmail: requires 2FA, generate at myaccount.google.com/apppasswords)"
        />
      </section>

      <section class="space-y-3">
        <SectionHeading>Server</SectionHeading>
        <div class="grid grid-cols-2 gap-3">
          <TextInput
            label="IMAP Host"
            value={form.watch('imapHost')}
            onInput={(v) => setCredential('imapHost', v)}
            placeholder={secrets.IMAP_HOST?.set ? secrets.IMAP_HOST.value : 'imap.gmail.com'}
            helpText="IMAP server hostname"
          />
          <NumberInput
            label="IMAP Port"
            value={form.watch('imapPort')}
            onInput={(v) => setCredential('imapPort', v)}
            placeholder={secrets.IMAP_PORT?.set ? secrets.IMAP_PORT.value : '993'}
            helpText="Typically 993 (SSL)"
          />
        </div>
        <div class="grid grid-cols-2 gap-3">
          <TextInput
            label="SMTP Host"
            value={form.watch('smtpHost')}
            onInput={(v) => setCredential('smtpHost', v)}
            placeholder={secrets.SMTP_HOST?.set ? secrets.SMTP_HOST.value : 'smtp.gmail.com'}
            helpText="SMTP server hostname"
          />
          <NumberInput
            label="SMTP Port"
            value={form.watch('smtpPort')}
            onInput={(v) => setCredential('smtpPort', v)}
            placeholder={secrets.SMTP_PORT?.set ? secrets.SMTP_PORT.value : '465'}
            helpText="Typically 465 (SSL) or 587 (STARTTLS)"
          />
        </div>
      </section>

      <div class="space-y-2">
        <div class="flex items-start gap-2">
          <TestConnectionButton
            onClick={handleConnect}
            pending={connectMut.isPending}
            result={connectMut.data ? { ok: connectMut.data.ok, message: connectMut.data.message } : null}
          />
          <button
            type="button"
            onClick={handleSaveCredentials}
            disabled={!credentialsDirty || credsMut.isPending}
            class="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded font-medium transition-colors"
          >
            {credsMut.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
        {credsMut.error && <p class="text-sm text-red-400">{credsMut.error.message}</p>}
      </div>

      {discoveredFolders.length > 0 && (
        <section class="space-y-2">
          <SectionHeading>Discovered Folders</SectionHeading>
          <div class="text-xs text-gray-500 space-y-1">
            {discoveredFolders.map((f) => (
              <div key={f.path} class="flex gap-2 items-center">
                <button
                  type="button"
                  class="text-left hover:underline font-mono text-gray-300"
                  onClick={() => addFolderToInbound(f.path)}
                  disabled={inboundLocked}
                >
                  {f.path}
                </button>
                {f.name !== f.path && <span class="text-gray-600">{f.name}</span>}
              </div>
            ))}
          </div>
          <p class="text-xs text-gray-600">Click to add to Inbound Folders.</p>
        </section>
      )}

      <section class="space-y-3">
        <SectionHeading>Inbound</SectionHeading>
        <ListInput
          label="Folders"
          values={form.watch('inboundFolders')}
          onChange={(v) => form.setValue('inboundFolders', v, { shouldDirty: true })}
          locked={inboundLocked}
          placeholder="INBOX"
          helpText="Folder allowlist. Empty = all folders visible."
        />
        <ListInput
          label="Senders"
          values={form.watch('inboundSenders')}
          onChange={(v) => form.setValue('inboundSenders', v, { shouldDirty: true })}
          locked={inboundLocked}
          placeholder="alice@acme.com or @acme.com"
          helpText="Sender allowlist. Empty = all senders. Patterns: exact address or @domain."
        />
        <ListInput
          label="Blocked"
          values={form.watch('inboundBlocked')}
          onChange={(v) => form.setValue('inboundBlocked', v, { shouldDirty: true })}
          locked={inboundLocked}
          placeholder="noreply@acme.com or @marketing.acme.com"
          helpText="Sender denylist. Enforced at IMAP query — these senders are invisible."
        />
        <div class="grid grid-cols-2 gap-3">
          <NumberInput
            label="Window (days)"
            value={form.watch('inboundWindowDays')}
            onInput={(v) => form.setValue('inboundWindowDays', v, { shouldDirty: true })}
            locked={inboundLocked}
            helpText="How many days back search looks"
          />
          <NumberInput
            label="Max Results"
            value={form.watch('inboundMaxResults')}
            onInput={(v) => form.setValue('inboundMaxResults', v, { shouldDirty: true })}
            locked={inboundLocked}
            helpText="Cap on envelopes per search"
          />
        </div>
        <SelectInput
          label="Default"
          value={form.watch('inboundDefault')}
          options={MODE_OPTIONS}
          onChange={(v) => form.setValue('inboundDefault', v as 'disabled' | 'approval' | 'enabled', { shouldDirty: true })}
          locked={inboundLocked}
          helpText="Approval policy for search and subscribe (within scope)"
        />
        <ListInput
          label="Always Allow"
          values={form.watch('inboundAlwaysAllow')}
          onChange={(v) => form.setValue('inboundAlwaysAllow', v, { shouldDirty: true })}
          locked={inboundLocked}
          placeholder="boss@acme.com"
          helpText="These senders bypass approval regardless of default."
        />
      </section>

      <section class="space-y-3">
        <SectionHeading>Outbound</SectionHeading>
        <ListInput
          label="Recipients"
          values={form.watch('outboundRecipients')}
          onChange={(v) => form.setValue('outboundRecipients', v, { shouldDirty: true })}
          locked={outboundLocked}
          placeholder="user@example.com or @acme.com"
          helpText="Recipient allowlist. Empty = any recipient (dangerous under Enabled mode)."
        />
        <ListInput
          label="Blocked"
          values={form.watch('outboundBlocked')}
          onChange={(v) => form.setValue('outboundBlocked', v, { shouldDirty: true })}
          locked={outboundLocked}
          placeholder="ex@evil.com"
          helpText="Recipient denylist — never send to these."
        />
        <SelectInput
          label="Default"
          value={form.watch('outboundDefault')}
          options={MODE_OPTIONS}
          onChange={(v) => form.setValue('outboundDefault', v as 'disabled' | 'approval' | 'enabled', { shouldDirty: true })}
          locked={outboundLocked}
          helpText="Approval policy for sending"
        />
        <ListInput
          label="Always Allow"
          values={form.watch('outboundAlwaysAllow')}
          onChange={(v) => form.setValue('outboundAlwaysAllow', v, { shouldDirty: true })}
          locked={outboundLocked}
          placeholder="boss@acme.com"
          helpText="Auto-send to these recipients (bypass approval)."
        />
      </section>

      <FormStatus message={message} />
      <SubmitButton submitProps={submitProps}>Save</SubmitButton>
    </form>
  );
}
