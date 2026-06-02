/**
 * MCP Servers admin page — provision env secrets for blueprint-declared MCP servers.
 */
import { z } from 'zod';
import { mcpServerSetEnvInput } from '@getcast/server/admin/schemas';

import { trpc } from '../trpc';
import {
  SectionHeading,
  SecretInput,
  TextInput,
} from '../components/inputs';
import { FormStatus, SubmitButton } from '../components/form';
import { useAdminForm } from '../hooks/use-admin-form';

export function McpServersPage({ alias }: { alias: string }) {
  const servers = trpc.mcpServers.list.useQuery({ alias });

  return (
    <div class="space-y-6">
      <McpTrustAdvisory />
      {servers.isLoading && <p class="text-gray-500 text-sm">Loading...</p>}
      {!servers.isLoading && (!servers.data || servers.data.length === 0) && (
        <p class="text-gray-500 text-sm">No MCP servers declared for this agent.</p>
      )}
      {servers.data?.map((server) => (
        <McpServerCard key={server.name} alias={alias} server={server} />
      ))}
    </div>
  );
}

// Operator-facing posture warning. MCP is a distinct trust class from
// Cast extensions and the ecosystem has had a steady CVE pattern
// throughout 2025-2026 — operators should make adding an MCP server
// a security-relevant decision, not a feature toggle. Honest framing:
// not "MCP bad, Cast good" but "you're stacking trust relationships
// and the protocol gives fewer guardrails than our framework does."
function McpTrustAdvisory() {
  return (
    <div class="px-4 py-3 bg-amber-900/20 border border-amber-700/30 rounded-lg space-y-2">
      <div class="flex items-center gap-2">
        <span class="w-2.5 h-2.5 rounded-full bg-amber-400 shrink-0" />
        <span class="text-sm font-medium text-amber-200">
          MCP servers expand your trust surface
        </span>
      </div>
      <div class="text-xs text-amber-100/80 leading-relaxed space-y-2 pl-4.5">
        <p>
          Each MCP server is third-party code that can do whatever
          its code allows. The AI also reads the server's tool
          descriptions and outputs as context, so a compromised
          server can manipulate the agent through either.
        </p>
        <ul class="list-disc list-outside ml-4 space-y-1">
          <li>
            <span class="font-medium text-amber-100">Prefer reputable vendors.</span>
            {' '}First-party servers from companies you already trust
            are safer than random ones.
          </li>
          <li>
            <span class="font-medium text-amber-100">Watch what the tools can do.</span>
            {' '}Read-only lookups are low-risk; tools that write
            files, send messages, or move money are not.
          </li>
          <li>
            <span class="font-medium text-amber-100">Don't paste secrets while a chat is connected.</span>
            {' '}They could be exfiltrated through prompt injection.
          </li>
          <li>
            <span class="font-medium text-amber-100">Keep MCP client tooling patched.</span>
            {' '}The ecosystem has had a steady stream of security bugs.
          </li>
        </ul>
      </div>
    </div>
  );
}

interface EnvSlot {
  key: string;
  locked: boolean;
  value: string;
  required: boolean;
  description?: string;
  set: boolean;
}

interface ServerInfo {
  name: string;
  transport: string;
  command?: string;
  args?: string[];
  url?: string;
  envSlots: EnvSlot[];
}

/** Per-server form schema: env is a dict keyed by slot name. */
const EnvFormSchema = z.object({
  env: z.record(z.string(), z.string()),
});

function McpServerCard({ alias, server }: { alias: string; server: ServerInfo }) {
  const utils = trpc.useUtils();
  const unlockedSlots = server.envSlots.filter((s) => !s.locked);
  const lockedSlots = server.envSlots.filter((s) => s.locked);

  const initialEnv: Record<string, string> = {};
  for (const s of unlockedSlots) initialEnv[s.key] = '';

  const { form, message, formProps, submitProps } = useAdminForm({
    schema: EnvFormSchema,
    values: { env: initialEnv },
    mutation: trpc.mcpServers.setEnv,
    toPayload: (v): z.infer<typeof mcpServerSetEnvInput> => {
      const updates: Record<string, string> = {};
      for (const [key, val] of Object.entries(v.env)) {
        if (val) updates[key] = val;
      }
      return { alias, server: server.name, env: updates };
    },
    successText: 'Saved',
    onSaved: () => {
      utils.mcpServers.list.invalidate({ alias });
      form.reset({ env: initialEnv });
    },
  });

  const transportLabel = server.transport === 'stdio'
    ? `stdio: ${server.command} ${(server.args ?? []).join(' ')}`
    : `${server.transport}: ${server.url ?? ''}`;

  return (
    <div class="bg-gray-900 border border-gray-800 rounded p-4">
      <SectionHeading>{server.name}</SectionHeading>
      <p class="text-xs text-gray-500 mb-3">{transportLabel}</p>

      {lockedSlots.length > 0 && (
        <div class="mb-3 space-y-2">
          {lockedSlots.map((slot) => (
            <TextInput
              key={slot.key}
              label={slot.key}
              value={slot.value}
              onInput={() => {}}
              locked
              helpText={slot.description}
            />
          ))}
        </div>
      )}

      {unlockedSlots.length > 0 ? (
        <form {...formProps} class="space-y-3">
          {unlockedSlots.map((slot) => (
            <SecretInput
              key={slot.key}
              label={`${slot.key}${slot.required ? ' *' : ''}`}
              value={form.watch(`env.${slot.key}`) ?? ''}
              onInput={(v) => form.setValue(`env.${slot.key}`, v, { shouldDirty: true })}
              isSet={slot.set}
              helpText={slot.description}
            />
          ))}
          <div class="flex items-center gap-3 pt-1">
            <SubmitButton submitProps={submitProps}>Save</SubmitButton>
            <FormStatus message={message} />
          </div>
        </form>
      ) : (
        <p class="text-xs text-gray-600">No operator-configurable env vars.</p>
      )}
    </div>
  );
}
