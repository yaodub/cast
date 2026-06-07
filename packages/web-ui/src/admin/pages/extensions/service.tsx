/**
 * Service admin page — declaration-driven settings + credentials form for the
 * agent's service (blueprint/service/manifest.json `config` and `secrets`
 * fields), plus a permalink to the service-rendered admin page when the
 * manifest declares `admin: true`.
 *
 * Generic by design: fields come from the manifest declaration, not from a
 * per-service component. Saving writes config/ext/service/{config,secrets}.json;
 * the server's watcher restarts the service so the new values take effect.
 * Anything richer than flat fields belongs on the service's own page.
 */
import { trpc, API_BASE } from '../../trpc';
import type { PageManualEntry } from '@getcast/admin-schema/v1';

export const pageManual: PageManualEntry = {
  purpose: 'Controls for this agent\'s service process: lifecycle status and a manual Restart at the top, then any settings and credentials declared in the service manifest. Values are stored server-side; sensitive fields show masked. Saving restarts the service so the new values take effect. Services that render their own admin page get an "Open service admin page" link here.',
  actions: [
    'See the service status (running / failed / stopped / etc.)',
    'Restart the service process (reloads code, or recovers a stopped or failed service)',
    'Edit declared service settings and secrets (blank secret fields leave the stored value unchanged)',
    'Save (the service restarts automatically)',
    'Open the service-rendered admin page (when the service declares one)',
  ],
};
import { z } from 'zod';

import { NumberInput, SecretInput, SectionHeading, TextInput, ToggleInput } from '../../components/inputs';
import { FormStatus, SubmitButton } from '../../components/form';
import { QueryView } from '../../components/query-view';
import { useAdminForm } from '../../hooks/use-admin-form';

interface ServiceSecretField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  value: string;
  set: boolean;
}

interface ServiceConfigField {
  key: string;
  label: string;
  type: 'string' | 'number' | 'boolean';
  value: string | number | boolean;
  set: boolean;
}

interface ServiceAdminData {
  present: boolean;
  status: string;
  declared: boolean;
  admin: boolean;
  secrets: ServiceSecretField[];
  config: ServiceConfigField[];
}

// Form values are namespaced (`cfg:` / `sec:`) — the two declarations are
// independent key spaces and may collide.
const ServiceFormSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

export function ServiceSecretsPage({ alias }: { alias: string }) {
  const configQuery = trpc.service.getConfig.useQuery({ alias });
  return (
    <QueryView query={configQuery}>
      {(data) => {
        if (!data.present && !data.declared) {
          return <p class="text-gray-500 text-sm">This agent has no service process.</p>;
        }
        return (
          <div class="space-y-6">
            <ServiceProcessSection alias={alias} status={data.status} />
            {data.declared ? (
              <ServiceForm alias={alias} data={data} />
            ) : (
              <p class="text-gray-500 text-sm">
                This service declares no settings, secrets, or admin page. Declare them in <code class="font-mono">blueprint/service/manifest.json</code> (<code class="font-mono">config</code> / <code class="font-mono">secrets</code> / <code class="font-mono">admin</code>) to manage them here.
              </p>
            )}
          </div>
        );
      }}
    </QueryView>
  );
}

/** Service lifecycle status, colored by existing accents only. */
function ServiceStatusBadge({ status }: { status: string }) {
  const tone =
    status === 'running' ? 'text-green-400'
      : status === 'failed' ? 'text-red-400'
        : status === 'idle' || status === 'stopped' ? 'text-gray-500'
          : 'text-gray-300';
  return <span class={`text-sm font-mono ${tone}`}>{status}</span>;
}

/** Service process controls — status + manual restart. Always shown when a
 *  service exists, regardless of whether it declares operator-facing config. */
function ServiceProcessSection({ alias, status }: { alias: string; status: string }) {
  const utils = trpc.useUtils();
  const restart = trpc.agent.restartService.useMutation({
    onSuccess: () => utils.service.getConfig.invalidate({ alias }),
  });
  return (
    <section class="space-y-3 max-w-lg">
      <SectionHeading>Service Process</SectionHeading>
      <div class="flex items-center gap-3">
        <ServiceStatusBadge status={status} />
        <button
          type="button"
          onClick={() => {
            if (confirm('Restart the agent service process?')) restart.mutate({ alias });
          }}
          disabled={restart.isPending}
          class="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 text-sm rounded"
        >
          {restart.isPending ? 'Restarting…' : 'Restart service'}
        </button>
      </div>
      {restart.error && <p class="text-red-400 text-sm">{restart.error.message}</p>}
      <p class="text-xs text-gray-600">
        Reloads the service process. Needed after a service code change, or to recover a stopped or failed service. Saving settings or credentials restarts it automatically.
      </p>
    </section>
  );
}

function ServiceAdminPageLink({ alias }: { alias: string }) {
  const urlMut = trpc.service.adminPageUrl.useMutation();
  return (
    <div>
      <button
        type="button"
        onClick={() => {
          urlMut.mutate({ alias }, {
            onSuccess: ({ url }) => window.open(`${API_BASE}${url}`, '_blank'),
          });
        }}
        disabled={urlMut.isPending}
        class="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 text-sm rounded"
      >
        {urlMut.isPending ? 'Opening…' : 'Open service admin page ↗'}
      </button>
      {urlMut.error && <p class="text-red-400 text-sm mt-1">{urlMut.error.message}</p>}
      <p class="text-xs text-gray-600 mt-1">
        The service renders this page itself. It is only reachable while the service is running.
      </p>
    </div>
  );
}

function ServiceForm({ alias, data }: { alias: string; data: ServiceAdminData }) {
  const utils = trpc.useUtils();
  const { form, message, formProps, submitProps } = useAdminForm({
    schema: ServiceFormSchema,
    values: {
      // Settings show their stored (or default) value for in-place editing;
      // secret fields start blank (blank means keep the stored value).
      ...Object.fromEntries(data.config.map((f) => [`cfg:${f.key}`, f.value])),
      ...Object.fromEntries(data.secrets.map((f) => [`sec:${f.key}`, f.secret ? '' : f.value])),
    },
    mutation: trpc.service.setConfig,
    toPayload: (v) => ({
      alias,
      config: Object.fromEntries(data.config.map((f) => [f.key, v[`cfg:${f.key}`]!])),
      secrets: Object.fromEntries(data.secrets.map((f) => [f.key, String(v[`sec:${f.key}`] ?? '')])),
    }),
    onSaved: () => utils.service.getConfig.invalidate({ alias }),
  });

  return (
    <div class="space-y-6 max-w-lg">
      {data.admin && <ServiceAdminPageLink alias={alias} />}

      {(data.config.length > 0 || data.secrets.length > 0) && (
        <form {...formProps} class="space-y-6">
          {data.config.length > 0 && (
            <section class="space-y-3">
              <SectionHeading>Service Settings</SectionHeading>
              {data.config.map((f) => {
                const name = `cfg:${f.key}`;
                if (f.type === 'boolean') {
                  return (
                    <ToggleInput
                      key={f.key}
                      label={f.label}
                      value={Boolean(form.watch(name))}
                      onChange={(v) => form.setValue(name, v, { shouldDirty: true })}
                    />
                  );
                }
                if (f.type === 'number') {
                  return (
                    <NumberInput
                      key={f.key}
                      label={f.label}
                      value={form.watch(name) as number | string}
                      onInput={(v) => form.setValue(name, v, { shouldDirty: true })}
                    />
                  );
                }
                return (
                  <TextInput
                    key={f.key}
                    label={f.label}
                    value={String(form.watch(name) ?? '')}
                    onInput={(v) => form.setValue(name, v, { shouldDirty: true })}
                  />
                );
              })}
            </section>
          )}

          {data.secrets.length > 0 && (
            <section class="space-y-3">
              <SectionHeading>Service Credentials</SectionHeading>
              {data.secrets.map((f) => {
                const name = `sec:${f.key}`;
                return f.secret ? (
                  <SecretInput
                    key={f.key}
                    label={f.label}
                    value={String(form.watch(name) ?? '')}
                    onInput={(v) => form.setValue(name, v, { shouldDirty: true })}
                    isSet={f.set}
                    helpText={f.required && !f.set ? 'Required by the service.' : undefined}
                  />
                ) : (
                  <TextInput
                    key={f.key}
                    label={f.label}
                    value={String(form.watch(name) ?? '')}
                    onInput={(v) => form.setValue(name, v, { shouldDirty: true })}
                    helpText={f.required && !f.set ? 'Required by the service.' : undefined}
                  />
                );
              })}
            </section>
          )}

          <p class="text-xs text-gray-600">
            Saving restarts the agent service so the new values take effect.
          </p>

          <FormStatus message={message} />
          <SubmitButton submitProps={submitProps}>Save</SubmitButton>
        </form>
      )}
    </div>
  );
}
