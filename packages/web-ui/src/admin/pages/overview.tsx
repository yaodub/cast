/**
 * Server overview — landing page at `/`.
 *
 * Mirrors the four server-scope tiles in the sidebar (Messaging,
 * Identities, Activity, Settings) so this page reads as a status
 * snapshot of the same four areas. Each section summarizes the
 * relevant data and links into the detail page.
 *
 * Agent fleet lives at `/agents` (AgentsListPage). Pairing requests
 * are surfaced here as a cross-cutting alert because they are
 * server-level operator tasks.
 */
import { useMemo } from 'preact/hooks';
import { Link } from 'wouter';
import { trpc } from '../trpc';
import { ActivityIcon, CogIcon, GlobeIcon, UserIcon } from '../components/icons';
import type { PageManualEntry } from '@getcast/admin-schema/v1';
import type { JSX } from 'preact';

export const pageManual: PageManualEntry = {
  purpose: 'Server overview — messaging, identities, activity, and settings status snapshots, plus pairing-request alerts. Cold-start landing for the admin shell; reachable via the Cast wordmark in the sidebar. Agent fleet is on the All Agents page (/agents).',
};

function formatUptime(ms: number) {
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function StatusDot({ active }: { active: boolean }) {
  return <span class={`inline-block w-2 h-2 rounded-full ${active ? 'bg-green-400' : 'bg-gray-600'}`} />;
}

/** One server-scope summary card. Tile + heading mirror the sidebar
 *  tiles (indigo fill, same icon), so the section header here reads as
 *  a "you are here" badge for that area of the server. */
function SectionHeader({
  Icon,
  label,
  hint,
}: {
  Icon: (props: { class?: string }) => JSX.Element;
  label: string;
  hint?: string;
}) {
  return (
    <div class="flex items-center gap-3 mb-3">
      <span class="w-8 h-8 flex items-center justify-center rounded-md bg-indigo-600 text-white shrink-0">
        <Icon class="w-4 h-4" />
      </span>
      <div>
        <h2 class="text-sm font-medium text-white">{label}</h2>
        {hint && <p class="text-xs text-gray-500">{hint}</p>}
      </div>
    </div>
  );
}

function StatLine({ value, label }: { value: string | number; label: string }) {
  return (
    <div>
      <div class="text-2xl font-semibold text-white">{value}</div>
      <div class="text-xs text-gray-500 mt-0.5">{label}</div>
    </div>
  );
}

function SectionCard({ children, href, linkText }: {
  children: preact.ComponentChildren;
  href: string;
  linkText: string;
}) {
  return (
    <div class="bg-gray-900 rounded-lg flex flex-col">
      <div class="p-5 flex-1 space-y-3">{children}</div>
      <div class="px-5 py-3 border-t border-gray-800/50">
        <Link href={href} class="text-xs text-gray-400 hover:text-gray-200 transition-colors">
          {linkText} →
        </Link>
      </div>
    </div>
  );
}

export function OverviewPage() {
  const status = trpc.status.get.useQuery();
  const routes = trpc.route.list.useQuery();
  const transportTypes = trpc.route.transportTypes.useQuery();
  const pairingCounts = trpc.agent.pendingPairingCounts.useQuery();
  const idpAgents = trpc.idp.agents.useQuery();
  const idpUsers = trpc.idp.users.useQuery();
  // Last 24h snapshot for the Activity card. Memo'd so the query input
  // is stable across renders (mirrors the pattern in the Activity page).
  const since24h = useMemo(() => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(), []);
  const activityRecent = trpc.host.activityLog.useQuery({ since: since24h, limit: 1 });
  const activityErrors = trpc.host.activityLog.useQuery({ since: since24h, level: 'error', limit: 1 });

  const totalPending = pairingCounts.data?.reduce((sum, r) => sum + r.count, 0) ?? 0;

  // Per-transport summary, registry-driven. Order follows the descriptor
  // list (registration order); transports with zero entries are dropped.
  const transportSummaries = (transportTypes.data ?? []).flatMap((t) => {
    const entries = routes.data?.byType[t.name] ?? [];
    if (entries.length === 0) return [];
    return [{
      name: t.name,
      label: t.displayLabel,
      count: entries.length,
      online: entries.some((e) => e.online),
    }];
  });
  const routeTotal = transportSummaries.reduce((sum, s) => sum + s.count, 0);

  const agentRegCount = idpAgents.data?.length ?? 0;
  const userIdCount = idpUsers.data?.length ?? 0;

  return (
    <div class="space-y-8">
      <div>
        <h1 class="text-lg font-semibold text-white">Server</h1>
        {status.data && (
          <p class="text-sm text-gray-500 mt-1">Up for {formatUptime(status.data.uptimeMs)}</p>
        )}
      </div>

      {/* Pairing requests — cross-cutting alert */}
      {totalPending > 0 && (
        <div class="px-4 py-3 bg-amber-900/20 border border-amber-700/30 rounded-lg space-y-2">
          <div class="flex items-center gap-2">
            <span class="w-2.5 h-2.5 rounded-full bg-amber-400 shrink-0" />
            <span class="text-sm font-medium text-amber-200">
              {totalPending} outstanding pairing {totalPending === 1 ? 'request' : 'requests'}
            </span>
          </div>
          <div class="flex gap-2 ml-4.5">
            {pairingCounts.data!.map((r) => (
              <Link
                key={r.alias}
                href={`/agents/${r.alias}/access`}
                class="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-amber-200 bg-amber-800/30 hover:bg-amber-800/50 rounded-md transition-colors"
              >
                {r.alias}
                <span class="text-amber-400 font-semibold">{r.count}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Four server-scope sections, mirroring the sidebar tiles */}
      <div class="grid grid-cols-2 gap-4">
        {/* Messaging */}
        <SectionCard href="/routes" linkText={routeTotal === 0 ? 'Set up messaging' : 'Manage messaging'}>
          <SectionHeader Icon={GlobeIcon} label="Messaging" hint="Telegram, email, websocket" />
          <StatLine
            value={routeTotal === 0 ? 'None' : routeTotal}
            label={routeTotal === 0 ? 'No routes configured' :
              routeTotal === 1 ? '1 connection' :
              `${routeTotal} connections`}
          />
          {routeTotal > 0 && (
            <div class="flex items-center gap-3 text-xs text-gray-500">
              {transportSummaries.map((s) => (
                <span key={s.name} class="flex items-center gap-1.5">
                  <StatusDot active={s.online} />
                  {s.count} {s.label}
                </span>
              ))}
            </div>
          )}
        </SectionCard>

        {/* Identities */}
        <SectionCard href="/identity" linkText="Manage identities">
          <SectionHeader Icon={UserIcon} label="Identities" hint={status.data?.idpIdentifier} />
          <div class="grid grid-cols-2 gap-4">
            <StatLine value={agentRegCount} label={agentRegCount === 1 ? 'Agent registered' : 'Agents registered'} />
            <StatLine value={userIdCount} label={userIdCount === 1 ? 'User identity' : 'User identities'} />
          </div>
        </SectionCard>

        {/* Activity */}
        <SectionCard href="/activity" linkText="Open activity log">
          <SectionHeader Icon={ActivityIcon} label="Activity" hint="Last 24h on the host" />
          <div class="grid grid-cols-2 gap-4">
            <StatLine
              value={activityRecent.data?.total ?? 0}
              label={(activityRecent.data?.total ?? 0) === 1 ? 'Event' : 'Events'}
            />
            <StatLine
              value={activityErrors.data?.total ?? 0}
              label={(activityErrors.data?.total ?? 0) === 1 ? 'Error' : 'Errors'}
            />
          </div>
        </SectionCard>

        {/* Settings */}
        <SectionCard href="/settings" linkText="Manage settings">
          <SectionHeader Icon={CogIcon} label="Settings" hint="Preferences + model credentials" />
          <p class="text-sm text-gray-400">
            Console model, API keys, OAuth tokens.
          </p>
        </SectionCard>
      </div>
    </div>
  );
}
