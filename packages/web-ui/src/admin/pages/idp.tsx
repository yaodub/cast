import { Link, useRoute } from 'wouter';

import { trpc } from '../trpc';
import { UserIcon } from '../components/icons';
import { HelpButton } from '../components/help-button';
import { RefreshButton } from '../components/log-controls';
import type { PageManualEntry } from '@getcast/admin-schema/v1';

export const pageManual: PageManualEntry = {
  purpose: 'Identities (read-only) — directory of who the Cast server has seen, split into two subtabs: registered agents and known users. No writes happen here.',
  sections: [
    { anchor: 'agents', purpose: 'Registered agents — name + pubkey fingerprint + first registration date. One row per agent that has ever connected to this server.', actions: [] },
    { anchor: 'users',  purpose: 'Known users — identity ID, declared name, list of handles (tg:..., email:..., etc.), and creation date. A user appears the first time they reach any agent.', actions: [] },
  ],
};

type Subtab = 'agents' | 'users';

export function IdpPage() {
  const [, params] = useRoute<{ subtab?: string }>('/identity/:subtab');
  const activeSubtab: Subtab = params?.subtab === 'users' ? 'users' : 'agents';

  const meta = trpc.idp.meta.useQuery();
  const utils = trpc.useUtils();

  return (
    <div class="space-y-6">
      <div class="flex items-center gap-4">
        <span class="w-12 h-12 flex items-center justify-center rounded-md bg-indigo-600 text-white shrink-0">
          <UserIcon class="w-6 h-6" />
        </span>
        <div>
          <h1 class="text-lg font-semibold text-white">Identities</h1>
          <p class="text-sm text-gray-500 mt-0.5">Server identity, registered agents, known users</p>
        </div>
      </div>

      {/* Server meta — sits above the subtabs since it's about the server
          itself, not specific to either list. */}
      {meta.data && (
        <div class="text-sm text-gray-400">
          IdP identifier: <span class="mono text-gray-200">{meta.data.idpIdentifier}</span>
        </div>
      )}

      <div class="flex items-center gap-6 border-b border-gray-800">
        <SubTabLink subtab="agents" current={activeSubtab}>Agents</SubTabLink>
        <SubTabLink subtab="users" current={activeSubtab}>Users</SubTabLink>
        <span class="ml-auto pb-2 flex items-center gap-2">
          <RefreshButton
            onClick={() => {
              void utils.idp.agents.invalidate();
              void utils.idp.users.invalidate();
              void utils.idp.meta.invalidate();
            }}
          />
          <HelpButton anchor={activeSubtab} />
        </span>
      </div>

      {activeSubtab === 'agents' && <AgentsView />}
      {activeSubtab === 'users' && <UsersView />}
    </div>
  );
}

function SubTabLink({ subtab, current, children }: {
  subtab: Subtab;
  current: Subtab;
  children: string;
}) {
  const href = `/identity/${subtab}`;
  const active = current === subtab;
  return (
    <Link
      href={href}
      class={`relative px-1 py-2 text-sm font-medium transition-colors ${
        active ? 'text-white' : 'text-gray-500 hover:text-gray-300'
      }`}
    >
      {children}
      {active && <span class="absolute -bottom-px left-0 right-0 h-0.5 bg-teal-500 rounded-full" />}
    </Link>
  );
}

function AgentsView() {
  const agents = trpc.idp.agents.useQuery();
  return (
    <section>
      {agents.isLoading && <p class="text-gray-500 text-sm">Loading...</p>}
      {agents.data && agents.data.length === 0 && <p class="text-gray-500 text-sm">No agents registered.</p>}
      {agents.data && agents.data.length > 0 && (
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-gray-500 border-b border-gray-800">
              <th class="pb-2 font-medium">Name</th>
              <th class="pb-2 font-medium">Fingerprint</th>
              <th class="pb-2 font-medium">Registered</th>
            </tr>
          </thead>
          <tbody>
            {agents.data.map((agent) => (
              <tr key={agent.name} class="border-b border-gray-800/50">
                <td class="py-2 text-gray-200">{agent.name}</td>
                <td class="py-2 mono text-gray-400">{agent.fingerprint}</td>
                <td class="py-2 text-gray-400">{new Date(agent.registeredAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function UsersView() {
  const users = trpc.idp.users.useQuery();
  return (
    <section>
      {users.isLoading && <p class="text-gray-500 text-sm">Loading...</p>}
      {users.data && users.data.length === 0 && <p class="text-gray-500 text-sm">No user identities.</p>}
      {users.data && users.data.length > 0 && (
        <table class="w-full text-sm">
          <thead>
            <tr class="text-left text-gray-500 border-b border-gray-800">
              <th class="pb-2 font-medium">ID</th>
              <th class="pb-2 font-medium">Name</th>
              <th class="pb-2 font-medium">Handles</th>
              <th class="pb-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {users.data.map((user) => (
              <tr key={user.id} class="border-b border-gray-800/50">
                <td class="py-2 mono text-gray-400">{user.id}</td>
                <td class="py-2 text-gray-200">{user.declaredName}</td>
                <td class="py-2 mono text-gray-400 text-xs">
                  {user.handles.join(', ') || '—'}
                </td>
                <td class="py-2 text-gray-400">{new Date(user.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
