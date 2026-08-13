/**
 * Google Messages extension admin page — pairing, access modes, per-conversation
 * and per-number policy.
 *
 * PairingFlow is a multi-step state machine with async polling, so it stays
 * hand-rolled; the policy form below uses useAdminForm.
 */
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';

import { trpc } from '../../trpc';
import type { PageManualEntry } from '@getcast/admin-schema/v1';

export const pageManual: PageManualEntry = {
  purpose:
    'Google Messages (SMS/RCS) extension config for this agent — pairing from account cookies, read/send modes, per-conversation and per-number overrides.',
  actions: [
    'Pair with the phone by pasting a signed-in browser cookie export, then approving the code on the handset',
    'Change read/send policy (disabled / approval / open / direct)',
    'Allow or deny specific conversations, and authorise cold sends to specific numbers',
  ],
};
import { SectionHeading, SelectInput } from '../../components/inputs';
import { FormStatus, SubmitButton } from '../../components/form';
import { QueryView } from '../../components/query-view';
import { useAdminForm } from '../../hooks/use-admin-form';
import {
  GmessagesFormSchema,
  gmessagesFormInitialValues,
  gmessagesFormToPayload,
  type GmessagesServerData,
  type OverrideForm,
} from '../../schemas/gmessages';

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

/**
 * Cookies in → code out → the HANDSET shows a matching request → user approves there → paired.
 *
 * The pairing runs DETACHED on the server and this polls `pairingStatus` for its progress, because
 * `pairFromCookies` does not resolve until the relay answers the finish request — and that answer
 * only comes after the human approves on the phone, which they cannot do without first seeing the
 * code. Awaiting the mutation would therefore withhold the code until after the moment it was needed.
 */
function PairingFlow({ alias, onPaired }: { alias: string; onPaired: () => void }) {
  const [cookies, setCookies] = useState('');
  const [code, setCode] = useState<{ emoji: string | null; numeric: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Must be state, not a ref: the "starting" screen has to re-render when it flips, and a ref
  // mutation does not schedule one.
  const [starting, setStarting] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const utils = trpc.useUtils();
  const pairMut = trpc.extension.gmessages.pair.useMutation({
    onSuccess: () => utils.extension.gmessages.getConfig.invalidate({ alias }),
  });
  const statusQuery = trpc.extension.gmessages.pairingStatus.useQuery({ alias }, { enabled: false });

  const stopPolling = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStarting(false);
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const handlePair = async () => {
    setError(null);
    setCode(null);
    stopPolling();
    setStarting(true);

    const result = await pairMut.mutateAsync({ alias, cookies });
    // Drop the cookies from component state the moment they have been used —
    // they are account-wide Google credentials, not a form value to keep around.
    setCookies('');
    if (!result.ok) {
      setError(result.message);
      setStarting(false);
      return;
    }

    // The mutation only STARTS the pairing; the code arrives mid-handshake and the
    // handshake itself does not finish until the operator approves on the phone. So
    // poll for the code first, show it, then keep polling for completion.
    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    const deadline = Date.now() + 300_000; // the relay holds an attempt ~5 minutes

    (async () => {
      while (!signal.aborted) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1000);
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        if (signal.aborted) return;
        if (Date.now() > deadline) {
          setError('Pairing timed out. Try again.');
          setCode(null);
          stopPolling();
          return;
        }

        const status = (await statusQuery.refetch()).data;
        if (signal.aborted) return;

        if (status?.status === 'code') {
          setStarting(false);
          setCode({ emoji: status.emoji, numeric: status.numeric });
        } else if (status?.status === 'error') {
          setError(status.message);
          setCode(null);
          stopPolling();
          return;
        } else if (status?.status === 'done') {
          setCode(null);
          stopPolling();
          onPaired();
          return;
        }
      }
    })();
  };

  // Started, but the handshake has not produced a code yet. Without this the UI sits on a
  // disabled "Pairing…" button and looks hung during the sign-in round trip.
  if (!code && starting && !error) {
    return (
      <div class="bg-gray-900 border border-gray-700 rounded p-4 space-y-2">
        <p class="text-sm text-gray-300">Starting pairing…</p>
        <p class="text-xs text-gray-500">
          Signing in and opening the handshake. The code appears here in a few seconds — your phone
          shows a matching one only after that.
        </p>
        <button
          type="button"
          onClick={() => { stopPolling(); setCode(null); }}
          class="text-sm text-gray-500 hover:text-gray-300"
        >
          Cancel
        </button>
      </div>
    );
  }

  if (code) {
    return (
      <div class="bg-gray-900 border border-gray-700 rounded p-4 space-y-3">
        <p class="text-sm text-gray-300">Approve the request on your phone showing this code:</p>
        {/* The emoji is absent when Google ships a table revision this build has not captured. The
            numeric code is derived from the same number without a table, so it is promoted to the
            headline rather than shown as a fallback — the pairing is fine, just not pictorial. */}
        {code.emoji ? (
          <>
            <p class="text-6xl text-center py-2 leading-none" aria-label="pairing emoji">{code.emoji}</p>
            {code.numeric && (
              <p class="text-center text-sm text-gray-500 mono">or numeric: {code.numeric}</p>
            )}
          </>
        ) : (
          <>
            <p class="text-5xl text-center py-2 mono tracking-widest">{code.numeric}</p>
            <p class="text-center text-xs text-gray-500">
              Your phone shows a number here rather than a picture.
            </p>
          </>
        )}
        <p class="text-sm text-gray-400">Google Messages on the handset → approve the pairing request.</p>
        <p class="text-xs text-gray-500">Waiting for approval… (up to 5 minutes, then the relay drops the attempt)</p>
        <button
          type="button"
          onClick={() => { stopPolling(); setCode(null); }}
          class="text-sm text-gray-500 hover:text-gray-300"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div class="space-y-3">
      <div class="text-xs text-gray-500 space-y-2">
        <p>
          Paste a cookie export from a browser signed in to the Google account (Netscape cookies.txt, or
          the JSON most extensions produce). These are account-wide credentials — they are used once to
          pair and are never stored.
        </p>
        <p class="text-amber-500/90">
          <strong>Use a private window in Firefox or Safari, and close it after exporting.</strong>
        </p>
        <p>
          <strong class="text-gray-400">Not Chrome.</strong> Chrome 146+ binds the login to the machine
          (DBSC), which no external client can refresh — such an export is rejected here rather than
          failing later.
        </p>
        <p>
          <strong class="text-gray-400">Close the window afterwards.</strong> Google rotates a freshness
          token on the login and whichever session rotates it last invalidates the others, so a browser
          you keep using will kill this pairing within hours. Private window, closed, leaves one consumer
          — this agent — and the session stays good for weeks.
        </p>
      </div>
      <textarea
        value={cookies}
        onInput={(e) => setCookies((e.target as HTMLTextAreaElement).value)}
        placeholder="# Netscape HTTP Cookie File …"
        rows={5}
        class="w-full px-3 py-1.5 bg-gray-950 border border-gray-700 rounded text-white text-xs mono focus:outline-none focus:border-teal-500"
      />
      <button
        type="button"
        onClick={handlePair}
        disabled={pairMut.isPending || !cookies.trim()}
        class="px-4 py-1.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-sm rounded font-medium"
      >
        {pairMut.isPending ? 'Pairing…' : 'Pair with phone'}
      </button>
      {error && <p class="text-sm text-red-400">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Override rows
// ---------------------------------------------------------------------------

function OverrideRows({
  rows,
  readInherit,
  sendInherit,
  showRead,
  onChange,
}: {
  rows: OverrideForm[];
  readInherit: string;
  sendInherit: string;
  showRead: boolean;
  onChange: (next: OverrideForm[]) => void;
}) {
  const update = (index: number, field: 'read' | 'send', value: '' | 'allow' | 'deny') => {
    const updated = [...rows];
    const item = updated[index];
    if (!item) return;
    const next: OverrideForm = { ...item };
    if (value === '') delete next[field];
    else next[field] = value;
    updated[index] = next;
    onChange(updated);
  };

  return (
    <div class="space-y-2">
      {rows.map((row, i) => (
        <div key={row.key} class="bg-gray-900 border border-gray-800 rounded p-3 space-y-2">
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-300">
              {row.label ?? row.key}
              {row.label && <span class="mono text-xs text-gray-600 ml-2">{row.key}</span>}
            </span>
            <button
              type="button"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
              class="text-gray-500 hover:text-red-400 text-xs"
            >
              Remove
            </button>
          </div>
          <div class={`grid ${showRead ? 'grid-cols-2' : 'grid-cols-1'} gap-2`}>
            {showRead && (
              <label class="text-xs text-gray-500 space-y-1">
                <span>Read</span>
                <select
                  value={row.read ?? ''}
                  onChange={(e) => update(i, 'read', (e.target as HTMLSelectElement).value as '' | 'allow' | 'deny')}
                  class="w-full px-2 py-1 bg-gray-950 border border-gray-700 rounded text-white text-xs"
                >
                  <option value="">{readInherit}</option>
                  <option value="allow">Allow</option>
                  <option value="deny">Deny</option>
                </select>
              </label>
            )}
            <label class="text-xs text-gray-500 space-y-1">
              <span>Send</span>
              <select
                value={row.send ?? ''}
                onChange={(e) => update(i, 'send', (e.target as HTMLSelectElement).value as '' | 'allow' | 'deny')}
                class="w-full px-2 py-1 bg-gray-950 border border-gray-700 rounded text-white text-xs"
              >
                <option value="">{sendInherit}</option>
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
              </select>
            </label>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function GmessagesExtensionPage({ alias }: { alias: string }) {
  const configQuery = trpc.extension.gmessages.getConfig.useQuery({ alias });
  return (
    <QueryView query={configQuery}>
      {(data) => <GmessagesForm alias={alias} data={data} />}
    </QueryView>
  );
}

function GmessagesForm({ alias, data }: { alias: string; data: GmessagesServerData }) {
  const utils = trpc.useUtils();
  const unpair = trpc.extension.gmessages.unpair.useMutation({
    onSuccess: () => utils.extension.gmessages.getConfig.invalidate({ alias }),
  });
  const refresh = trpc.extension.gmessages.refreshConversations.useMutation({
    onSuccess: () => utils.extension.gmessages.getConfig.invalidate({ alias }),
  });

  const { form, message, formProps, submitProps } = useAdminForm({
    schema: GmessagesFormSchema,
    values: gmessagesFormInitialValues(data),
    mutation: trpc.extension.gmessages.setConfig,
    toPayload: (v) => gmessagesFormToPayload(alias, v, data),
    onSaved: () => utils.extension.gmessages.getConfig.invalidate({ alias }),
  });

  const { config, paired, connected, conversations } = data;
  const chatOverrides = form.watch('chatOverrides');
  const contactOverrides = form.watch('contactOverrides');
  const readMode = form.watch('readMode');
  const sendMode = form.watch('sendMode');

  const [search, setSearch] = useState('');
  const [newNumber, setNewNumber] = useState('');

  const readInherit = `Inherit (${readMode})`;
  const sendInherit = `Inherit (${sendMode})`;

  const addChat = (key: string, label?: string) => {
    const trimmed = key.trim();
    if (trimmed && !chatOverrides.some((o) => o.key === trimmed)) {
      form.setValue('chatOverrides', [...chatOverrides, { key: trimmed, label }], { shouldDirty: true });
    }
  };

  const addContact = (key: string) => {
    const trimmed = key.trim();
    if (!/^\+[1-9]\d{6,14}$/.test(trimmed)) return;
    if (!contactOverrides.some((o) => o.key === trimmed)) {
      form.setValue('contactOverrides', [...contactOverrides, { key: trimmed }], { shouldDirty: true });
    }
  };

  return (
    <form {...formProps} class="space-y-6 max-w-lg">
      <div class="px-4 py-2.5 bg-amber-900/20 border border-amber-700/30 rounded-lg text-sm text-amber-200">
        Preview — new in this release. Pairing, read policy, sending, and watches all work; expect
        rough edges in this admin flow while it matures.
      </div>
      <section class="space-y-3">
        <SectionHeading>Pairing Status</SectionHeading>
        <div class="flex items-center gap-3">
          <span class={`inline-block w-2 h-2 rounded-full ${paired ? 'bg-green-500' : 'bg-red-500'}`} />
          <span class="text-sm text-gray-300">
            {paired ? (connected ? 'Paired — connected' : 'Paired — not connected') : 'Not paired'}
          </span>
        </div>
        {!paired && (
          <PairingFlow alias={alias} onPaired={() => utils.extension.gmessages.getConfig.invalidate({ alias })} />
        )}
        {paired && (
          <div class="space-y-2">
            <p class="text-xs text-gray-500">
              Revoking for real happens on the handset: Google Messages → device list → unpair. This button
              only clears the local session.
            </p>
            <button
              type="button"
              onClick={() => {
                if (confirm('Clear the local session? The agent will need to re-pair.')) unpair.mutate({ alias });
              }}
              disabled={unpair.isPending}
              class="px-4 py-2 bg-red-900 hover:bg-red-800 disabled:opacity-50 text-red-200 text-sm rounded font-medium"
            >
              {unpair.isPending ? 'Clearing…' : 'Clear session'}
            </button>
          </div>
        )}
      </section>

      <section class="space-y-3">
        <SectionHeading>Access Modes</SectionHeading>
        <SelectInput
          label="Read Mode"
          value={readMode}
          options={[
            { value: 'disabled', label: 'Disabled' },
            { value: 'approval', label: 'Approval' },
            { value: 'open', label: 'Open' },
          ]}
          onChange={(v) => form.setValue('readMode', v as 'disabled' | 'approval' | 'open', { shouldDirty: true })}
          locked={config.read_mode?.locked}
          helpText="Default for conversations with no override. Approval prompts the user; Open allows; Disabled blocks. An explicit per-conversation Allow beats Disabled."
        />
        <SelectInput
          label="Send Mode"
          value={sendMode}
          options={[
            { value: 'disabled', label: 'Disabled' },
            { value: 'approval', label: 'Approval' },
            { value: 'direct', label: 'Direct (sends immediately)' },
          ]}
          onChange={(v) => form.setValue('sendMode', v as 'disabled' | 'approval' | 'direct', { shouldDirty: true })}
          locked={config.send_mode?.locked}
          helpText="Disabled is a master switch here — unlike reads, no allowlist entry overrides it. A first message to a number with no existing thread ALWAYS asks, even on Direct."
        />
      </section>

      <section class="space-y-3">
        <SectionHeading>Per-Conversation Overrides</SectionHeading>
        {config.chats?.locked ? (
          <p class="text-sm text-gray-500">Conversation overrides are locked by the author.</p>
        ) : (
          <>
            {chatOverrides.length > 0 && (
              <OverrideRows
                rows={chatOverrides}
                readInherit={readInherit}
                sendInherit={sendInherit}
                showRead
                onChange={(next) => form.setValue('chatOverrides', next, { shouldDirty: true })}
              />
            )}
            <div class="flex items-center justify-between">
              <p class="text-xs text-gray-500">
                {conversations.length > 0
                  ? 'Click a conversation below to add it.'
                  : 'No conversations cached — refresh while the agent is running.'}
              </p>
              <button
                type="button"
                onClick={() => refresh.mutate({ alias })}
                disabled={refresh.isPending || !connected}
                class="px-3 py-1 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 text-xs rounded"
              >
                {refresh.isPending ? 'Refreshing…' : 'Refresh list'}
              </button>
            </div>
            {conversations.length > 0 && (
              <>
                <input
                  type="text"
                  value={search}
                  onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
                  placeholder="Search conversations…"
                  class="w-full px-3 py-1.5 bg-gray-950 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-teal-500"
                />
                <div class="space-y-1 max-h-80 overflow-y-auto">
                  {conversations
                    .filter((c) => {
                      const q = search.trim().toLowerCase();
                      return !q || c.label.toLowerCase().includes(q) || c.conversationId.includes(q);
                    })
                    .map((c) => {
                      const added = chatOverrides.some((o) => o.key === c.conversationId);
                      return (
                        <button
                          key={c.conversationId}
                          type="button"
                          disabled={added}
                          onClick={() => addChat(c.conversationId, c.label)}
                          class={`w-full text-left px-3 py-1.5 rounded text-sm flex items-center gap-2 ${
                            added
                              ? 'bg-gray-900 text-gray-600 cursor-not-allowed'
                              : 'bg-gray-900 text-gray-300 hover:bg-gray-800 cursor-pointer'
                          }`}
                        >
                          <span class={`text-xs font-medium ${c.kind === 'rcs' ? 'text-blue-400' : 'text-gray-500'}`}>
                            {c.kind.toUpperCase()}
                          </span>
                          <span class="truncate">{c.label}</span>
                          <span class="mono text-xs text-gray-600 ml-auto flex-shrink-0">{c.conversationId}</span>
                        </button>
                      );
                    })}
                </div>
              </>
            )}
          </>
        )}
      </section>

      <section class="space-y-3">
        <SectionHeading>Per-Number (first contact)</SectionHeading>
        {config.contacts?.locked ? (
          <p class="text-sm text-gray-500">Number overrides are locked by the author.</p>
        ) : (
          <>
            <p class="text-xs text-gray-500">
              Authorises sending to a specific number in E.164 form. A first message to a number with no
              existing thread always requires approval unless it is allowed here.
            </p>
            {contactOverrides.length > 0 && (
              <OverrideRows
                rows={contactOverrides}
                readInherit={readInherit}
                sendInherit={sendInherit}
                showRead={false}
                onChange={(next) => form.setValue('contactOverrides', next, { shouldDirty: true })}
              />
            )}
            <div class="flex gap-2">
              <input
                type="text"
                value={newNumber}
                onInput={(e) => setNewNumber((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); addContact(newNumber); setNewNumber(''); }
                }}
                placeholder="+14155550000"
                class="flex-1 px-3 py-1.5 bg-gray-950 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-teal-500"
              />
              <button
                type="button"
                onClick={() => { addContact(newNumber); setNewNumber(''); }}
                class="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded"
              >
                Add
              </button>
            </div>
          </>
        )}
      </section>

      <FormStatus message={message} />
      <SubmitButton submitProps={submitProps}>Save</SubmitButton>
    </form>
  );
}
