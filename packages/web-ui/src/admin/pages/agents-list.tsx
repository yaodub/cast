/**
 * Agents fleet rollup at `/agents`.
 *
 * Sidebar carries the per-agent directory (avatars, aliases, draft badges)
 * — duplicating that as a card list here would be pure redundancy. This
 * page answers "what's the state of the fleet right now?" instead: a small
 * stat strip + an attention list (drafts pending review).
 *
 * Future: cross-agent posture rollup, last-activity timeline, fleet search.
 */
import { Link } from 'wouter';
import { trpc } from '../trpc';
import { AllAgentsGlyph } from '../components/icons';
import { HelpButton } from '../components/help-button';
import type { PageManualEntry } from '@getcast/admin-schema/v1';
import type { JSX } from 'preact';

export const pageManual: PageManualEntry = {
  purpose: 'Fleet rollup — total agent count, drafts in flight, fleet-wide active conversations, plus an attention list for drafts pending review. Reachable via the All Agents tile in the sidebar. The sidebar itself carries the per-agent directory; this page is the fleet-level snapshot.',
};

function StatTile({ value, label }: { value: number | string; label: string }): JSX.Element {
  return (
    <div class="bg-gray-900 border border-gray-800 rounded-md p-5">
      <div class="text-3xl font-semibold text-white tabular-nums">{value}</div>
      <div class="text-xs text-gray-500 mt-1">{label}</div>
    </div>
  );
}

function AttentionChip({ href, label, count }: { href: string; label: string; count?: number }): JSX.Element {
  return (
    <Link
      href={href}
      class="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-200 bg-amber-800/30 hover:bg-amber-800/50 rounded-md transition-colors"
    >
      {label}
      {count != null && <span class="text-amber-400 font-semibold">{count}</span>}
    </Link>
  );
}

export function AgentsListPage(): JSX.Element {
  const agents = trpc.agent.list.useQuery();

  const list = agents.data ?? [];
  const drafts = list.filter((a) => a.status === 'draft');
  const activeConvs = list.reduce((sum, a) => sum + a.activeConversations, 0);

  return (
    <div class="space-y-8">
      <div class="flex items-center gap-4">
        <span class="w-12 h-12 flex items-center justify-center rounded-md bg-teal-600 text-white shrink-0">
          <AllAgentsGlyph class="w-6 h-6" />
        </span>
        <div>
          <div class="flex items-center gap-2">
            <h1 class="text-lg font-semibold text-white">All Agents</h1>
            <HelpButton />
          </div>
          <p class="text-sm text-gray-500 mt-0.5">
            Fleet rollup — the sidebar carries the per-agent directory.
          </p>
        </div>
      </div>

      {agents.isLoading && <p class="text-gray-500 text-sm">Loading…</p>}

      {!agents.isLoading && list.length === 0 && (
        <p class="text-gray-500 text-sm">
          No agents on this server yet. Use <span class="text-gray-300">New agent</span> in the sidebar to scaffold one.
        </p>
      )}

      {!agents.isLoading && list.length > 0 && (
        <>
          <div class="grid grid-cols-3 gap-3">
            <StatTile value={list.length} label={list.length === 1 ? 'agent on this server' : 'agents on this server'} />
            <StatTile value={drafts.length} label={drafts.length === 1 ? 'draft pending review' : 'drafts pending review'} />
            <StatTile
              value={activeConvs}
              label={activeConvs === 1 ? 'active conversation right now' : 'active conversations right now'}
            />
          </div>

          {drafts.length === 0 ? (
            <section class="bg-gray-900 border border-gray-800 rounded-md p-5 text-sm text-gray-500">
              All caught up — no drafts pending review.
            </section>
          ) : (
            <section class="bg-gray-900 border border-gray-800 rounded-md p-5 space-y-4">
              <h2 class="text-sm font-medium text-gray-300">Needs attention</h2>

              <div class="space-y-2">
                <div class="flex items-center gap-2 text-xs text-gray-500">
                  <span class="w-1.5 h-1.5 rounded-full bg-amber-400" />
                  {drafts.length} {drafts.length === 1 ? 'draft pending review' : 'drafts pending review'}
                </div>
                <div class="flex flex-wrap gap-2 pl-4">
                  {drafts.map((d) => (
                    <AttentionChip key={d.alias} href={`/agents/${d.alias}`} label={d.alias} />
                  ))}
                </div>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
