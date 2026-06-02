/**
 * WhatsApp extension admin page — pairing status, read/send modes, per-chat overrides.
 *
 * PairingFlow is a multi-step state machine with async polling — stays as
 * hand-rolled state. The policy form below uses useAdminForm.
 */
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';

import { trpc } from '../../trpc';
import type { PageManualEntry } from '@getcast/admin-schema/v1';

export const pageManual: PageManualEntry = {
  purpose: 'WhatsApp extension config for this agent — device pairing status (QR code flow), read/send modes, per-chat overrides.',
  actions: [
    'Start the WhatsApp pairing flow (scan QR with phone)',
    'Change read/send policy (passive / active / silent)',
    'Add per-chat overrides to ignore or whitelist specific contacts',
  ],
};
import {
  SectionHeading,
  SelectInput,
} from '../../components/inputs';
import { FormStatus, SubmitButton } from '../../components/form';
import { QueryView } from '../../components/query-view';
import { useAdminForm } from '../../hooks/use-admin-form';
import {
  WhatsAppFormSchema,
  whatsappFormInitialValues,
  whatsappFormToPayload,
  type WhatsAppServerData,
  type ChatOverrideForm,
} from '../../schemas/whatsapp';

interface PairingFlowProps {
  alias: string;
  onPaired: () => void;
  historyDepth: string;
  historyDepthLocked?: boolean;
  onSaveConfig: (updates: Record<string, unknown>) => void;
}

/** Pairing flow — phone number input → history depth → 6-digit code display → poll until paired. */
function PairingFlow({ alias, onPaired, historyDepth, historyDepthLocked, onSaveConfig }: PairingFlowProps) {
  const [phone, setPhone] = useState('');
  const [depth, setDepth] = useState(historyDepth);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // AbortController-based cancellation: every iteration checks `signal.aborted`
  // before doing work, so the current iteration can't fire a stale state update
  // after the user clicked Cancel or the component unmounted.
  const abortRef = useRef<AbortController | null>(null);
  const utils = trpc.useUtils();
  // Invalidate config on pair-request success so any server-side state changes
  // (pending pairing flag, etc.) refresh independent of the poll loop in
  // handlePair. The blanket `useChangesStream` invalidator is the existing
  // safety net; this is per-mutation hygiene.
  const pairMut = trpc.extension.whatsapp.pair.useMutation({
    onSuccess: () => utils.extension.whatsapp.getConfig.invalidate({ alias }),
  });
  const configQuery = trpc.extension.whatsapp.getConfig.useQuery({ alias }, { enabled: false });

  const stopPolling = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const handlePair = async () => {
    setError(null);
    setCode(null);
    // Cancel any prior in-flight poll before starting a new pair attempt.
    stopPolling();
    if (!historyDepthLocked) {
      onSaveConfig({ pairing_history_depth: depth });
    }
    const result = await pairMut.mutateAsync({ alias, phoneNumber: phone });
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setCode('code' in result ? result.code ?? null : null);

    const controller = new AbortController();
    abortRef.current = controller;
    const { signal } = controller;
    const deadline = Date.now() + 120_000;

    (async () => {
      while (!signal.aborted) {
        // Sleep 5s, but resolve immediately on abort.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5000);
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        if (signal.aborted) return;
        if (Date.now() > deadline) {
          setError('Pairing timed out. Try again.');
          setCode(null);
          stopPolling();
          return;
        }
        const data = await configQuery.refetch();
        if (signal.aborted) return;
        if (data.data?.paired) {
          setCode(null);
          stopPolling();
          onPaired();
          return;
        }
      }
    })();
  };

  if (code) {
    return (
      <div class="bg-gray-900 border border-gray-700 rounded p-4 space-y-3">
        <p class="text-sm text-gray-300">Enter this code in WhatsApp:</p>
        <p class="text-sm text-gray-400">Settings → Linked Devices → Link a Device → Link with phone number</p>
        <p class="text-3xl font-mono text-white tracking-widest text-center py-2">
          {code.slice(0, 4)}-{code.slice(4)}
        </p>
        <p class="text-xs text-gray-500">Waiting for pairing... (polling every 5s, up to 2 minutes)</p>
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
      {!historyDepthLocked && (
        <div class="flex items-center gap-3">
          <label class="text-sm text-gray-400">History depth:</label>
          <select
            value={depth}
            onChange={(e) => setDepth((e.target as HTMLSelectElement).value)}
            class="px-2 py-1 bg-gray-950 border border-gray-700 rounded text-white text-sm"
          >
            <option value="standard">Standard (~3 months)</option>
            <option value="extended">Extended (~1 year)</option>
          </select>
        </div>
      )}
      <div class="flex gap-2">
        <input
          type="text"
          value={phone}
          onInput={(e) => setPhone((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handlePair(); } }}
          placeholder="Phone number with country code (e.g. +1234567890)"
          class="flex-1 px-3 py-1.5 bg-gray-950 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-teal-500"
        />
        <button
          type="button"
          onClick={handlePair}
          disabled={pairMut.isPending || !phone.trim()}
          class="px-4 py-1.5 bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white text-sm rounded font-medium"
        >
          {pairMut.isPending ? 'Requesting...' : 'Pair Device'}
        </button>
      </div>
      {error && <p class="text-sm text-red-400">{error}</p>}
    </div>
  );
}

export function WhatsAppExtensionPage({ alias }: { alias: string }) {
  const configQuery = trpc.extension.whatsapp.getConfig.useQuery({ alias });
  return (
    <QueryView query={configQuery}>
      {(data) => <WhatsAppForm alias={alias} data={data} />}
    </QueryView>
  );
}

function WhatsAppForm({ alias, data }: { alias: string; data: WhatsAppServerData }) {
  const utils = trpc.useUtils();
  const unpair = trpc.extension.whatsapp.unpair.useMutation({
    onSuccess: () => utils.extension.whatsapp.getConfig.invalidate({ alias }),
  });

  const { form, message, formProps, submitProps } = useAdminForm({
    schema: WhatsAppFormSchema,
    values: whatsappFormInitialValues(data),
    mutation: trpc.extension.whatsapp.setConfig,
    toPayload: (v) => whatsappFormToPayload(alias, v, data),
    onSaved: () => utils.extension.whatsapp.getConfig.invalidate({ alias }),
  });

  const { config, paired, connected, chats: syncedChats } = data;
  const chatOverrides = form.watch('chatOverrides');
  const pairingHistoryDepth = form.watch('pairingHistoryDepth');
  const readMode = form.watch('readMode');
  const sendMode = form.watch('sendMode');

  const [chatSearch, setChatSearch] = useState('');
  const [newJid, setNewJid] = useState('');

  const directSetConfig = trpc.extension.whatsapp.setConfig.useMutation();

  const handleUnpair = () => {
    if (confirm('Unpair this device? The WhatsApp session will be cleared.')) {
      unpair.mutate({ alias });
    }
  };

  const setChatOverrides = (next: ChatOverrideForm[]) =>
    form.setValue('chatOverrides', next, { shouldDirty: true });

  const addChatOverride = (jid: string, name?: string) => {
    const trimmed = jid.trim();
    if (trimmed && !chatOverrides.some((o) => o.jid === trimmed)) {
      setChatOverrides([...chatOverrides, { jid: trimmed, name }]);
    }
  };

  const removeChatOverride = (index: number) => {
    setChatOverrides(chatOverrides.filter((_, i) => i !== index));
  };

  const updateChatOverride = (index: number, field: 'read' | 'send', value: '' | 'allow' | 'deny') => {
    const updated = [...chatOverrides];
    const item = updated[index];
    if (!item) return;
    const next: ChatOverrideForm = { ...item };
    if (value === '') {
      delete next[field];
    } else {
      next[field] = value;
    }
    updated[index] = next;
    setChatOverrides(updated);
  };

  const readInherit = `Inherit (${readMode})`;
  const sendInherit = `Inherit (${sendMode})`;

  return (
    <form {...formProps} class="space-y-6 max-w-lg">
      <section class="space-y-3">
        <SectionHeading>Pairing Status</SectionHeading>
        <div class="flex items-center gap-3">
          <span class={`inline-block w-2 h-2 rounded-full ${paired ? 'bg-green-500' : 'bg-red-500'}`} />
          <span class="text-sm text-gray-300">
            {paired ? 'Paired — auth session found' : 'Not paired — no auth session'}
          </span>
        </div>
        {!paired && (
          <PairingFlow
            alias={alias}
            onPaired={() => utils.extension.whatsapp.getConfig.invalidate({ alias })}
            historyDepth={pairingHistoryDepth}
            historyDepthLocked={config.pairing_history_depth?.locked}
            onSaveConfig={(updates) => directSetConfig.mutate({ alias, config: updates })}
          />
        )}
        {paired && (
          <div class="flex items-center gap-3">
            <span class="text-xs text-gray-500">
              {pairingHistoryDepth === 'extended' ? 'Extended history (~1 year)' : 'Standard history (~3 months)'}
              {connected ? ` — ${syncedChats.length} chats synced` : ''}
            </span>
            <button
              type="button"
              onClick={handleUnpair}
              disabled={unpair.isPending}
              class="px-4 py-2 bg-red-900 hover:bg-red-800 disabled:opacity-50 text-red-200 text-sm rounded font-medium"
            >
              {unpair.isPending ? 'Unpairing...' : 'Unpair Device'}
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
          helpText="Default for unclassified chats. Approval: prompts the user. Open: allowed. Disabled: blocked. Per-chat overrides below can allow/deny specific chats."
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
          helpText="Default for unclassified chats. Approval: prompts the user. Direct: sends without prompt. Disabled: blocked. Per-chat overrides below can allow/deny specific chats."
        />
      </section>

      <section class="space-y-3">
        <SectionHeading>Per-Chat Overrides</SectionHeading>
        {config.chats?.locked ? (
          <p class="text-sm text-gray-500">Chat overrides are locked by the author.</p>
        ) : (
          <>
            {chatOverrides.length > 0 && (
              <div class="space-y-2">
                {chatOverrides.map((override, i) => {
                  const displayName = override.name
                    ?? syncedChats.find((c) => c.jid === override.jid)?.name
                    ?? override.jid;
                  return (
                    <div key={override.jid} class="bg-gray-900 border border-gray-800 rounded p-3 space-y-2">
                      <div class="flex items-center justify-between">
                        <span class="text-sm text-gray-300">
                          {displayName}
                          {displayName !== override.jid && (
                            <span class="mono text-xs text-gray-600 ml-2">{override.jid.split('@')[0]}</span>
                          )}
                        </span>
                        <button
                          type="button"
                          onClick={() => removeChatOverride(i)}
                          class="text-gray-500 hover:text-red-400 text-xs"
                        >
                          Remove
                        </button>
                      </div>
                      <div class="grid grid-cols-2 gap-2">
                        <label class="text-xs text-gray-500 space-y-1">
                          <span>Read</span>
                          <select
                            value={override.read ?? ''}
                            onChange={(e) => updateChatOverride(i, 'read', (e.target as HTMLSelectElement).value as '' | 'allow' | 'deny')}
                            class="w-full px-2 py-1 bg-gray-950 border border-gray-700 rounded text-white text-xs"
                          >
                            <option value="">{readInherit}</option>
                            <option value="allow">Allow</option>
                            <option value="deny">Deny</option>
                          </select>
                        </label>
                        <label class="text-xs text-gray-500 space-y-1">
                          <span>Send</span>
                          <select
                            value={override.send ?? ''}
                            onChange={(e) => updateChatOverride(i, 'send', (e.target as HTMLSelectElement).value as '' | 'allow' | 'deny')}
                            class="w-full px-2 py-1 bg-gray-950 border border-gray-700 rounded text-white text-xs"
                          >
                            <option value="">{sendInherit}</option>
                            <option value="allow">Allow</option>
                            <option value="deny">Deny</option>
                          </select>
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            <div class="flex gap-2">
              <input
                type="text"
                value={newJid}
                onInput={(e) => setNewJid((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addChatOverride(newJid); setNewJid(''); } }}
                placeholder="JID (e.g. 1234567890@s.whatsapp.net)"
                class="flex-1 px-3 py-1.5 bg-gray-950 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-teal-500"
              />
              <button
                type="button"
                onClick={() => { addChatOverride(newJid); setNewJid(''); }}
                class="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm rounded"
              >
                Add
              </button>
            </div>
          </>
        )}
      </section>

      {syncedChats.length > 0 && !config.chats?.locked && (
        <section class="space-y-2">
          <SectionHeading>Synced Chats ({syncedChats.length})</SectionHeading>
          <p class="text-xs text-gray-500">Click a chat to add it as a per-chat override.</p>
          <input
            type="text"
            value={chatSearch}
            onInput={(e) => setChatSearch((e.target as HTMLInputElement).value)}
            placeholder="Search chats..."
            class="w-full px-3 py-1.5 bg-gray-950 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-teal-500"
          />
          <div class="space-y-1 max-h-80 overflow-y-auto">
            {syncedChats
              .filter((chat) => {
                if (!chatSearch.trim()) return true;
                const q = chatSearch.toLowerCase();
                return chat.name.toLowerCase().includes(q) || chat.jid.toLowerCase().includes(q);
              })
              .map((chat) => {
                const alreadyAdded = chatOverrides.some((o) => o.jid === chat.jid);
                return (
                  <button
                    key={chat.jid}
                    type="button"
                    disabled={alreadyAdded}
                    onClick={() => { if (!alreadyAdded) addChatOverride(chat.jid, chat.name); }}
                    class={`w-full text-left px-3 py-1.5 rounded text-sm flex items-center gap-2 ${
                      alreadyAdded
                        ? 'bg-gray-900 text-gray-600 cursor-not-allowed'
                        : 'bg-gray-900 text-gray-300 hover:bg-gray-800 cursor-pointer'
                    }`}
                  >
                    <span class={`text-xs font-medium ${chat.isGroup ? 'text-blue-400' : 'text-gray-500'}`}>
                      {chat.isGroup ? 'G' : 'U'}
                    </span>
                    <span class="truncate">{chat.name}</span>
                    {chat.name !== chat.jid && (
                      <span class="mono text-xs text-gray-600 ml-auto flex-shrink-0">{chat.jid.split('@')[0]}</span>
                    )}
                  </button>
                );
              })}
          </div>
        </section>
      )}

      <FormStatus message={message} />
      <SubmitButton submitProps={submitProps}>Save</SubmitButton>
    </form>
  );
}
