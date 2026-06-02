/**
 * Routes admin page — registry-driven.
 *
 * The form has no transport-specific knowledge. It fetches descriptors from
 * `route.transportTypes`, renders the type dropdown from `displayLabel`, and
 * renders fields by iterating `descriptor.fields` (grouping by `group`). Setup
 * instructions are markdown, rendered via the shared markdown helper.
 *
 * Adding a new transport requires zero edits to this file.
 */
import { useEffect, useState } from 'preact/hooks';
import { Controller } from 'react-hook-form';

import { trpc } from '../trpc';
import { AgentSelect } from '../components/agent-select';
import { ChannelSelect } from '../components/channel-select';
import { FormStatus, SubmitButton, inputClass } from '../components/form';
import { GlobeIcon } from '../components/icons';
import { HelpButton } from '../components/help-button';
import { useAdminForm } from '../hooks/use-admin-form';
import { renderMarkdown } from '../../lib/markdown';
import {
  RouteDraftSchema,
  type RouteDraft,
  type RoutesServerData,
  EMPTY_DRAFT,
  draftFromEntry,
  routesFormToPayload,
  routesRemovePayload,
} from '../schemas/route';
import type { PageManualEntry } from '@getcast/admin-schema/v1';

export const pageManual: PageManualEntry = {
  purpose: 'Transport routes — bind a Telegram bot token, email account, or Slack app to an agent+channel. Each entry tells the gateway "messages on this transport go to that agent."',
  actions: [
    'Add a new route (agent, channel, credentials) for any registered transport type',
    'Edit an existing route to change its target agent/channel',
    'Remove a route to stop receiving messages on that transport',
  ],
};

interface AdminFieldDescriptor {
  key: string;
  type: 'text' | 'password' | 'number';
  label: string;
  placeholder?: string;
  helpText?: string;
  group?: string;
  secret: boolean;
  optional: boolean;
}

interface TransportDescriptor {
  name: string;
  displayLabel: string;
  fields: AdminFieldDescriptor[];
  setupInstructions?: string;
}

interface FlatRouteRow {
  type: string;
  address: string;
  channel: string | null;
  online: boolean;
  summary: string;
  idx: number;
}

function StatusDot({ active }: { active: boolean }) {
  return <span class={`inline-block w-2 h-2 rounded-full ${active ? 'bg-green-400' : 'bg-gray-600'}`} />;
}

function TypeBadge({ label }: { label: string }) {
  return (
    <span class="text-xs font-medium text-gray-400 bg-gray-800 px-2 py-0.5 rounded">
      {label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Field rendering
// ---------------------------------------------------------------------------

function fieldInputType(t: 'text' | 'password' | 'number'): string {
  return t;
}

function FieldsBlock({
  fields,
  values,
  onChange,
}: {
  fields: AdminFieldDescriptor[];
  values: Record<string, string | number>;
  onChange: (key: string, value: string | number) => void;
}) {
  // Partition into ungrouped + grouped (preserving group insertion order).
  const ungrouped: AdminFieldDescriptor[] = [];
  const groupOrder: string[] = [];
  const grouped: Record<string, AdminFieldDescriptor[]> = {};
  for (const f of fields) {
    if (!f.group) {
      ungrouped.push(f);
    } else {
      if (!grouped[f.group]) {
        grouped[f.group] = [];
        groupOrder.push(f.group);
      }
      grouped[f.group]!.push(f);
    }
  }

  const renderInput = (f: AdminFieldDescriptor) => {
    const v = values[f.key] ?? '';
    const inputProps = {
      type: fieldInputType(f.type),
      value: String(v),
      placeholder: f.placeholder,
      class: inputClass,
      onInput: (e: Event) => {
        const raw = (e.target as HTMLInputElement).value;
        onChange(f.key, f.type === 'number' ? (raw === '' ? '' : Number(raw)) : raw);
      },
    };
    return (
      <div key={f.key}>
        <label class="block text-sm text-gray-400 mb-1">{f.label}</label>
        <input {...inputProps} />
        {f.helpText && <p class="text-xs text-gray-500 mt-1">{f.helpText}</p>}
      </div>
    );
  };

  return (
    <div class="space-y-4">
      {ungrouped.length > 0 && (
        <div class="space-y-3">
          {ungrouped.map(renderInput)}
        </div>
      )}
      {groupOrder.length > 0 && (
        <div class={groupOrder.length === 1 ? 'grid grid-cols-1 gap-4' : 'grid grid-cols-2 gap-4'}>
          {groupOrder.map((g) => (
            <div key={g} class="space-y-3">
              <h4 class="text-xs font-medium text-gray-500 uppercase tracking-wider">{g}</h4>
              {grouped[g]!.map(renderInput)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Add / edit form
// ---------------------------------------------------------------------------

function emptyFieldValues(descriptor: TransportDescriptor): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of descriptor.fields) out[f.key] = '';
  return out;
}

function RouteForm({ data, descriptors, initial, editTarget, lockType, onDone }: {
  data: RoutesServerData;
  descriptors: TransportDescriptor[];
  initial: RouteDraft;
  editTarget: { type: string; idx: number } | null;
  lockType?: boolean;
  onDone: () => void;
}) {
  const utils = trpc.useUtils();
  const { form, message, formProps, submitProps } = useAdminForm({
    schema: RouteDraftSchema,
    values: initial,
    mutation: trpc.route.update,
    toPayload: (v) => routesFormToPayload(data, v, editTarget),
    successText: 'Routes saved. Changes apply within 60 seconds.',
    onSaved: () => {
      utils.route.list.invalidate();
      onDone();
    },
  });

  const type = form.watch('type');
  const address = form.watch('address');
  const fields = form.watch('fields') as Record<string, string | number>;
  const descriptor = descriptors.find((d) => d.name === type);

  // Reset fields when the type changes (e.g. user picks a different transport
  // in Add mode). In edit mode, lockType keeps the dropdown disabled.
  useEffect(() => {
    if (!descriptor) return;
    const current = form.getValues('fields');
    // If field keys don't match the descriptor, reseed to empty.
    const expectedKeys = descriptor.fields.map((f) => f.key).sort().join(',');
    const actualKeys = Object.keys(current ?? {}).sort().join(',');
    if (expectedKeys !== actualKeys) {
      form.setValue('fields', emptyFieldValues(descriptor), { shouldDirty: true });
    }
  }, [type, descriptor, form]);

  return (
    <form {...formProps} class="bg-gray-900 rounded-lg p-5 space-y-4">
      <div class="grid grid-cols-3 gap-3">
        <div>
          <label class="block text-sm text-gray-400 mb-1">Transport</label>
          <select
            value={type}
            onChange={(e) => {
              const newType = (e.target as HTMLSelectElement).value;
              const next = descriptors.find((d) => d.name === newType);
              form.reset({
                ...EMPTY_DRAFT,
                type: newType,
                fields: next ? emptyFieldValues(next) : {},
              }, { keepDirty: true });
            }}
            class={inputClass}
            disabled={lockType}
          >
            {!type && <option value="">Select…</option>}
            {descriptors.map((d) => (
              <option key={d.name} value={d.name}>{d.displayLabel}</option>
            ))}
          </select>
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">Agent</label>
          <Controller
            name="address"
            control={form.control}
            render={({ field }) => (
              <AgentSelect
                value={field.value}
                onChange={(v) => {
                  field.onChange(v);
                  form.setValue('channel', '', { shouldDirty: true });
                }}
                class={inputClass}
              />
            )}
          />
        </div>
        <div>
          <label class="block text-sm text-gray-400 mb-1">Channel</label>
          <Controller
            name="channel"
            control={form.control}
            render={({ field }) => (
              <ChannelSelect
                alias={address}
                value={field.value}
                onChange={field.onChange}
                class={inputClass}
              />
            )}
          />
        </div>
      </div>

      {descriptor && descriptor.setupInstructions && (
        <details class="bg-gray-800/40 rounded p-3 text-sm text-gray-400">
          <summary class="cursor-pointer font-medium text-gray-300 hover:text-white">
            How to get these credentials
          </summary>
          <div
            class="mt-3 prose prose-invert prose-sm max-w-none [&>:first-child]:mt-0 [&>:last-child]:mb-0 [&_a]:text-blue-400 [&_a]:hover:underline [&_code]:text-amber-300 [&_code]:bg-gray-900/40 [&_code]:px-1 [&_code]:rounded [&_strong]:text-gray-200 [&_em]:text-amber-300/90"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(descriptor.setupInstructions) }}
          />
        </details>
      )}

      {descriptor && (
        <FieldsBlock
          fields={descriptor.fields}
          values={fields}
          onChange={(key, value) => {
            const current = (form.getValues('fields') as Record<string, string | number>) ?? {};
            form.setValue('fields', { ...current, [key]: value }, { shouldDirty: true });
          }}
        />
      )}

      <FormStatus message={message} />
      <div class="flex gap-2">
        <SubmitButton submitProps={submitProps}>Save</SubmitButton>
        <button type="button" onClick={onDone}
          class="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors">
          Cancel
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function RoutesPage() {
  const routes = trpc.route.list.useQuery();
  const types = trpc.route.transportTypes.useQuery();
  const utils = trpc.useUtils();
  const updateRoutes = trpc.route.update.useMutation({
    onSuccess: () => utils.route.list.invalidate(),
  });

  const [adding, setAdding] = useState(false);
  const [editingIdx, setEditingIdx] = useState<{ type: string; idx: number } | null>(null);

  if (routes.isLoading || types.isLoading) return <p class="text-gray-500 text-sm">Loading...</p>;
  if (routes.error) return <p class="text-red-400 text-sm">Error: {routes.error.message}</p>;
  if (types.error) return <p class="text-red-400 text-sm">Error: {types.error.message}</p>;

  const data: RoutesServerData = routes.data!;
  const descriptors: TransportDescriptor[] = types.data!;
  const labelOf = (type: string) =>
    descriptors.find((d) => d.name === type)?.displayLabel ?? type;

  const rows: FlatRouteRow[] = [];
  for (const d of descriptors) {
    const entries = data.byType[d.name] ?? [];
    entries.forEach((e, idx) => rows.push({
      type: d.name,
      address: e.address,
      channel: e.channel,
      online: e.online,
      summary: e.summary,
      idx,
    }));
  }

  function removeRoute(type: string, idx: number) {
    if (!confirm(`Remove this ${labelOf(type)} route?`)) return;
    updateRoutes.mutate(routesRemovePayload(data, type, idx));
  }

  const initialAddDraft: RouteDraft = (() => {
    if (descriptors.length === 0) return EMPTY_DRAFT;
    const first = descriptors[0]!;
    const fields: Record<string, string> = {};
    for (const f of first.fields) fields[f.key] = '';
    return { ...EMPTY_DRAFT, type: first.name, fields };
  })();

  return (
    <div class="space-y-6">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-4">
          <span class="w-12 h-12 flex items-center justify-center rounded-md bg-indigo-600 text-white shrink-0">
            <GlobeIcon class="w-6 h-6" />
          </span>
          <div>
            <div class="flex items-center gap-2">
              <h1 class="text-lg font-semibold text-white">Messaging</h1>
              <HelpButton />
            </div>
            <p class="text-sm text-gray-500 mt-0.5">
              {descriptors.map((d) => d.displayLabel).join(', ')}, websocket transports
            </p>
          </div>
        </div>
        {!adding && !editingIdx && (
          <button onClick={() => setAdding(true)}
            class="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-lg font-medium transition-colors">
            Add Route
          </button>
        )}
      </div>

      {rows.length > 0 && !adding && !editingIdx && (
        <div class="bg-gray-900 rounded-lg overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-gray-500 border-b border-gray-800">
                <th class="px-5 py-3 font-medium w-12" />
                <th class="px-5 py-3 font-medium">Type</th>
                <th class="px-5 py-3 font-medium">Details</th>
                <th class="px-5 py-3 font-medium">Agent</th>
                <th class="px-5 py-3 font-medium">Channel</th>
                <th class="px-5 py-3 font-medium w-24" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.type}-${row.idx}`} class="border-b border-gray-800/50 last:border-0">
                  <td class="px-5 py-3"><StatusDot active={row.online} /></td>
                  <td class="px-5 py-3"><TypeBadge label={labelOf(row.type)} /></td>
                  <td class="px-5 py-3 mono text-gray-400">{row.summary}</td>
                  <td class="px-5 py-3 mono text-gray-300">{row.address}</td>
                  <td class="px-5 py-3 text-gray-400">{row.channel ?? 'default'}</td>
                  <td class="px-5 py-3 text-right">
                    <button onClick={() => { setEditingIdx({ type: row.type, idx: row.idx }); setAdding(false); }}
                      class="text-xs text-gray-500 hover:text-gray-300 mr-3 transition-colors">Edit</button>
                    <button onClick={() => removeRoute(row.type, row.idx)}
                      class="text-xs text-gray-500 hover:text-red-400 transition-colors">Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows.length === 0 && !adding && (
        <div class="bg-gray-900 rounded-lg p-8 text-center">
          <p class="text-gray-400 text-sm">No routes configured</p>
          <p class="text-gray-500 text-xs mt-1">Connect external messaging platforms to your agents.</p>
        </div>
      )}

      {adding && (
        <RouteForm
          data={data}
          descriptors={descriptors}
          initial={initialAddDraft}
          editTarget={null}
          onDone={() => setAdding(false)}
        />
      )}

      {editingIdx && (
        <RouteForm
          data={data}
          descriptors={descriptors}
          initial={draftFromEntry(data, editingIdx.type, editingIdx.idx)}
          editTarget={editingIdx}
          lockType
          onDone={() => setEditingIdx(null)}
        />
      )}
    </div>
  );
}
