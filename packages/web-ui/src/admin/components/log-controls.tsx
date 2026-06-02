/**
 * Shared activity-log controls — used by both the host-scope `pages/activity.tsx`
 * and the per-agent EventsView in `agent-detail.tsx`. Refresh button, danger
 * (clear-log) button, dropdown filter field, and the time-range bucket map.
 *
 * Extracted when a third caller appeared (per the original "extract if a
 * third caller appears" promise in activity.tsx).
 */
import type { JSX } from 'preact';

import { inputClass } from './form';

/** Time-range buckets for log filtering. `null` means "no time filter". */
export const TIME_RANGES = {
  all: null,
  '1h': 1 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
} as const;

export type TimeRangeKey = keyof typeof TIME_RANGES;

export const trashIcon = (
  <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>
);

export function RefreshButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-200 bg-gray-800 hover:bg-gray-700 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
    >
      <svg class={`w-3.5 h-3.5 ${disabled ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
      Refresh
    </button>
  );
}

export function DangerButton({ onClick, disabled, label, title, icon }: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
  title?: string;
  icon: JSX.Element;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-300 bg-gray-800 hover:bg-red-950/60 hover:text-red-300 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-gray-800 disabled:hover:text-gray-300"
    >
      {icon}
      {label}
    </button>
  );
}

export function FilterField({ label, value, options, onChange, width }: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
  width: string;
}) {
  return (
    <div class="space-y-1">
      <label class="block text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        class={`${inputClass} ${width}`}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
