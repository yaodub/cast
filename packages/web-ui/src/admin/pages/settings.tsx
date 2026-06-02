import { serverUpdateConfigInput } from '@getcast/server/admin/schemas';

import { trpc } from '../trpc';
import { ModelSelect } from '../components/model-select';
import { FormStatus, SubmitButton, inputClass } from '../components/form';
import { CredentialsForm } from '../components/credentials-form';
import { CogIcon } from '../components/icons';
import { HelpButton } from '../components/help-button';
import { ToggleInput } from '../components/inputs';
import { useAdminForm } from '../hooks/use-admin-form';
import type { PageManualEntry } from '@getcast/admin-schema/v1';

export const pageManual: PageManualEntry = {
  purpose: 'Server-level settings — two stacked sections: console defaults (default model, intermediate-message visibility, inter-console isolation mode) and model access (Anthropic API key / Claude OAuth token). Saving credentials verifies them with a 1-token Claude ping and hot-reloads the server in place; consoleIsolation takes effect live.',
  sections: [
    {
      anchor: 'console',
      purpose: 'Console defaults: model used by Design/Configure/Manager sessions, whether tool calls show inline, and which inter-console push paths are open.',
      actions: [
        'Change the default console model',
        'Toggle intermediate-message visibility in console sessions',
        'Switch console isolation between normal (opens Design → Configure on same agent, DM → any __configure, and DM → CM) and strict (those bridges closed; managers keep their default reach — DM to __design, CM to __configure — and the operator routes cross-category handoffs via tab-switch). Configure → Design is permanently blocked in both modes (PII exfil carrier).',
      ],
    },
    {
      anchor: 'model',
      purpose: 'Anthropic LLM credentials Cast itself uses to reach Claude. Distinct from extension/MCP credentials and route auth tokens.',
      actions: [
        'Switch auth mode between api-key and setup-token',
        'Paste/rotate an Anthropic API key',
        'Update the Claude OAuth token',
      ],
    },
  ],
};

export function SettingsPage() {
  return (
    <div class="space-y-8">
      <div class="flex items-center gap-4">
        <span class="w-12 h-12 flex items-center justify-center rounded-md bg-indigo-600 text-white shrink-0">
          <CogIcon class="w-6 h-6" />
        </span>
        <div>
          <h1 class="text-lg font-semibold text-white">Settings</h1>
          <p class="text-sm text-gray-500 mt-0.5">Console defaults, model credentials, and server lifecycle</p>
        </div>
      </div>

      <ConsoleSection />
      <ModelSection />
      <LifecycleSection />
    </div>
  );
}

// ---------- Server lifecycle ----------

function LifecycleSection() {
  const shutdown = trpc.server.shutdown.useMutation();
  const onClick = () => {
    if (!confirm('Shut down the Cast server? This ends every active conversation and closes connections to all transports. Bringing the server back up is the supervisor\'s responsibility.')) return;
    shutdown.mutate();
  };
  return (
    <section id="lifecycle" class="space-y-3">
      <h2 class="text-sm font-medium text-gray-300">Server lifecycle</h2>
      <p class="text-xs text-gray-500 max-w-md">
        Triggers a graceful shutdown — drains active conversations, closes all DBs, and signals
        clients to reconnect when the server is back. Bringing the server back up is the
        supervisor's responsibility.
      </p>
      <button
        onClick={onClick}
        disabled={shutdown.isPending || shutdown.isSuccess}
        class="px-3 py-1.5 text-sm font-medium text-amber-100 bg-amber-800/40 hover:bg-amber-800/60 border border-amber-600/40 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {shutdown.isSuccess ? 'Shutdown signaled' : shutdown.isPending ? 'Shutting down…' : 'Shutdown server'}
      </button>
      {shutdown.error && (
        <p class="text-xs text-red-400">Failed to signal shutdown: {shutdown.error.message}</p>
      )}
    </section>
  );
}

// ---------- Console defaults ----------

function ConsoleSection() {
  const config = trpc.server.getConfig.useQuery();
  const utils = trpc.useUtils();

  const { form, message, formProps, submitProps } = useAdminForm({
    schema: serverUpdateConfigInput,
    values: {
      consoleModel: config.data?.consoleModel ?? null,
      showManagerSteps: config.data?.showManagerSteps ?? false,
      consoleIsolation: config.data?.consoleIsolation ?? 'normal',
    },
    mutation: trpc.server.updateConfig,
    toPayload: (v) => ({
      consoleModel: v.consoleModel || null,
      showManagerSteps: v.showManagerSteps ?? false,
      consoleIsolation: v.consoleIsolation ?? 'normal',
    }),
    successText: 'Console settings saved',
    onSaved: () => utils.server.getConfig.invalidate(),
  });

  return (
    <section id="console" class="space-y-3">
      <h2 class="text-sm font-medium text-gray-300">Console</h2>
      {config.isLoading ? (
        <p class="text-gray-500 text-sm">Loading...</p>
      ) : (
        <form {...formProps} class="space-y-4 max-w-md">
          <div>
            <label class="flex items-center gap-2 text-sm text-gray-400 mb-1">
              Console Model
              <HelpButton label="Console Model" />
            </label>
            <ModelSelect
              value={form.watch('consoleModel') ?? ''}
              onChange={(v) => form.setValue('consoleModel', v || null, { shouldDirty: true })}
              class={inputClass}
            />
            <p class="text-xs text-gray-500 mt-1.5">Model used for console-mode sessions (design, configure, design-manager, config-manager, security-manager).</p>
          </div>

          <ToggleInput
            label="Show steps in manager consoles"
            value={form.watch('showManagerSteps') ?? false}
            onChange={(v) => form.setValue('showManagerSteps', v, { shouldDirty: true })}
            helpText="When on, tool calls and intermediate reasoning are shown in the Design Manager, Config Manager, and Security Manager consoles."
            helpAction={<HelpButton label="Show steps in manager consoles" />}
          />

          <div>
            <label class="flex items-center gap-2 text-sm text-gray-400 mb-1">
              Console isolation
              <HelpButton label="Console isolation" />
            </label>
            <select
              value={form.watch('consoleIsolation') ?? 'normal'}
              onChange={(e) => form.setValue('consoleIsolation', (e.target as HTMLSelectElement).value as 'normal' | 'strict', { shouldDirty: true })}
              class={inputClass}
            >
              <option value="normal">normal</option>
              <option value="strict">strict</option>
            </select>
            <p class="text-xs text-gray-500 mt-1.5">Gates push between consoles. Takes effect live.</p>
          </div>

          <FormStatus message={message} />
          <SubmitButton submitProps={submitProps}>Save</SubmitButton>
        </form>
      )}
    </section>
  );
}

// ---------- Model Access (lifted from former /model-auth page) ----------

function ModelSection() {
  const authStatus = trpc.auth.getStatus.useQuery();

  return (
    <section id="model" class="space-y-3">
      <h2 class="text-sm font-medium text-gray-300">Model Access</h2>
      {authStatus.data && (
        <CredentialsForm data={authStatus.data} onSaved={() => authStatus.refetch()} />
      )}
    </section>
  );
}
