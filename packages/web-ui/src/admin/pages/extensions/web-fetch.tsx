/**
 * Web-fetch extension admin page — domain policy, config only (no secrets).
 */
import { trpc } from '../../trpc';
import type { PageManualEntry } from '@getcast/admin-schema/v1';

export const pageManual: PageManualEntry = {
  purpose: 'Web-fetch extension config for this agent — fetch mode (allow/deny), domain lists. No secrets.',
  actions: [
    'Switch fetch mode between allow-list and deny-list',
    'Edit allowed/denied domains',
  ],
};
import { SectionHeading, SelectInput, ListInput, ToggleInput } from '../../components/inputs';
import { FormStatus, SubmitButton } from '../../components/form';
import { QueryView } from '../../components/query-view';
import { useAdminForm } from '../../hooks/use-admin-form';
import {
  WebFetchFormSchema,
  webFetchFormInitialValues,
  webFetchFormToPayload,
  type WebFetchServerData,
} from '../../schemas/web-fetch';

export function WebFetchExtensionPage({ alias }: { alias: string }) {
  const configQuery = trpc.extension.webFetch.getConfig.useQuery({ alias });
  return (
    <QueryView query={configQuery}>
      {(data) => <WebFetchForm alias={alias} data={data} />}
    </QueryView>
  );
}

function WebFetchForm({ alias, data }: { alias: string; data: WebFetchServerData }) {
  const utils = trpc.useUtils();
  const { form, message, formProps, submitProps } = useAdminForm({
    schema: WebFetchFormSchema,
    values: webFetchFormInitialValues(data),
    mutation: trpc.extension.webFetch.setConfig,
    toPayload: (v) => webFetchFormToPayload(alias, v, data),
    onSaved: () => utils.extension.webFetch.getConfig.invalidate({ alias }),
  });

  const c = data.config;

  return (
    <form {...formProps} class="space-y-6 max-w-lg">
      <section class="space-y-3">
        <SectionHeading>Fetch Mode</SectionHeading>
        <SelectInput
          label="Fetch Mode"
          value={form.watch('fetchMode')}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'approval', label: 'Approval' },
            { value: 'disabled', label: 'Disabled' },
          ]}
          onChange={(v) => form.setValue('fetchMode', v as 'open' | 'approval' | 'disabled', { shouldDirty: true })}
          locked={c.fetch_mode?.locked}
          helpText="Open: any domain fetches without prompting. Approval: listed domains skip, others require human approval. Disabled: no fetching."
        />
      </section>

      <section class="space-y-3">
        <SectionHeading>Domain Policy</SectionHeading>
        <ListInput
          label="Allowed Domains (bypass approval)"
          values={form.watch('allowedDomains')}
          onChange={(v) => form.setValue('allowedDomains', v, { shouldDirty: true })}
          locked={c.allowed_domains?.locked}
          placeholder="*.example.com"
          helpText="Domains that fetch without prompting. Only consulted in Approval mode. Wildcards: *.example.com."
        />
        <ListInput
          label="Blocked Domains"
          values={form.watch('blockedDomains')}
          onChange={(v) => form.setValue('blockedDomains', v, { shouldDirty: true })}
          locked={c.blocked_domains?.locked}
          placeholder="risky-site.com"
          helpText="Always-rejected domains. Checked in every mode."
        />
        <ToggleInput
          label="Allow Query Strings"
          value={form.watch('allowQueryStrings')}
          onChange={(v) => form.setValue('allowQueryStrings', v, { shouldDirty: true })}
          locked={c.allow_query_strings?.locked}
          helpText="Whether URLs keep their query strings. Off = strips ?... and #... from fetched URLs."
        />
      </section>

      <FormStatus message={message} />
      <SubmitButton submitProps={submitProps}>Save</SubmitButton>
    </form>
  );
}
