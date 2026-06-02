/**
 * CredentialsForm — Model Access form shared between the Settings page and
 * the AuthSetupModal (triggered from any chat console when auth=null).
 *
 * Save behavior: the tRPC mutation writes .env, re-resolves auth, pings
 * Claude to verify, then hot-reloads the server. On verify failure the
 * mutation throws with a typed message which the form surfaces inline via
 * `useAdminForm`'s status banner. No restart needed on success.
 */
import { updateCredentialsInput } from '@getcast/server/admin/schemas';

import { trpc } from '../trpc';
import { FormStatus, SubmitButton, inputClass } from './form';
import { HelpButton } from './help-button';
import { useAdminForm } from '../hooks/use-admin-form';

const AUTH_MODES = ['api-key', 'setup-token'] as const;
type AuthMode = typeof AUTH_MODES[number];

function isAuthMode(v: string | null): v is AuthMode {
  return v === 'api-key' || v === 'setup-token';
}

/** Color for OAuth-token expiry: red within 7 days, yellow within 30, gray otherwise. */
function expiryColor(expiresAt: number): string {
  if (expiresAt < Date.now() + 7 * 86400000) return 'text-red-400';
  if (expiresAt < Date.now() + 30 * 86400000) return 'text-yellow-400';
  return 'text-gray-400';
}

export interface CredentialsFormData {
  mode: string | null;
  expiresAt?: number | null;
  authMode: string | null;
  hasApiKey: boolean;
  hasOAuthToken: boolean;
}

export function CredentialsForm({ data, onSaved }: {
  data: CredentialsFormData;
  onSaved: () => void;
}) {
  const initialAuthMode: AuthMode = isAuthMode(data.authMode)
    ? data.authMode
    : isAuthMode(data.mode) ? data.mode : 'api-key';

  const { form, message, formProps, submitProps } = useAdminForm({
    schema: updateCredentialsInput,
    values: { authMode: initialAuthMode, apiKey: '', oauthToken: '' },
    mutation: trpc.auth.updateCredentials,
    toPayload: (v) => ({
      authMode: v.authMode,
      apiKey: v.apiKey || undefined,
      oauthToken: v.oauthToken || undefined,
    }),
    successText: 'Saved and verified.',
    onSaved,
  });

  const authMode = form.watch('authMode');

  return (
    <form {...formProps} class="space-y-4 max-w-md">
      <div>
        <label class="flex items-center gap-2 text-sm text-gray-400 mb-1">
          AUTH_MODE
          <HelpButton label="AUTH_MODE" />
        </label>
        <select {...form.register('authMode')} class={inputClass}>
          <option value="api-key">api-key</option>
          <option value="setup-token">setup-token</option>
        </select>
      </div>

      {authMode === 'api-key' && (
        <div>
          <label class="block text-sm text-gray-400 mb-1">
            ANTHROPIC_API_KEY
            {data.hasApiKey && <span class="text-green-400 ml-2">(set)</span>}
          </label>
          <input
            type="password"
            {...form.register('apiKey')}
            placeholder={data.hasApiKey ? 'Leave blank to keep current' : 'sk-ant-...'}
            class={inputClass}
          />
          <p class="text-xs text-gray-500 mt-2">
            Create a key at{' '}
            <a
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-400 hover:text-blue-300 underline"
            >
              console.anthropic.com/settings/keys
            </a>
            . Usage is billed to your Anthropic account.
          </p>
        </div>
      )}

      {authMode === 'setup-token' && (
        <div>
          <label class="block text-sm text-gray-400 mb-1">
            CLAUDE_CODE_OAUTH_TOKEN
            {data.hasOAuthToken && <span class="text-green-400 ml-2">(set)</span>}
          </label>
          <input
            type="password"
            {...form.register('oauthToken')}
            placeholder={data.hasOAuthToken ? 'Leave blank to keep current' : 'sk-ant-oat01-...'}
            class={inputClass}
          />
          <p class="text-xs text-gray-500 mt-2">
            Generate by running <span class="font-mono text-gray-400">claude setup-token</span> in your terminal (requires the{' '}
            <a
              href="https://docs.claude.com/en/docs/claude-code"
              target="_blank"
              rel="noopener noreferrer"
              class="text-blue-400 hover:text-blue-300 underline"
            >
              Claude Code CLI
            </a>
            ). Usage draws from your Claude.ai plan.
          </p>
          {data.expiresAt && (
            <p class="text-xs mt-1">
              <span class="text-gray-500">Expires: </span>
              <span class={expiryColor(data.expiresAt)}>
                {new Date(data.expiresAt).toLocaleDateString()}
              </span>
            </p>
          )}
        </div>
      )}

      <FormStatus message={message} />
      <SubmitButton submitProps={submitProps}>Save</SubmitButton>
    </form>
  );
}
