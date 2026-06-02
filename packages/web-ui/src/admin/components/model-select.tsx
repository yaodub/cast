import { useState } from 'preact/hooks';
import { trpc } from '../trpc';

type ModelOption = { id: string; label: string };

/**
 * Synthesize options from the cast-services /api/models response:
 * - Models in `oneMSupported` emit two rows (base 200k + `[1m]` 1M).
 * - Other models emit one row.
 */
function buildOptions(data: { id: string; display_name: string }[], oneMSupported: string[]): ModelOption[] {
  const oneM = new Set(oneMSupported);
  return data.flatMap((m) =>
    oneM.has(m.id)
      ? [
          { id: m.id, label: `${m.display_name} (200k)` },
          { id: `${m.id}[1m]`, label: `${m.display_name} (1M)` },
        ]
      : [{ id: m.id, label: m.display_name }],
  );
}

export function ModelSelect({ value, onChange, allowEmpty, emptyLabel, class: className }: {
  value: string;
  onChange: (v: string) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  class?: string;
}) {
  const { data } = trpc.models.list.useQuery(undefined, { staleTime: 10 * 60 * 1000 });
  const [customOverride, setCustomOverride] = useState(false);

  const options = data ? buildOptions(data.data, data.oneMSupported) : [];
  const knownIds = new Set(options.map((o) => o.id));
  const isKnown = value === '' || knownIds.has(value);
  const custom = customOverride || (!isKnown && data !== undefined);

  if (!data) {
    return (
      <select disabled class={className}>
        <option value={value}>{value || emptyLabel || 'Default'}</option>
      </select>
    );
  }

  if (custom) {
    return (
      <div class="flex gap-2">
        <input type="text" value={value} onInput={(e) => onChange((e.target as HTMLInputElement).value)}
          placeholder="model-id" class={`flex-1 ${className}`} />
        <button type="button" onClick={() => { onChange(''); setCustomOverride(false); }}
          class="px-3 py-2 text-xs text-gray-400 hover:text-gray-200 bg-gray-800 rounded transition-colors">
          Back
        </button>
      </div>
    );
  }

  return (
    <select
      value={value}
      onChange={(e) => {
        const v = (e.target as HTMLSelectElement).value;
        if (v === '__custom__') { setCustomOverride(true); onChange(''); }
        else onChange(v);
      }}
      class={className}
    >
      {allowEmpty && <option value="">{emptyLabel ?? 'Default'}</option>}
      {options.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
      <option value="__custom__">Custom...</option>
    </select>
  );
}
