import { useMemo, useState } from 'preact/hooks';

import { trpc } from '../trpc';
import { ActivityIcon } from '../components/icons';
import { HelpButton } from '../components/help-button';
import {
  TIME_RANGES,
  trashIcon,
  RefreshButton,
  DangerButton,
  FilterField,
} from '../components/log-controls';
import type { PageManualEntry } from '@getcast/admin-schema/v1';

export const pageManual: PageManualEntry = {
  purpose: 'Host activity log — structured event stream from the orchestrator process. Bus drops (messages to non-existent addresses), agent lifecycle (registered/unregistered), container failures, identity-registration failures. Mirrors the per-agent Activity tab but at host scope.',
  sections: [
    { anchor: 'filters', purpose: 'Narrow by level (error/warn/info), component (bus/lifecycle/container/auth/etc.), and time range.', actions: ['Filter by level', 'Filter by component', 'Filter by time range'] },
    { anchor: 'table', purpose: 'Most recent events newest-first. Click a row to expand context (from/to addresses, error details, payload type for bus drops).', actions: [] },
    { anchor: 'clear', purpose: 'Wipe the entire activity log. Irreversible.', actions: ['Clear log'] },
  ],
};

type HostLevel = 'error' | 'warn' | 'info';
type HostComponent = 'bus' | 'gateway' | 'transport' | 'auth' | 'firewall' | 'container' | 'lifecycle';

const PAGE_SIZE = 50;
const MAX_LIMIT = 500;

export function ActivityPage() {
  const [level, setLevel] = useState<HostLevel | ''>('');
  const [component, setComponent] = useState<HostComponent | ''>('');
  const [timeRange, setTimeRange] = useState<keyof typeof TIME_RANGES>('all');
  const [displayLimit, setDisplayLimit] = useState(PAGE_SIZE);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Memoized so the query input is stable. New ISO every render would
  // create a fresh react-query key on every render → infinite loop.
  const sinceIso = useMemo(() => {
    const ms = TIME_RANGES[timeRange];
    return ms ? new Date(Date.now() - ms).toISOString() : undefined;
  }, [timeRange]);

  const events = trpc.host.activityLog.useQuery({
    limit: displayLimit,
    level: level || undefined,
    component: component || undefined,
    since: sinceIso,
  }, {
    refetchInterval: 5000,
  });

  const clear = trpc.host.clearActivityLog.useMutation({
    onSuccess: () => { setDisplayLimit(PAGE_SIZE); events.refetch(); },
  });

  const onClear = () => {
    if (clear.isPending) return;
    if (!confirm('Clear all host activity events? This cannot be undone.')) return;
    clear.mutate();
  };

  const resetAndSet = <T,>(setter: (v: T) => void) => (v: T) => {
    setDisplayLimit(PAGE_SIZE);
    setter(v);
  };

  const toggleRow = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const levelClass = (lv: HostLevel) =>
    lv === 'error' ? 'text-red-400' : lv === 'warn' ? 'text-amber-400' : 'text-gray-400';

  const total = events.data?.total ?? 0;
  const shown = events.data?.events.length ?? 0;
  const hasMore = events.data ? events.data.truncated && displayLimit < MAX_LIMIT : false;

  return (
    <div class="space-y-6">
      <div class="flex items-center gap-4">
        <span class="w-12 h-12 flex items-center justify-center rounded-md bg-indigo-600 text-white shrink-0">
          <ActivityIcon class="w-6 h-6" />
        </span>
        <div class="flex-1">
          <h1 class="text-lg font-semibold text-white">Activity</h1>
          <p class="text-sm text-gray-500 mt-0.5">Host event log — bus drops, lifecycle, container failures</p>
        </div>
        <HelpButton />
      </div>

      <div class="flex items-center justify-end gap-2">
        <RefreshButton onClick={() => events.refetch()} disabled={events.isFetching} />
        <DangerButton
          onClick={onClear}
          disabled={clear.isPending || total === 0}
          label={clear.isPending ? 'Clearing…' : 'Clear log'}
          title={total === 0 ? 'No events to clear' : `Clear all ${total} ${total === 1 ? 'event' : 'events'}`}
          icon={trashIcon}
        />
      </div>

      <div class="grid grid-cols-[auto_auto_auto] gap-3 w-fit text-sm">
        <FilterField
          label="Level"
          value={level}
          options={[
            { value: '', label: 'All' },
            { value: 'error', label: 'error' },
            { value: 'warn', label: 'warn' },
            { value: 'info', label: 'info' },
          ]}
          onChange={(v) => resetAndSet<HostLevel | ''>(setLevel)(v as HostLevel | '')}
          width="w-32"
        />
        <FilterField
          label="Component"
          value={component}
          options={[
            { value: '', label: 'All' },
            { value: 'bus', label: 'bus' },
            { value: 'gateway', label: 'gateway' },
            { value: 'transport', label: 'transport' },
            { value: 'auth', label: 'auth' },
            { value: 'firewall', label: 'firewall' },
            { value: 'container', label: 'container' },
            { value: 'lifecycle', label: 'lifecycle' },
          ]}
          onChange={(v) => resetAndSet<HostComponent | ''>(setComponent)(v as HostComponent | '')}
          width="w-40"
        />
        <FilterField
          label="Time"
          value={timeRange}
          options={[
            { value: 'all', label: 'All time' },
            { value: '1h', label: 'Last hour' },
            { value: '24h', label: 'Last 24h' },
            { value: '7d', label: 'Last 7 days' },
          ]}
          onChange={(v) => resetAndSet<keyof typeof TIME_RANGES>(setTimeRange)(v as keyof typeof TIME_RANGES)}
          width="w-36"
        />
      </div>

      {events.isLoading && <p class="text-gray-500 text-sm">Loading...</p>}
      {!events.isLoading && shown === 0 && (
        <p class="text-gray-500 text-sm">No events.</p>
      )}
      {shown > 0 && (
        <div class="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-gray-500 border-b border-gray-800">
                <th class="px-4 py-3 font-medium w-48">Timestamp</th>
                <th class="px-4 py-3 font-medium w-16">Level</th>
                <th class="px-4 py-3 font-medium w-24">Component</th>
                <th class="px-4 py-3 font-medium w-40">Event</th>
                <th class="px-4 py-3 font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {events.data!.events.map((ev) => {
                const hasContext = ev.context && Object.keys(ev.context).length > 0;
                const hasAddrs = !!(ev.from_addr || ev.to_addr);
                const expandable = hasContext || hasAddrs;
                const isOpen = expanded.has(ev.id);
                return (
                  <>
                    <tr
                      key={ev.id}
                      class={`border-t border-gray-800/50 ${expandable ? 'cursor-pointer hover:bg-gray-800/40' : ''}`}
                      onClick={() => expandable && toggleRow(ev.id)}
                    >
                      <td class="px-4 py-2 mono text-gray-400 text-xs whitespace-nowrap">{new Date(ev.ts).toLocaleString()}</td>
                      <td class={`px-4 py-2 mono text-xs ${levelClass(ev.level)}`}>{ev.level}</td>
                      <td class="px-4 py-2 mono text-xs text-gray-400">{ev.component}</td>
                      <td class="px-4 py-2 mono text-xs text-gray-300">{ev.event_name}</td>
                      <td class="px-4 py-2 text-gray-300">
                        {ev.message}
                        {expandable && <span class="ml-2 text-gray-600">{isOpen ? '▾' : '▸'}</span>}
                      </td>
                    </tr>
                    {isOpen && expandable && (
                      <tr key={`${ev.id}-detail`} class="border-t border-gray-800/30 bg-gray-950">
                        <td colSpan={5} class="px-4 py-3 space-y-2">
                          {hasAddrs && (
                            <div class="text-xs space-y-1">
                              {ev.from_addr && (
                                <div>
                                  <span class="text-gray-500">from: </span>
                                  <span class="mono text-gray-300">{ev.from_addr}</span>
                                </div>
                              )}
                              {ev.to_addr && (
                                <div>
                                  <span class="text-gray-500">to: </span>
                                  <span class="mono text-gray-300">{ev.to_addr}</span>
                                </div>
                              )}
                            </div>
                          )}
                          {hasContext && (
                            <pre class="text-xs mono text-gray-400 whitespace-pre-wrap break-all">{JSON.stringify(ev.context, null, 2)}</pre>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
          <div class="flex items-center justify-between px-4 py-2 text-xs text-gray-500 border-t border-gray-800 bg-gray-950">
            <span>Showing {shown} of {total} {total === 1 ? 'event' : 'events'}</span>
            {hasMore && (
              <button
                type="button"
                onClick={() => setDisplayLimit((d) => Math.min(d + PAGE_SIZE, MAX_LIMIT))}
                class="px-2 py-1 text-gray-300 hover:text-white hover:bg-gray-800 rounded transition-colors"
              >
                Load more
              </button>
            )}
            {!hasMore && displayLimit >= MAX_LIMIT && total > shown && (
              <span class="text-gray-600">Max {MAX_LIMIT} shown — use filters to narrow</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

