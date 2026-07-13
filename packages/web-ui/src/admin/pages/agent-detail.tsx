import { useState, useRef, useEffect, useMemo } from 'preact/hooks';
import { Link, useRoute, useLocation } from 'wouter';
import { trpc } from '../trpc';
import { ModelSelect } from '../components/model-select';
import { TimezoneSelect } from '../components/timezone-select';
import { FormStatus, SubmitButton, inputClass } from '../components/form';
import { useAdminForm } from '../hooks/use-admin-form';
import {
  TIME_RANGES,
  trashIcon,
  RefreshButton,
  DangerButton,
  FilterField,
} from '../components/log-controls';
import { ConfigFormSchema, configFormInitialValues, configFormToPayload } from '../schemas/config';
import { ProvisionsFormSchema, provisionsFormInitialValues, provisionsFormToPayload, type ProvisionsServerData } from '../schemas/provisions';
import { EmailExtensionPage } from './extensions/email';
import { WebFetchExtensionPage } from './extensions/web-fetch';
import { CalendarExtensionPage } from './extensions/calendar';
import { WhatsAppExtensionPage } from './extensions/whatsapp';
import { ServiceSecretsPage } from './extensions/service';
import { McpServersPage } from './mcp-servers';
import { TokensView } from './tokens-view';
import { AgentAvatar } from '../../lib/components/agent-avatar';
import { SCOPE_BORDER } from '../components/console-avatar';
import { ConfigureIcon, DesignIcon } from '../components/icons';
import { HelpButton } from '../components/help-button';
import { useChatSelection } from '../layout';
import type { ComponentChildren, JSX } from 'preact';
import type { AgentConfig, ChannelJsonConfig } from '@getcast/server/admin';
import type { PageManualEntry } from '@getcast/admin-schema/v1';

type AgentConfigForUi = AgentConfig;
type AgentChannelForUi = { name: string; config: ChannelJsonConfig };

// One pageManual entry per distinct tab URL. The five-tab restructure
// collapsed nine entries down to five.
export const agentOverviewManual: PageManualEntry = {
  purpose: 'Per-agent overview — read-only summary table: the agent\'s one-line description (a manifest field authored via the Design chat) plus runtime settings (model, container network, show-steps, timezone, backup schedule).',
};

export const agentBlueprintManual: PageManualEntry = {
  purpose: 'What this agent is — CTA and blueprint folder path. A curated subset of blueprint files (capabilities / channels / manifest) is hidden behind a "Show selected content" disclosure (collapsed by default). It is a *subset* — the full blueprint folder also contains identity prompts, assets, and the compiled service, none of which surface here. Most operators only need the path + CTA, not the JSON. The blueprint is authored via Design, not edited here. (The agent\'s description is a manifest field, shown on Overview.)',
  sections: [
    { anchor: 'open-design', purpose: 'CTA that opens the Design chat for this agent.', actions: ['Open Design chat'] },
    { anchor: 'path', purpose: 'On-disk absolute path to the agent\'s blueprint folder. Click to copy.', actions: ['Copy blueprint path to clipboard'] },
    { anchor: 'contents', purpose: 'Disclosure toggle. Collapsed by default; expanding reveals capabilities, channels, manifest. If a user asks about those sections, tell them to click "Show selected content" first.', actions: ['Toggle "Show selected content" disclosure'] },
    { anchor: 'capabilities', purpose: 'Raw blueprint/props/capabilities.json — declared extensions and their channel bindings. Visible only when contents are expanded.', actions: [] },
    { anchor: 'channels', purpose: 'Read-only summary of channels declared in blueprint/channels/. Visible only when contents are expanded.', actions: [] },
    { anchor: 'manifest', purpose: 'Raw manifest.json — agent provenance: spec version, name, pubkey, plus any extra fields tooling has added. Visible only when contents are expanded.', actions: [] },
  ],
};

export const agentSettingsManual: PageManualEntry = {
  purpose: 'Operational configuration for the agent — runtime knobs, operator provisions, lifecycle override, and the archive action. Channels (blueprint-static) live under Blueprint.',
  sections: [
    { anchor: 'runtime', purpose: 'config/agent.json: model override, container network mode, allowed endpoints, max conversations, timezone.', actions: ['Change model override', 'Change container network mode (sdk-only / full / none)', 'Edit allowed outbound endpoints'] },
    { anchor: 'provisions', purpose: 'config/provisions.json: resource path bindings, extra pip packages, additional disabled tools.', actions: ['Bind a host path to a resource slot', 'Add extra pip packages (if the agent unlocks extra_packages)', 'Extend additional_disabled_tools'] },
    { anchor: 'lifecycle', purpose: 'Manual lifecycle override — flip draft ↔ ready directly without routing through Security Manager. Escape hatch for the conversational Request review flow.', actions: ['Make live (skip review)', 'Move back to draft'] },
    { anchor: 'archive', purpose: 'Danger zone — archive (zips folder to mnt/.trash/ — recoverable).', actions: ['Archive the agent'] },
  ],
};

export const agentAccessManual: PageManualEntry = {
  purpose: 'Who can talk to this agent — the owner, pending approvals routed to you, and the per-identity grants. Anchors target the sub-areas.',
  sections: [
    { anchor: 'owner', purpose: 'Current owner identity. `operator` (the default) means access requests are approved by you, here, in the Pending approvals section below. To hand the agent to a person, generate a one-time claim code and give it to them out-of-band — they redeem it by messaging the agent `/claim <code>`, which binds their verified identity as owner. A name in the roster is not proof of identity, so designation goes through the code, not a direct pick. Revert returns ownership to you.', actions: ['Generate a claim code (designate a human owner)', 'Revert ownership to operator'] },
    { anchor: 'approvals', purpose: 'Pending access requests visible to you. Each is a peer the agent tried to reach that is not yet granted. Approve or reject, once (one-shot) or always (writes a standing grant/tombstone into config/acl.json). When the agent has a human owner, their requests also surface here as a backstop — you and the owner both see them, and whoever answers first wins. A message edge (`io`) offers a single Approve that always writes the standing grant — a conversation reply needs it or it bounces on outbound, so approve-once is dropped there.', actions: ['Approve a message edge (io) — grants a standing edge so replies flow', 'Approve once (release this one request — q/r/a only)', 'Approve always (grant a standing edge)', 'Reject once (decline this request)', 'Reject always (tombstone — hard-deny future asks)'] },
    { anchor: 'agent-peers', purpose: 'Channel-scoped grants to other agents on this server, from config/acl.json. Revoke removes a grant (the peer becomes askable again). Adding grants happens by chatting with this agent\'s Configure.', actions: ['Revoke a peer grant (plain remove — returns the peer to askable)'] },
    { anchor: 'users', purpose: 'Channel-scoped grants to user identities, from config/acl.json. Revoke removes a grant (the user becomes askable again). Adding grants happens by chatting with this agent\'s Configure.', actions: ['Revoke a user grant (plain remove — returns the user to askable)'] },
  ],
};

export const agentCapabilitiesManual: PageManualEntry = {
  purpose: 'External services and tools the agent can use — split into two subtabs: Extensions (email, web-fetch, calendar, whatsapp) and MCP servers. Default subtab is Extensions. Per-extension drill-in: /capabilities/extensions/<ext>.',
  sections: [
    { anchor: 'extensions', purpose: 'Default subtab. Extensions enabled on this agent. Click into one to manage credentials and config. A Service card appears when the agent has a service process — it shows the service status, a Restart control, and any declared settings/credentials.', actions: [] },
    { anchor: 'mcp-servers', purpose: 'Subtab. External MCP servers wired into this agent. Operator fills env values for slots declared by the blueprint.', actions: ['Fill a per-server env value (form is the canonical secret-write path, not chat)'] },
  ],
};

export const agentActivityManual: PageManualEntry = {
  purpose: 'What the agent has been doing — active conversations, the event log (errors, warnings, lifecycle markers), and token-usage telemetry.',
  sections: [
    { anchor: 'conversations', purpose: 'Active conversations: participant, channel, last activity, status.', actions: ['Refresh to pick up new conversations'] },
    { anchor: 'events', purpose: 'Event log from state/agent.db. Filter by level, component, or time window. Triage failures or confirm scheduler/service actions fired.', actions: ['Filter by level (error / warn / info)', 'Filter by component', 'Filter by time window (last hour / 24h / 7d / all time)', 'Load more (paginates by 50, max 500)', 'Clear log (destructive — confirm dialog)'] },
    { anchor: 'tokens', purpose: 'Token-usage telemetry per SDK result, rolled up daily by (conversation, channel, phase, model). Shows input/output/cache-creation/cache-read counters and the SDK\'s list-price cost_usd. Cost is computed at Anthropic API list prices — informational, not the operator\'s actual bill on subscriptions, Bedrock, Vertex, or negotiated rates.', actions: ['Pick a range (today / 7 / 30 / 90 days / all time)', 'Refresh to pull latest counters', 'Read totals across all rows in range from the summary cards', 'Drill into per-day or per-conversation breakdowns'] },
  ],
};

// Per-agent Design + Configure chat surfaces live in the right rail; the
// agent-detail page hosts forms + a Blueprint tab.
//
// Tab structure:
//   /agents/<alias>                      → Overview (description + runtime summary)
//   /agents/<alias>/blueprint            → Blueprint (CTA, channels, on-disk path)
//   /agents/<alias>/settings             → Settings (runtime + provisions + danger zone)
//   /agents/<alias>/access               → Access (owner, peers, granted users)
//   /agents/<alias>/capabilities         → Capabilities (extensions + mcp servers)
//   /agents/<alias>/capabilities/<ext>   → drills into a specific extension page
//   /agents/<alias>/activity             → Activity (conversations + events log sub-tabs)
//
// Blueprint exists to anchor the *artifact* the Design chat produces. Without
// it the admin UI reads as pure config and the design/configure split is
// invisible. It's intentionally read-only — edits route to the Design chat.
//
// Old per-tab URLs (provisions, channels, connections, extensions, mcp-servers,
// conversations, events) redirect into the new structure on mount.

type Tab = 'overview' | 'blueprint' | 'settings' | 'access' | 'capabilities' | 'activity';
const TAB_NAMES: ReadonlySet<Tab> = new Set([
  'overview', 'blueprint', 'settings', 'access', 'capabilities', 'activity',
]);

/**
 * Old `/agents/:alias/<tab>` URLs that map onto a merged tab. Subtab from
 * the original URL is preserved (e.g. /extensions/email → /capabilities/email).
 * If a value is `[tab, subtab]`, that subtab is forced (e.g. /events lands
 * on the activity tab's events sub-tab, not the default tokens).
 */
const LEGACY_TAB_REDIRECT: Record<string, Tab | [Tab, string]> = {
  provisions: 'settings',
  channels: 'blueprint',
  conversations: ['activity', 'conversations'],
  events: ['activity', 'events'],
  connections: 'access',
  // /extensions[/<ext>] and /mcp-servers are handled inline in the
  // redirect effect below — they need to land under the new
  // /capabilities/<subtab>[/<ext>] structure, which the simple
  // [Tab, subtab] form can't express.
};

function TabLink({ tab, current, alias, children, badge }: {
  tab: Tab;
  current: Tab;
  alias: string;
  children: string;
  badge?: number;
}) {
  const href = tab === 'overview' ? `/agents/${alias}` : `/agents/${alias}/${tab}`;
  return (
    <Link
      href={href}
      class={`flex flex-1 items-center justify-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md transition-colors ${
        current === tab
          ? 'bg-blue-600 text-white'
          : 'text-gray-400 hover:text-white hover:bg-gray-800'
      }`}
    >
      {children}
      {badge != null && badge > 0 && (
        <span class="bg-red-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[18px] text-center leading-none">
          {badge}
        </span>
      )}
    </Link>
  );
}

// Two role-tinted pills for opening Design / Configure chat from the
// agent header. Mirrors the sidebar's per-agent verb tiles — clicking
// docks/closes the chat, and Layout's shared selection state keeps
// both surfaces visually in sync.
function ChatVerbPills({ alias }: { alias: string }) {
  const { currentChat, setOrToggleChat } = useChatSelection();
  const activeMode = currentChat?.kind === 'agent' && currentChat.alias === alias
    ? currentChat.mode
    : null;
  return (
    <div class="flex items-center gap-1.5">
      <VerbPill
        role="design"
        label="Design"
        active={activeMode === 'design'}
        onClick={() => setOrToggleChat({ kind: 'agent', alias, mode: 'design' })}
      />
      <VerbPill
        role="configure"
        label="Configure"
        active={activeMode === 'configure'}
        onClick={() => setOrToggleChat({ kind: 'agent', alias, mode: 'configure' })}
      />
    </div>
  );
}

function VerbPill({
  role,
  label,
  active,
  onClick,
}: {
  role: 'design' | 'configure';
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  const Icon = role === 'design' ? DesignIcon : ConfigureIcon;
  // Active = role tint + glow; inactive = subdued gray. Tones mirror
  // the sidebar tile vocabulary so a Design pill on the page reads as
  // the same control as a Design tile in the sidebar.
  const tone = active
    ? role === 'design'
      ? 'bg-sky-500 text-white shadow-[0_0_10px_rgba(14,165,233,0.45)]'
      : 'bg-amber-600 text-white shadow-[0_0_10px_rgba(245,158,11,0.45)]'
    : 'bg-gray-800 text-gray-300 hover:text-white hover:bg-gray-700';
  return (
    <button
      type="button"
      onClick={onClick}
      class={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${tone}`}
      title={active ? `Close ${label} chat` : `Open ${label} chat`}
    >
      <Icon class="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

/**
 * Wouter has no native depth-tolerant route matching, so the agent detail
 * URL (1–4 path segments after `/agents/`) needs four `useRoute` calls
 * merged in priority order. The 4-segment form supports drill-ins under
 * subtabbed parents (e.g. /capabilities/extensions/email).
 */
function useAgentRouteParams(): { alias: string; tab: string | undefined; subtab: string | null; nested: string | null } {
  const [, p4] = useRoute('/agents/:alias/:tab/:subtab/:nested');
  const [, p3] = useRoute('/agents/:alias/:tab/:subtab');
  const [, p2] = useRoute('/agents/:alias/:tab');
  const [, p1] = useRoute('/agents/:alias');
  const p = (p4 ?? p3 ?? p2 ?? p1 ?? {}) as Record<string, string | undefined>;
  return {
    alias: p.alias ?? '',
    tab: p.tab,
    subtab: p.subtab ?? null,
    nested: p.nested ?? null,
  };
}

export function AgentDetailPage() {
  const { alias, tab: rawTab, subtab, nested } = useAgentRouteParams();
  const [, navigate] = useLocation();

  // Redirect inbound URLs to the canonical tab structure. Chat surfaces
  // live in the right rail; single-purpose tabs (provisions, channels,
  // access, etc.) collapse into thematic tabs. Subtabs are preserved so
  // deep-links like `/agents/foo/extensions/email` still drill in.
  useEffect(() => {
    if (!rawTab) return;
    if (rawTab === 'design' || rawTab === 'configure') {
      navigate(`/agents/${alias}`);
      return;
    }
    if (rawTab === 'config') {
      navigate(`/agents/${alias}/settings`);
      return;
    }
    // /extensions[/<ext>] → /capabilities/extensions[/<ext>]
    if (rawTab === 'extensions') {
      navigate(`/agents/${alias}/capabilities/extensions${subtab ? `/${subtab}` : ''}`);
      return;
    }
    // /mcp-servers → /capabilities/mcp-servers
    if (rawTab === 'mcp-servers') {
      navigate(`/agents/${alias}/capabilities/mcp-servers`);
      return;
    }
    // /capabilities/<ext> → /capabilities/extensions/<ext>. Skip if subtab
    // is already a known subtab name.
    if (
      rawTab === 'capabilities'
      && subtab
      && subtab !== 'extensions'
      && subtab !== 'mcp-servers'
    ) {
      navigate(`/agents/${alias}/capabilities/extensions/${subtab}`);
      return;
    }
    const entry = LEGACY_TAB_REDIRECT[rawTab];
    if (entry) {
      const [destTab, forcedSubtab] = Array.isArray(entry) ? entry : [entry, undefined];
      const tail = forcedSubtab ?? subtab;
      navigate(`/agents/${alias}/${destTab}${tail ? `/${tail}` : ''}`);
    }
  }, [rawTab, subtab, alias, navigate]);

  const activeTab: Tab = rawTab && TAB_NAMES.has(rawTab as Tab) ? (rawTab as Tab) : 'overview';

  // Per-agent chat (Author / Operate) lives in Layout — hoisted so the
  // bottom drawer can dock as a flex sibling of <main>'s scrollable area
  // and span the full middle column. agent-detail just renders forms.

  const utils = trpc.useUtils();
  const agent = trpc.agent.get.useQuery({ alias }, { enabled: !!alias });
  // Pending-approval count for the Access tab badge. Polled (no SSE push for
  // agent.db state) so the badge stays current across tabs; the AccessTab
  // reuses this same query key, so there is one poll, not two.
  const pendingApprovals = trpc.agent.listPendingApprovals.useQuery(
    { alias },
    { enabled: !!alias, refetchInterval: 15000, refetchOnWindowFocus: true },
  );
  const { sendToSecurityManager } = useChatSelection();
  const requestReview = trpc.agent.requestReview.useMutation({
    onSuccess: async ({ text }) => {
      await sendToSecurityManager(text);
      utils.agent.get.invalidate({ alias });
    },
  });

  // Reconcile sidebar staleness: when `agent.get` returns a status that
  // disagrees with what `agent.list` currently has cached for this alias
  // (e.g. SM finalized the agent from draft → ready while the user was on
  // this page), invalidate `agent.list` so the sidebar's draft chip clears.
  // No SSE event needed — the disagreement *is* the signal.
  useEffect(() => {
    if (!agent.data) return;
    const list = utils.agent.list.getData();
    const cached = list?.find((a) => a.alias === alias);
    if (cached && cached.status !== agent.data.status) {
      utils.agent.list.invalidate();
    }
  }, [agent.data?.status, alias, utils]);

  if (!alias) return <p class="text-gray-500">No agent selected.</p>;
  if (agent.isLoading) return <p class="text-gray-500 text-sm">Loading...</p>;
  if (agent.error) return <p class="text-red-400 text-sm">Error: {agent.error.message}</p>;
  if (!agent.data) return <p class="text-gray-500 text-sm">Agent not found.</p>;

  const isDraft = agent.data.status === 'draft';

  return (
    <div class="space-y-6">
      {isDraft && (
        <div class="px-4 py-2.5 bg-amber-900/20 border border-amber-700/30 rounded-lg text-sm text-amber-200 flex items-center gap-3">
          <span class="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
          <span class="flex-1">
            This agent is a draft — still being composed. Use Design to edit it.
            {' '}<span class="text-amber-300/70">Review will check the agent and confirm with you in chat before going live.</span>
          </span>
          <button
            onClick={() => {
              if (confirm(`Send ${alias} to Review? All-Agents Review will read the agent, walk you through anything noteworthy, and finalize it live on your approval. The agent stays in draft until Review finalizes it.`)) {
                requestReview.mutate({ alias });
              }
            }}
            disabled={requestReview.isPending}
            class="shrink-0 px-3 py-1 text-xs font-medium text-amber-100 bg-amber-700/40 hover:bg-amber-700/60 border border-amber-600/40 rounded-md transition-colors disabled:opacity-50"
          >
            {requestReview.isPending ? 'Sending...' : 'Request review'}
          </button>
        </div>
      )}
      <div class="flex items-center justify-between">
        <div class={`flex items-center gap-3 pl-3 border-l-[3px] ${SCOPE_BORDER.agent}`}>
          <AgentAvatar alias={alias} size="md" active />
          <div>
            <div class="flex items-center gap-2">
              <h1 class="text-lg font-semibold text-white">{alias}</h1>
              {isDraft && (
                <span class="px-2 py-0.5 text-xs font-medium bg-amber-800/40 text-amber-200 rounded-full">
                  draft
                </span>
              )}
            </div>
            <p class="mono text-sm text-gray-500 mt-0.5">{agent.data.address}</p>
          </div>
        </div>
        <div class="flex items-center gap-3">
          {/* Per-agent chat verb pills — duplicate of the sidebar
              expansion's tiles, but reachable without leaving main.
              Click toggles the chat docked/closed; both surfaces
              stay in sync because Layout owns currentChat. */}
          <ChatVerbPills alias={alias} />
        </div>
      </div>

      {/* Form tab bar — six tabs sharing the row width equally. Blueprint
          sits between Overview and Settings: identity → design artifact →
          operational config. */}
      <div class="flex gap-1 bg-gray-900 rounded-lg p-1">
        <TabLink tab="overview" current={activeTab} alias={alias}>Overview</TabLink>
        <TabLink tab="blueprint" current={activeTab} alias={alias}>Blueprint</TabLink>
        <TabLink tab="settings" current={activeTab} alias={alias}>Settings</TabLink>
        <TabLink tab="access" current={activeTab} alias={alias} badge={pendingApprovals.data?.length}>Access</TabLink>
        <TabLink tab="capabilities" current={activeTab} alias={alias}>Capabilities</TabLink>
        <TabLink tab="activity" current={activeTab} alias={alias}>Activity</TabLink>
      </div>

      {activeTab === 'overview' && <OverviewTab config={agent.data.config} description={agent.data.description} />}
      {activeTab === 'blueprint' && (
        <BlueprintTab
          alias={alias}
          channels={agent.data.channels}
          blueprintPath={agent.data.blueprintPath}
          manifest={agent.data.manifest}
          capabilities={agent.data.capabilities}
        />
      )}
      {activeTab === 'settings' && (
        <div class="space-y-10">
          <Section id="runtime" title="Runtime" action={<HelpButton anchor="runtime" />}>
            <ConfigTab alias={alias} config={agent.data.config} />
          </Section>
          <Section id="provisions" title="Provisions" action={<HelpButton anchor="provisions" />}>
            <ProvisionsTab alias={alias} />
          </Section>
          <Section id="lifecycle" title="Lifecycle" action={<HelpButton anchor="lifecycle" label="Lifecycle" />}>
            <LifecycleSection alias={alias} isDraft={isDraft} />
          </Section>
          <Section id="archive" title="Danger zone" action={<HelpButton anchor="archive" label="Danger zone" />}>
            <ArchiveSection alias={alias} />
          </Section>
        </div>
      )}
      {activeTab === 'access' && <AccessTab alias={alias} />}
      {activeTab === 'capabilities' && <CapabilitiesTab alias={alias} subtab={subtab} nested={nested} />}
      {activeTab === 'activity' && <ActivityTab alias={alias} subtab={subtab} />}
    </div>
  );
}

/**
 * Section wrapper for stacking sub-views in a single tab.
 *
 * Header is sticky to the top of the scrolling main column, so the operator
 * always knows which section they're in as the page scrolls. Body has no
 * card chrome — visual identity comes from the header alone, not from a box
 * around the content. Field-grouping cards inside child components should be
 * reserved for list items and tables, never to mark a section.
 *
 * The `top-{n}` value matches the height the agent-detail header (avatar +
 * tab bar) consumes; tweak if that header height changes.
 */
function Section({ id, title, action, children }: { id: string; title: string; action?: JSX.Element; children: ComponentChildren }) {
  return (
    <section id={id} class="scroll-mt-24">
      <div class="sticky top-0 z-10 -mx-2 px-2 py-2 mb-4 flex items-center justify-between bg-gray-950/95 backdrop-blur-sm border-b border-gray-800/60">
        <h2 class="text-xs font-semibold text-gray-300 uppercase tracking-wider">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}


function OverviewTab({ config, description }: { config: AgentConfigForUi; description: string | null }) {
  const backup = config.backup;
  const endpoints = config.containerAllowedEndpoints;

  // `helpful` rows get an inline (i) — labels that name jargon (Container
  // Network), opaque toggles (Show Steps), or compound tuples whose parts
  // aren't self-explaining (Backup). Self-evident rows skip it.
  type Row = { label: string; value: string; helpful?: boolean };
  const rows: Row[] = [
    ...(description ? [{ label: 'Description', value: description }] : []),
    { label: 'Model', value: config.model ?? 'default' },
    { label: 'Container Network', value: config.containerNetwork ?? 'sdk-only', helpful: true },
    ...(endpoints && endpoints.length > 0 ? [{ label: 'Allowed Endpoints', value: endpoints.join(', ') }] : []),
    { label: 'Show Steps (production)', value: config.showSteps === false ? 'off' : 'on', helpful: true },
    { label: 'Show Steps (Design & Configure)', value: config.showConsoleSteps === false ? 'off' : 'on', helpful: true },
    { label: 'Timezone', value: config.timezone ?? 'server default' },
    {
      label: 'Backup',
      value: backup
        ? `keep ${backup.retain}, at ${String(backup.hour).padStart(2, '0')}:00 UTC`
        : 'disabled',
      helpful: true,
    },
  ];

  return (
    <div class="space-y-4">
      <div class="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        {rows.map(({ label, value, helpful }, i) => (
          <div key={label} class={`flex justify-between items-center px-5 py-3 text-sm ${i > 0 ? 'border-t border-gray-800/50' : ''}`}>
            <span class="flex items-center gap-2 text-gray-400 font-medium">
              {label}
              {helpful && <HelpButton label={label} />}
            </span>
            <span class="text-gray-100">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Blueprint — read-only summary of what the agent *is* + a CTA to the
 * Design chat. Anchors the design/configure split visually so operators
 * understand there's an artifact behind the Design conversation.
 *
 * Edits never happen here; the blueprint is unstructured (a folder of
 * files) and authored through conversation. The on-disk path is shown
 * verbatim — a future pass can replace it with an in-page file/folder
 * viewer.
 */
function BlueprintTab({
  alias,
  channels,
  blueprintPath,
  manifest,
  capabilities,
}: {
  alias: string;
  channels: AgentChannelForUi[];
  blueprintPath: string;
  manifest: unknown;
  capabilities: unknown;
}) {
  const { setOrToggleChat } = useChatSelection();
  // Blueprint contents (capabilities / channels / manifest) collapse behind a
  // disclosure so the regular operator lands on the path + CTA, not on JSON.
  // Defaults to collapsed every visit — no persistence — to reinforce that
  // peeking inside is the rare detour, not the normal landing state.
  const [showContents, setShowContents] = useState(false);
  return (
    <div class="space-y-8">
      {/* Top info/CTA — anchors the page so operators land on the design
          framing first, before any content. */}
      <section id="open-design" class="bg-sky-900/15 border border-sky-700/30 rounded-lg p-5 flex items-start gap-4">
        <DesignIcon class="w-5 h-5 text-sky-400 mt-0.5 shrink-0" />
        <div class="flex-1 min-w-0">
          <h3 class="text-sm font-semibold text-sky-100 mb-1">The blueprint is what this agent is</h3>
          <p class="text-sm text-sky-200/80 leading-relaxed mb-3">
            Prompts, channels, props, and declared capabilities. It's authored through
            conversation, not forms — open the <strong>Design</strong> chat to view or change it.
            The source files live in the blueprint folder below.
          </p>
          <button
            type="button"
            onClick={() => setOrToggleChat({ kind: 'agent', alias, mode: 'design' })}
            class="inline-flex items-center gap-2 px-3 py-1.5 bg-sky-500 hover:bg-sky-400 text-white text-sm font-medium rounded-md transition-colors shadow-[0_0_10px_rgba(14,165,233,0.45)]"
          >
            <DesignIcon class="w-4 h-4" />
            Open Design chat
          </button>
        </div>
      </section>

      <section id="path">
        <h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Blueprint folder</h3>
        <CopyablePath path={blueprintPath} />
      </section>

      <section id="contents">
        <button
          type="button"
          onClick={() => setShowContents((s) => !s)}
          class="w-full flex items-center justify-between gap-3 px-4 py-2.5 text-left text-xs font-medium text-gray-400 hover:text-gray-200 hover:bg-gray-900/60 rounded-md transition-colors"
          aria-expanded={showContents}
        >
          <span>{showContents ? 'Hide selected content' : 'Show selected content'}</span>
          <svg
            class={`w-4 h-4 shrink-0 transition-transform ${showContents ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
          </svg>
        </button>

        {showContents && (
          <div class="mt-6 space-y-8">
            {capabilities != null && (
              <section id="capabilities">
                <h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                  Capabilities <span class="ml-2 font-mono text-gray-600 normal-case tracking-normal">props/capabilities.json</span>
                </h3>
                <JsonBlock value={capabilities} />
              </section>
            )}

            <section id="channels">
              <h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                Channels <span class="ml-2 font-mono text-gray-600 normal-case tracking-normal">channels/</span>
              </h3>
              <ChannelsTab channels={channels} />
            </section>

            {manifest != null && (
              <section id="manifest">
                <h3 class="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">
                  Manifest <span class="ml-2 font-mono text-gray-600 normal-case tracking-normal">manifest.json</span>
                </h3>
                <JsonBlock value={manifest} />
              </section>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

/** Pretty-printed JSON in a scrollable monospace block. Used for raw
 *  blueprint files (capabilities, manifest) where the structure itself
 *  is what the operator wants to see. */
function JsonBlock({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2);
  return (
    <pre class="bg-gray-900 border border-gray-800 rounded-lg p-4 text-xs font-mono text-gray-200 leading-relaxed overflow-x-auto whitespace-pre">
      {text}
    </pre>
  );
}

/**
 * Display an on-disk path as a click-to-copy chip. Browsers won't let
 * an http(s) page navigate to file://, so copy-to-clipboard is the most
 * useful affordance — the operator pastes it into Finder/terminal.
 */
function CopyablePath({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied (insecure context, permission, etc.) — silently no-op.
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      class="group w-full flex items-center justify-between gap-3 px-5 py-3 bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-lg text-left transition-colors"
      title="Click to copy"
    >
      <code class="font-mono text-xs text-gray-200 break-all">{path}</code>
      <span class={`text-xs font-medium shrink-0 ${copied ? 'text-emerald-400' : 'text-gray-500 group-hover:text-gray-300'}`}>
        {copied ? 'Copied' : 'Copy'}
      </span>
    </button>
  );
}

function ConfigTab({ alias, config }: { alias: string; config: AgentConfigForUi }) {
  const utils = trpc.useUtils();
  const { form, message, formProps, submitProps } = useAdminForm({
    schema: ConfigFormSchema,
    values: configFormInitialValues(config),
    mutation: trpc.agent.updateConfig,
    toPayload: (v) => configFormToPayload(alias, v),
    successText: 'Config saved',
    onSaved: () => utils.agent.get.invalidate({ alias }),
  });

  const containerNetwork = form.watch('containerNetwork');
  const showSteps = form.watch('showSteps');
  const showConsoleSteps = form.watch('showConsoleSteps');
  const backupEnabled = form.watch('backupEnabled');

  return (
    <form {...formProps} class="space-y-4 max-w-md">
      <div>
        <label class="block text-sm text-gray-400 mb-1">Model</label>
        <ModelSelect
          value={form.watch('model')}
          onChange={(v) => form.setValue('model', v, { shouldDirty: true })}
          allowEmpty
          emptyLabel="Default (SDK default)"
          class={inputClass}
        />
      </div>

      <div>
        <label class="flex items-center gap-2 text-sm text-gray-400 mb-1">
          Container Network
          <HelpButton label="Container Network" />
        </label>
        <select {...form.register('containerNetwork')} class={inputClass}>
          <option value="sdk-only">sdk-only</option>
          <option value="full">full</option>
          <option value="none">none</option>
        </select>
      </div>

      {containerNetwork === 'sdk-only' && (
        <div>
          <label class="flex items-center gap-2 text-sm text-gray-400 mb-1">
            Allowed Endpoints
            <HelpButton label="Allowed Endpoints" />
          </label>
          <input type="text" {...form.register('allowedEndpoints')}
            placeholder="domain:port, domain:port" class={inputClass} />
          <p class="text-xs text-gray-500 mt-1">Comma-separated domain:port pairs reachable from container</p>
        </div>
      )}

      <div class="flex items-center justify-between">
        <label class="flex items-center gap-2 text-sm text-gray-400">
          Show Steps (production)
          <HelpButton label="Show Steps (production)" />
        </label>
        <button type="button"
          onClick={() => form.setValue('showSteps', !showSteps, { shouldDirty: true })}
          class={`w-10 h-5 rounded-full transition-colors ${showSteps ? 'bg-teal-600' : 'bg-gray-700'}`}>
          <span class={`block w-4 h-4 bg-white rounded-full transition-transform mx-0.5 ${showSteps ? 'translate-x-5' : ''}`} />
        </button>
      </div>

      <div class="flex items-center justify-between">
        <label class="flex items-center gap-2 text-sm text-gray-400">
          Show Steps (Design & Configure)
          <HelpButton label="Show Steps (Design & Configure)" />
        </label>
        <button type="button"
          onClick={() => form.setValue('showConsoleSteps', !showConsoleSteps, { shouldDirty: true })}
          class={`w-10 h-5 rounded-full transition-colors ${showConsoleSteps ? 'bg-teal-600' : 'bg-gray-700'}`}>
          <span class={`block w-4 h-4 bg-white rounded-full transition-transform mx-0.5 ${showConsoleSteps ? 'translate-x-5' : ''}`} />
        </button>
      </div>

      <div>
        <label class="block text-sm text-gray-400 mb-1">Timezone</label>
        <TimezoneSelect
          value={form.watch('timezone')}
          onChange={(v) => form.setValue('timezone', v, { shouldDirty: true })}
          class={inputClass}
        />
      </div>

      <fieldset class="space-y-3">
        <div class="flex items-center justify-between">
          <label class="flex items-center gap-2 text-sm text-gray-400">
            Backup
            <HelpButton label="Backup" />
          </label>
          <button type="button"
            onClick={() => form.setValue('backupEnabled', !backupEnabled, { shouldDirty: true })}
            class={`w-10 h-5 rounded-full transition-colors ${backupEnabled ? 'bg-teal-600' : 'bg-gray-700'}`}>
            <span class={`block w-4 h-4 bg-white rounded-full transition-transform mx-0.5 ${backupEnabled ? 'translate-x-5' : ''}`} />
          </button>
        </div>
        {backupEnabled && (
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs text-gray-500 mb-1">Retain</label>
              <input type="number" {...form.register('backupRetain')} min="1" class={inputClass} />
            </div>
            <div>
              <label class="block text-xs text-gray-500 mb-1">Hour (UTC)</label>
              <input type="number" {...form.register('backupHour')} min="0" max="23" class={inputClass} />
            </div>
          </div>
        )}
      </fieldset>

      <FormStatus message={message} />
      <SubmitButton submitProps={submitProps}>Save</SubmitButton>
    </form>
  );
}

// Lifecycle override — mechanical escape hatch. Skips Security Manager
// entirely: flips manifest.status directly. Default path for draft → ready
// is the amber banner's Request review button (routes through SM). Default
// path for ready → draft is also here OR via Design's design__revert_to_draft.
function LifecycleSection({ alias, isDraft }: { alias: string; isDraft: boolean }) {
  const utils = trpc.useUtils();
  const [err, setErr] = useState<string | null>(null);

  const setLifecycle = trpc.agent.setLifecycle.useMutation({
    onSuccess: () => {
      setErr(null);
      void utils.agent.get.invalidate({ alias });
      void utils.agent.list.invalidate();
    },
    onError: (e) => setErr(e.message),
  });

  return (
    <div class="bg-gray-900 border border-gray-800 rounded p-4 max-w-md space-y-3">
      <p class="text-xs text-gray-500">
        The default path for going live is the <span class="text-gray-300">Request review</span> banner —
        Review checks the agent and confirms with you in chat before flipping it live. This block is the
        manual override: it flips <span class="font-mono">manifest.status</span> directly and writes
        <span class="font-mono"> via: manual_override</span> to the audit log. Use only when Review is
        unavailable, or you've reviewed the agent externally.
      </p>
      {isDraft ? (
        <button
          type="button"
          onClick={() => {
            if (confirm(`Make ${alias} live, skipping Security Review? Use only if Review is unavailable, or you've reviewed externally. Audit row will show via: manual_override.`)) {
              setLifecycle.mutate({ alias, status: 'ready' });
            }
          }}
          disabled={setLifecycle.isPending}
          class="px-3 py-1.5 text-sm font-medium text-amber-100 bg-amber-900/30 hover:bg-amber-900/50 border border-amber-700/40 rounded transition-colors disabled:opacity-50"
        >
          {setLifecycle.isPending ? 'Flipping…' : 'Make live (skip review)'}
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            if (confirm(`Pull ${alias} off live traffic and return it to draft? Transport users and peer agents will be bounced with "not yet ready" until it's finalized again. No review needed.`)) {
              setLifecycle.mutate({ alias, status: 'draft' });
            }
          }}
          disabled={setLifecycle.isPending}
          class="px-3 py-1.5 text-sm font-medium text-gray-200 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded transition-colors disabled:opacity-50"
        >
          {setLifecycle.isPending ? 'Reverting…' : 'Move back to draft'}
        </button>
      )}
      {err && <div class="text-xs text-red-400">{err}</div>}
    </div>
  );
}

// Danger zone — archive the agent. Operator-only, destructive but
// recoverable: agent.archive zips the folder to mnt/.trash/ and
// unregisters routing. Recovery is a manual unzip + server restart.
function ArchiveSection({ alias }: { alias: string }) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const archive = trpc.agent.archive.useMutation({
    onSuccess: async () => {
      await utils.agent.list.invalidate();
      navigate('/agents');
    },
    onError: (e) => setErr(e.message),
  });

  return (
    <div class="bg-gray-900 border border-rose-900/40 rounded p-4 max-w-md space-y-3">
      <div>
        <h3 class="text-sm font-semibold text-rose-200">Archive agent</h3>
        <p class="text-xs text-gray-500 mt-1">
          Zips the agent folder to <span class="font-mono">mnt/.trash/</span>, unregisters
          routing, and stops any running container. Recoverable by manually unzipping the
          archive and restarting the server.
        </p>
      </div>
      <button
        type="button"
        onClick={() => { setConfirming(true); setErr(null); setConfirmText(''); }}
        class="px-3 py-1.5 text-sm font-medium text-rose-200 bg-rose-900/30 hover:bg-rose-900/50 border border-rose-700/40 rounded transition-colors"
      >
        Archive {alias}…
      </button>

      {confirming && (
        <div
          class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setConfirming(false); }}
        >
          <div class="bg-gray-900 border border-gray-800 rounded-lg p-6 w-full max-w-md space-y-4">
            <div>
              <h2 class="text-white font-semibold">Archive {alias}?</h2>
              <p class="text-xs text-gray-500 mt-1">
                Type <span class="font-mono text-rose-300">{alias}</span> to confirm.
              </p>
            </div>
            <input
              type="text"
              value={confirmText}
              onInput={(e) => setConfirmText((e.currentTarget as HTMLInputElement).value)}
              autoFocus
              class="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded text-white text-sm font-mono placeholder-gray-500 focus:outline-none focus:border-rose-500"
            />
            {err && <div class="text-xs text-red-400">{err}</div>}
            <div class="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                class="px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-800 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={confirmText !== alias || archive.isPending}
                onClick={() => archive.mutate({ alias })}
                class="px-3 py-1.5 text-sm font-medium text-white bg-rose-700 hover:bg-rose-600 rounded disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {archive.isPending ? 'Archiving…' : 'Archive'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProvisionsTab({ alias }: { alias: string }) {
  const provisions = trpc.agent.getProvisions.useQuery({ alias });
  const schedule = trpc.agent.getSchedule.useQuery({ alias });

  if (provisions.isLoading) return <p class="text-gray-500 text-sm">Loading...</p>;
  if (!provisions.data) return <p class="text-gray-500 text-sm">No capabilities declared.</p>;

  return <ProvisionsForm alias={alias} data={provisions.data} schedule={schedule.data ?? []} />;
}

interface ScheduleEntry { cron: string | null; raw: string; channel: string | null; message: string | null }

function ProvisionsForm({ alias, data, schedule }: {
  alias: string;
  data: ProvisionsServerData;
  schedule: ScheduleEntry[];
}) {
  const utils = trpc.useUtils();
  const { form, message, formProps, submitProps } = useAdminForm({
    schema: ProvisionsFormSchema,
    values: provisionsFormInitialValues(data),
    mutation: trpc.agent.updateProvisions,
    toPayload: (v) => provisionsFormToPayload(alias, v, data),
    successText: 'Provisions saved',
    onSaved: () => utils.agent.getProvisions.invalidate({ alias }),
  });

  const hasEditable = data.resources.length > 0 || data.pip?.extraPackagesUnlocked || data.additionalDisabledTools.unlocked;

  const missingRequired = data.resources.filter((r) => r.required && !r.provisionedPath);

  // Sub-blocks (Resources, Pip, Disabled tools, Schedule) are field groups
  // inside one logical Provisions section — not nested sections. We just
  // label them inline and let the outer Section header do the section work.
  return (
    <form {...formProps} class="space-y-6">
      {missingRequired.length > 0 && (
        <div class="bg-amber-950/40 border border-amber-900 rounded p-3 text-sm text-amber-200 max-w-md">
          {missingRequired.length} required resource slot{missingRequired.length === 1 ? '' : 's'} need a host path:{' '}
          <span class="text-amber-100 font-mono">{missingRequired.map((r) => r.name).join(', ')}</span>. The agent runs without it, but <code class="text-amber-100">/resources/&lt;name&gt;</code> won't exist inside the container.
        </div>
      )}
      {data.resources.length > 0 && (
        <div class="space-y-2 max-w-md">
          <label class="flex items-center gap-2 text-xs font-medium text-gray-500 uppercase tracking-wider">
            Resources
            <HelpButton label="Resources" />
          </label>
          <div class="space-y-3">
            {data.resources.map((r) => (
              <div key={r.name} class="bg-gray-900 border border-gray-800 rounded p-3">
                <div class="flex items-center gap-2 mb-1">
                  <span class="text-sm text-white font-medium">{r.name}</span>
                  <span class="text-xs text-gray-500">{r.access}</span>
                  {r.required && <span class="text-xs text-amber-400">required</span>}
                </div>
                {r.description && <p class="text-xs text-gray-500 mb-2">{r.description}</p>}
                <input
                  type="text"
                  {...form.register(`resources.${r.name}`)}
                  placeholder="Host path (e.g. /data/repos/main)"
                  class={inputClass}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {data.pip && (
        <div class="space-y-2 max-w-md">
          <label class="flex items-center gap-2 text-xs font-medium text-gray-500 uppercase tracking-wider">
            Pip packages
            <HelpButton label="Pip packages" />
          </label>
          <div>
            <label class="block text-xs text-gray-500 mb-1">Base packages (locked)</label>
            <div class="flex flex-wrap gap-1">
              {data.pip.allowedPackages.map((pkg) => (
                <span key={pkg} class="px-2 py-0.5 bg-gray-800 text-gray-300 text-xs rounded mono">{pkg}</span>
              ))}
            </div>
          </div>
          {data.pip.extraPackagesUnlocked ? (
            <div>
              <label class="block text-xs text-gray-500 mb-1">Extra packages (operator)</label>
              <input type="text" {...form.register('extraPackages')}
                placeholder="package1, package2" class={inputClass} />
              <p class="text-xs text-gray-500 mt-1">Comma-separated package names</p>
            </div>
          ) : (
            <p class="text-xs text-gray-500">Extra packages locked by blueprint</p>
          )}
        </div>
      )}

      {data.additionalDisabledTools.unlocked && (
        <div class="space-y-2 max-w-md">
          <label class="flex items-center gap-2 text-xs font-medium text-gray-500 uppercase tracking-wider">
            Additional disabled tools
            <HelpButton label="Additional disabled tools" />
          </label>
          <input type="text" {...form.register('disabledTools')}
            placeholder="tool__name, domain__*" class={inputClass} />
          <p class="text-xs text-gray-500">Comma-separated tool patterns (exact names or domain__* globs)</p>
        </div>
      )}

      {hasEditable && (
        <div class="max-w-md space-y-2">
          <FormStatus message={message} />
          <SubmitButton submitProps={submitProps}>Save Provisions</SubmitButton>
        </div>
      )}

      {!hasEditable && data.resources.length === 0 && !data.pip && (
        <p class="text-gray-500 text-sm">No provisionable capabilities declared in this agent's blueprint.</p>
      )}

      {schedule.length > 0 && (
        <div class="space-y-2">
          <label class="flex items-center gap-2 text-xs font-medium text-gray-500 uppercase tracking-wider">
            Schedule
            <HelpButton label="Schedule" />
          </label>
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-gray-500 border-b border-gray-800">
                <th class="pb-2 font-medium">Cron</th>
                <th class="pb-2 font-medium">Channel</th>
                <th class="pb-2 font-medium">Message</th>
              </tr>
            </thead>
            <tbody>
              {schedule.map((entry, i) => (
                <tr key={i} class="border-b border-gray-800/50">
                  <td class="py-2 mono text-gray-300">{entry.cron ?? entry.raw}</td>
                  <td class="py-2 text-gray-400">{entry.channel ?? '—'}</td>
                  <td class="py-2 text-gray-400">{entry.message ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </form>
  );
}

/** Activity tab — Conversations and Events live as sub-tabs, not stacked. */
function CapabilitiesTab({ alias, subtab, nested }: { alias: string; subtab: string | null; nested: string | null }) {
  // Default to extensions — most operators land here for extension config;
  // MCP servers is the secondary surface.
  const activeSubtab: 'extensions' | 'mcp-servers' = subtab === 'mcp-servers' ? 'mcp-servers' : 'extensions';
  return (
    <div class="space-y-4">
      <div class="flex items-center gap-6 border-b border-gray-800">
        <SubTabLink subtab="extensions" current={activeSubtab} parentTab="capabilities" alias={alias}>Extensions</SubTabLink>
        <SubTabLink subtab="mcp-servers" current={activeSubtab} parentTab="capabilities" alias={alias}>MCP servers</SubTabLink>
        <span class="ml-auto pb-2">
          <HelpButton anchor={activeSubtab} />
        </span>
      </div>
      {activeSubtab === 'extensions' && <ExtensionsTab alias={alias} initialExtension={nested} />}
      {activeSubtab === 'mcp-servers' && <McpServersPage alias={alias} />}
    </div>
  );
}

function ActivityTab({ alias, subtab }: { alias: string; subtab: string | null }) {
  const activeSubtab: 'tokens' | 'conversations' | 'events' =
    subtab === 'conversations' ? 'conversations' : subtab === 'events' ? 'events' : 'tokens';
  return (
    <div class="space-y-4">
      <div class="flex items-center gap-6 border-b border-gray-800">
        <SubTabLink subtab="tokens" current={activeSubtab} parentTab="activity" alias={alias}>Tokens</SubTabLink>
        <SubTabLink subtab="conversations" current={activeSubtab} parentTab="activity" alias={alias}>Conversations</SubTabLink>
        <SubTabLink subtab="events" current={activeSubtab} parentTab="activity" alias={alias}>Events</SubTabLink>
        <span class="ml-auto pb-2">
          <HelpButton anchor={activeSubtab} />
        </span>
      </div>
      {activeSubtab === 'tokens' && <TokensView alias={alias} />}
      {activeSubtab === 'conversations' && <ConversationsView alias={alias} />}
      {activeSubtab === 'events' && <EventsView alias={alias} />}
    </div>
  );
}

function SubTabLink({ subtab, current, parentTab, alias, children }: {
  subtab: string;
  current: string;
  parentTab: string;
  alias: string;
  children: string;
}) {
  const href = `/agents/${alias}/${parentTab}/${subtab}`;
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

function ConversationsView({ alias }: { alias: string }) {
  const conversations = trpc.agent.conversations.useQuery({ alias });
  const idpUsers = trpc.idp.users.useQuery();

  const nameMap: Record<string, string> = {};
  for (const u of idpUsers.data ?? []) {
    nameMap[u.id] = u.declaredName;
  }

  return (
    <div class="space-y-3">
      <div class="flex justify-end">
        <RefreshButton
          onClick={() => { conversations.refetch(); idpUsers.refetch(); }}
          disabled={conversations.isFetching}
        />
      </div>
      {conversations.isLoading && <p class="text-gray-500 text-sm">Loading...</p>}
      {!conversations.isLoading && (!conversations.data || conversations.data.length === 0) && (
        <p class="text-gray-500 text-sm">No active conversations.</p>
      )}
      {conversations.data && conversations.data.length > 0 && (
        <div class="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <table class="w-full text-sm">
            <thead>
              <tr class="text-left text-gray-500 border-b border-gray-800">
                <th class="px-4 py-3 font-medium">Participant</th>
                <th class="px-4 py-3 font-medium">Channel</th>
                <th class="px-4 py-3 font-medium">Last Active</th>
                <th class="px-4 py-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {conversations.data.map((c) => (
                <tr key={c.conversationKey} class="border-t border-gray-800/50">
                  <td class="px-4 py-3">
                    {c.participant ? <IdentityLabel id={c.participant} nameMap={nameMap} /> : <span class="text-gray-500">—</span>}
                  </td>
                  <td class="px-4 py-3 text-gray-400">{c.channel}</td>
                  <td class="px-4 py-3 text-gray-400">{new Date(c.lastActive).toLocaleString()}</td>
                  <td class="px-4 py-3 text-gray-400">{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type EventLevel = 'error' | 'warn' | 'info';
type EventComponent = 'agent' | 'backup' | 'container' | 'conversation' | 'scheduler' | 'service';

const PAGE_SIZE = 50;
const MAX_LIMIT = 500;

function EventsView({ alias }: { alias: string }) {
  const [level, setLevel] = useState<EventLevel | ''>('');
  const [component, setComponent] = useState<EventComponent | ''>('');
  const [timeRange, setTimeRange] = useState<keyof typeof TIME_RANGES>('all');
  const [displayLimit, setDisplayLimit] = useState(PAGE_SIZE);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Reset pagination on any filter change.
  const resetAndSet = <T,>(setter: (v: T) => void) => (v: T) => {
    setDisplayLimit(PAGE_SIZE);
    setter(v);
  };

  // Memoized so the query key is stable. Without this, `Date.now()` produced
  // a new ISO string on every render → the React-Query input changed every
  // render → infinite refetch loop, manifesting as "stuck loading" when the
  // user picked Last 24h / Last 7 days. Window snaps to the moment the user
  // changed the range; clicking Refresh refetches with the same window.
  const sinceIso = useMemo(() => {
    const ms = TIME_RANGES[timeRange];
    return ms ? new Date(Date.now() - ms).toISOString() : undefined;
  }, [timeRange]);

  const events = trpc.agent.events.useQuery({
    alias,
    limit: displayLimit,
    level: level || undefined,
    component: component || undefined,
    since: sinceIso,
  });

  const clear = trpc.agent.clearEvents.useMutation({
    onSuccess: () => { setDisplayLimit(PAGE_SIZE); events.refetch(); },
  });

  const onClear = () => {
    if (clear.isPending) return;
    if (!confirm(`Clear all events for "${alias}"? This cannot be undone.`)) return;
    clear.mutate({ alias });
  };

  const toggleRow = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const levelClass = (lv: EventLevel) =>
    lv === 'error' ? 'text-red-400' : lv === 'warn' ? 'text-amber-400' : 'text-gray-400';

  const total = events.data?.total ?? 0;
  const shown = events.data?.events.length ?? 0;
  const hasMore = events.data ? events.data.truncated && displayLimit < MAX_LIMIT : false;

  return (
    <div class="space-y-4">
      {/* Action bar — refresh + clear log on the right, sit above the filter
          row. Same button family so the eye reads them together. */}
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

      {/* Filters — labeled stack above each select. Cleaner than inline labels;
          each filter reads as one unit, the row reads left-to-right. */}
      <div class="grid grid-cols-[auto_auto_auto] gap-3 w-fit text-sm">
        <FilterField label="Level" value={level} options={[
          { value: '', label: 'All' },
          { value: 'error', label: 'error' },
          { value: 'warn', label: 'warn' },
          { value: 'info', label: 'info' },
        ]} onChange={(v) => resetAndSet<EventLevel | ''>(setLevel)(v as EventLevel | '')} width="w-32" />
        <FilterField label="Component" value={component} options={[
          { value: '', label: 'All' },
          { value: 'agent', label: 'agent' },
          { value: 'backup', label: 'backup' },
          { value: 'container', label: 'container' },
          { value: 'conversation', label: 'conversation' },
          { value: 'scheduler', label: 'scheduler' },
          { value: 'service', label: 'service' },
        ]} onChange={(v) => resetAndSet<EventComponent | ''>(setComponent)(v as EventComponent | '')} width="w-44" />
        <FilterField label="Time" value={timeRange} options={[
          { value: 'all', label: 'All time' },
          { value: '1h', label: 'Last hour' },
          { value: '24h', label: 'Last 24h' },
          { value: '7d', label: 'Last 7 days' },
        ]} onChange={(v) => resetAndSet<keyof typeof TIME_RANGES>(setTimeRange)(v as keyof typeof TIME_RANGES)} width="w-36" />
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
                const hasConvKey = !!ev.conversation_key;
                const isOpen = expanded.has(ev.id);
                return (
                  <>
                    <tr
                      key={ev.id}
                      class={`border-t border-gray-800/50 ${hasContext || hasConvKey ? 'cursor-pointer hover:bg-gray-800/40' : ''}`}
                      onClick={() => (hasContext || hasConvKey) && toggleRow(ev.id)}
                    >
                      <td class="px-4 py-2 mono text-gray-400 text-xs whitespace-nowrap">{new Date(ev.ts).toLocaleString()}</td>
                      <td class={`px-4 py-2 mono text-xs ${levelClass(ev.level)}`}>{ev.level}</td>
                      <td class="px-4 py-2 mono text-xs text-gray-400">{ev.component}</td>
                      <td class="px-4 py-2 mono text-xs text-gray-300">{ev.event_name}</td>
                      <td class="px-4 py-2 text-gray-300">
                        {ev.message}
                        {(hasContext || hasConvKey) && (
                          <span class="ml-2 text-gray-600">{isOpen ? '▾' : '▸'}</span>
                        )}
                      </td>
                    </tr>
                    {isOpen && (hasContext || hasConvKey) && (
                      <tr key={`${ev.id}-detail`} class="border-t border-gray-800/30 bg-gray-950">
                        <td colSpan={5} class="px-4 py-3">
                          {hasConvKey && (
                            <div class="text-xs mb-2">
                              <span class="text-gray-500">conversation_key: </span>
                              <span class="mono text-gray-300">{ev.conversation_key}</span>
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
            <span>
              Showing {shown} of {total} {total === 1 ? 'event' : 'events'}
            </span>
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

function ChannelsTab({ channels }: { channels: AgentChannelForUi[] }) {
  if (channels.length === 0) return <p class="text-gray-500 text-sm">No channels configured (using implicit default).</p>;

  return (
    <div class="space-y-4">
      {channels.map((ch) => {
        const cfg = ch.config;
        const idleTimeout = cfg.idle_timeout;
        const lifecycle = cfg.lifecycle;
        const logMessages = cfg.log_messages;
        const useSharding = cfg.use_sharding;
        const showCoParticipants = cfg.show_co_participants;
        const disabledTools = cfg.disabled_tools;

        // Every row label is channel-config jargon (single-shot timing, lifecycle
        // modes, sharding, etc.) — all get an inline (i).
        const rows: Array<[string, string]> = [
          ['Idle timeout', idleTimeout === null || idleTimeout === undefined ? 'single-shot' : `${Math.round(idleTimeout / 60000)} minutes`],
          ['Lifecycle', lifecycle],
          ['Log messages', logMessages ? 'yes' : 'no'],
          ['Sharding', useSharding ? 'yes' : 'no'],
          ['Co-participant visibility', showCoParticipants === false ? 'hidden' : 'visible'],
          ...(disabledTools.length > 0 ? [['Disabled tools', disabledTools.join(', ')] as [string, string]] : []),
        ];

        return (
          <div key={ch.name} class="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <div class="px-5 py-3 border-b border-gray-800 bg-gray-800/30">
              <h3 class="text-sm font-semibold text-white">{ch.name}</h3>
            </div>
            {rows.map(([label, value], i) => (
              <div key={label} class={`flex justify-between items-center px-5 py-3 text-sm ${i > 0 ? 'border-t border-gray-800/50' : ''}`}>
                <span class="flex items-center gap-2 text-gray-400 font-medium">
                  {label}
                  <HelpButton label={label} />
                </span>
                <span class="text-gray-100">{value}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

/** Display an identity — show name if available, with ID in smaller text. */
function IdentityLabel({ id, nameMap }: { id: string; nameMap: Record<string, string> }) {
  const name = nameMap[id];
  if (name) {
    return <span><span class="text-gray-200">{name}</span> <span class="mono text-gray-500 text-xs">({id})</span></span>;
  }
  return <span class="mono text-gray-400">{id}</span>;
}

function AccessTab({ alias }: { alias: string }) {
  const acl = trpc.agent.getAcl.useQuery({ alias });
  const idpUsers = trpc.idp.users.useQuery();
  // Same query key as the tab badge in AgentDetailPage — React Query shares the
  // cache, so this re-uses the polled result rather than starting a second poll.
  const pending = trpc.agent.listPendingApprovals.useQuery(
    { alias },
    { refetchInterval: 15000, refetchOnWindowFocus: true },
  );

  if (acl.isLoading) return <p class="text-gray-500 text-sm">Loading...</p>;

  const aclData = acl.data ?? null;
  const staticPeers = aclData?.allowed ?? {};
  const owner = aclData?.owner ?? 'operator';

  // Build name lookup from IdP data (by identity ID)
  const nameMap: Record<string, string> = {};
  for (const u of idpUsers.data ?? []) {
    nameMap[u.id] = u.declaredName;
  }

  // Split into agent peers (no u: prefix) and user identities (u: prefix)
  const agentIds = Object.keys(staticPeers).filter((id) => !id.startsWith('u:'));
  const userIds = Object.keys(staticPeers).filter((id) => id.startsWith('u:'));

  return (
    <div class="space-y-8">
      <div class="flex justify-end">
        <RefreshButton
          onClick={() => {
            void acl.refetch();
            void idpUsers.refetch();
            void pending.refetch();
          }}
          disabled={acl.isFetching || idpUsers.isFetching || pending.isFetching}
        />
      </div>
      {/* Owner */}
      <OwnerPanel alias={alias} owner={owner} nameMap={nameMap} />

      {/* Pending approvals — the operator-visible inbox. Shown for every agent:
          redundancy over detection. When a human owner is set,
          their requests appear here too as a backstop the operator can override;
          whoever answers first resolves the row and it drops from the other
          surface on the next poll. */}
      <section id="approvals" class="scroll-mt-20">
        <div class="flex items-center gap-2 mb-4">
          <h3 class="text-base font-semibold text-white">Pending approvals</h3>
          <HelpButton anchor="approvals" />
        </div>
        {(pending.data?.length ?? 0) > 0 ? (
          <div class="space-y-3">
            {pending.data!.map((a) => (
              <ApprovalCard key={a.id} alias={alias} approval={a} nameMap={nameMap} />
            ))}
          </div>
        ) : (
          <p class="text-gray-500 text-sm">No pending approvals.</p>
        )}
      </section>

      {/* Agent peers */}
      <section id="agent-peers" class="scroll-mt-20">
        <div class="flex items-baseline justify-between mb-4">
          <div class="flex items-center gap-2">
            <h3 class="text-base font-semibold text-white">Agent Peers</h3>
            <HelpButton anchor="agent-peers" label="Agent peers" />
          </div>
          <span class="text-xs text-gray-500">
            Add grants by chatting with Configure.
          </span>
        </div>
        {agentIds.length > 0 ? (
          <div class="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-gray-500 border-b border-gray-800">
                  <th class="px-4 py-3 font-medium">Agent</th>
                  <th class="px-4 py-3 font-medium">Channel</th>
                  <th class="px-4 py-3 font-medium">Permissions</th>
                  <th class="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {agentIds.flatMap((id) =>
                  Object.entries(staticPeers[id] ?? {}).map(([channel, bits]) => (
                    <tr key={`${id}-${channel}`} class="border-t border-gray-800/50">
                      <td class="px-4 py-3 mono text-gray-300">{id}</td>
                      <td class="px-4 py-3 text-gray-400">{channel}</td>
                      <td class="px-4 py-3 mono text-gray-200">{bits}</td>
                      <td class="px-4 py-3 text-right"><RevokeButton alias={alias} peer={id} channel={channel} /></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <p class="text-gray-500 text-sm">No agent peers configured.</p>
        )}
      </section>

      {/* Users */}
      <section id="users" class="scroll-mt-20">
        <div class="flex items-center gap-2 mb-4">
          <h3 class="text-base font-semibold text-white">Users</h3>
          <HelpButton anchor="users" />
        </div>
        {userIds.length > 0 ? (
          <div class="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="text-left text-gray-500 border-b border-gray-800">
                  <th class="px-4 py-3 font-medium">User</th>
                  <th class="px-4 py-3 font-medium">Channel</th>
                  <th class="px-4 py-3 font-medium">Permissions</th>
                  <th class="px-4 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {userIds.flatMap((id) =>
                  Object.entries(staticPeers[id] ?? {}).map(([channel, bits]) => (
                    <tr key={`${id}-${channel}`} class="border-t border-gray-800/50">
                      <td class="px-4 py-3"><IdentityLabel id={id} nameMap={nameMap} /></td>
                      <td class="px-4 py-3 text-gray-400">{channel}</td>
                      <td class="px-4 py-3 mono text-gray-200">{bits}</td>
                      <td class="px-4 py-3 text-right"><RevokeButton alias={alias} peer={id} channel={channel} /></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        ) : (
          <p class="text-gray-500 text-sm">No users.</p>
        )}
      </section>

    </div>
  );
}

/**
 * One pending operator approval — subject + the agent's summary, and the
 * four-option decision (approve/reject × once/always). `always` writes a
 * standing grant/tombstone into acl.json; `once` releases just this request.
 * On success we invalidate the pending list (drops this row) and the ACL
 * (an `always` decision changes the grant tables above).
 */
/**
 * Owner panel — the current owner plus the designation affordance. Designating a
 * human owner goes through the verification loop, never a direct pick: a name in
 * the roster is recognition, not proof of identity. The operator mints a one-time
 * claim code and hands it to the intended person out-of-band; they redeem it via
 * `/claim <code>`, which binds their transport-authenticated identity as owner.
 * Revert is the one direct write — back to the `operator` sentinel.
 */
function OwnerPanel({ alias, owner, nameMap }: { alias: string; owner: string; nameMap: Record<string, string> }) {
  const utils = trpc.useUtils();
  const claim = trpc.agent.ownerClaim.useQuery({ alias }, { refetchOnWindowFocus: true });
  const mint = trpc.agent.mintOwnerClaim.useMutation({
    onSuccess: () => { void utils.agent.ownerClaim.invalidate({ alias }); },
  });
  const revert = trpc.agent.setOwner.useMutation({
    onSuccess: () => {
      void utils.agent.getAcl.invalidate({ alias });
      void utils.agent.ownerClaim.invalidate({ alias });
    },
  });
  const operatorOwned = owner === 'operator';
  // The freshly-minted code wins for immediate display; otherwise fall back to a
  // still-outstanding claim the server reports (survives a reload without re-minting).
  const active = claim.data?.active ?? null;
  const code = mint.data?.code ?? active?.code ?? null;
  const expiresAt = mint.data?.expiresAt ?? active?.expiresAt ?? null;
  const btn = 'px-2.5 py-1 text-xs font-medium rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div id="owner" class="scroll-mt-20 space-y-3">
      <div class="flex items-center gap-3 pl-3 border-l-2 border-blue-600">
        <span class="text-sm text-gray-500">Owner</span>
        {operatorOwned
          ? <span class="mono text-sm text-gray-100">operator</span>
          : <span class="text-sm"><IdentityLabel id={owner} nameMap={nameMap} /></span>}
        <HelpButton anchor="owner" />
      </div>
      <p class="text-xs text-gray-500 pl-3">
        {operatorOwned
          ? 'Access requests are approved by you, below. To hand this agent to a person, generate a one-time claim code and give it to them out-of-band — they become owner by redeeming it.'
          : 'This owner approves access requests in their own conversation. Those requests also appear below as a backstop you can override.'}
      </p>

      <div class="pl-3 space-y-3">
        {code && (
          <div class="rounded-md border border-blue-900/60 bg-blue-950/20 p-3 space-y-2 max-w-xl">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-xs text-gray-400">Claim code</span>
              <code class="mono text-sm text-blue-300 bg-gray-950/60 px-2 py-0.5 rounded select-all">{code}</code>
              {expiresAt && <span class="text-xs text-gray-600">expires {new Date(expiresAt).toLocaleString()}</span>}
            </div>
            <p class="text-xs text-gray-500">
              Give this to the intended owner through a channel you trust. They redeem it by messaging the agent
              {' '}<code class="mono text-gray-400">/claim {code}</code>. Redeeming binds their verified identity as owner.
            </p>
            <button type="button" disabled={mint.isPending} onClick={() => mint.mutate({ alias })}
              class={`${btn} bg-gray-800 hover:bg-gray-700 text-gray-200`}>
              {mint.isPending ? 'Generating…' : 'Regenerate'}
            </button>
          </div>
        )}
        <div class="flex flex-wrap items-center gap-3">
          {!code && (
            <button type="button" disabled={mint.isPending} onClick={() => mint.mutate({ alias })}
              class={`${btn} bg-blue-600 hover:bg-blue-500 text-white`}>
              {mint.isPending ? 'Generating…' : 'Generate claim code'}
            </button>
          )}
          {!operatorOwned && (
            <button type="button" disabled={revert.isPending}
              onClick={() => {
                if (confirm('Revert ownership to operator? Access approvals return to you and the owner conversation is unpinned.')) {
                  revert.mutate({ alias, owner: 'operator' });
                }
              }}
              class={`${btn} text-gray-300 bg-gray-800 hover:bg-red-950/60 hover:text-red-300`}>
              {revert.isPending ? 'Reverting…' : 'Revert to operator'}
            </button>
          )}
        </div>
        {(mint.error || revert.error) && (
          <span class="block text-xs text-red-400">{mint.error?.message ?? revert.error?.message}</span>
        )}
      </div>
    </div>
  );
}

function ApprovalCard({
  alias,
  approval,
  nameMap,
}: {
  alias: string;
  approval: { id: string; type: string; summary: string; details: string | null; participant: string; channel: string | null; bit: string | null; controller: string };
  nameMap: Record<string, string>;
}) {
  const utils = trpc.useUtils();
  const [expanded, setExpanded] = useState(false);
  const respond = trpc.agent.respondApproval.useMutation({
    onSuccess: () => {
      void utils.agent.listPendingApprovals.invalidate({ alias });
      void utils.agent.getAcl.invalidate({ alias });
      // Drops the sidebar's per-agent badge in step with the Access tab.
      void utils.agent.pendingApprovalCounts.invalidate();
    },
  });
  const act = (decision: 'approved' | 'rejected', tier: 'once' | 'always') =>
    respond.mutate({ alias, id: approval.id, decision, tier });
  const busy = respond.isPending;
  const btn = 'px-2.5 py-1 text-xs font-medium rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  // An `io` edge is a first-contact conversation message — approving it MUST
  // write a standing grant, or the agent's free-prose reply bounces on outbound
  // `o` (there is no return rail for it, unlike a `q`/`r`/`a` answer). So a
  // message approval offers a single Approve (= always); approve-once is
  // dropped. `q`/`r`/`a` keep the four-option once/always split.
  const isMessage = approval.bit === 'io';

  // The message/request body the requester is trying to get through. Shown in
  // full so the decision is made on the actual content. When long, it collapses
  // to a clamped height with a Show more/less toggle — never truncated (the full
  // text is always in the DOM and one click away, no ellipsis cutoff).
  const body = approval.details?.trim() || null;
  const isLong = !!body && (body.length > 240 || body.split('\n').length > 5);

  return (
    <div class="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <IdentityLabel id={approval.participant} nameMap={nameMap} />
          <span class="text-sm text-gray-400 truncate">{approval.summary}</span>
        </div>
        {approval.bit && <span class="mono text-xs text-gray-500 shrink-0">{approval.bit}</span>}
      </div>
      {approval.controller !== 'operator' && (
        <div class="text-xs text-gray-500">
          Routed to owner <IdentityLabel id={approval.controller} nameMap={nameMap} /> — you can override.
        </div>
      )}
      {body && (
        <div class="rounded-md border border-gray-800 bg-gray-950/60">
          <div class="relative">
            <div class={`whitespace-pre-wrap break-words text-sm text-gray-300 px-3 py-2 ${isLong && !expanded ? 'max-h-28 overflow-hidden' : ''}`}>
              {body}
            </div>
            {isLong && !expanded && (
              <div class="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-gray-950/90 to-transparent rounded-b-md" />
            )}
          </div>
          {isLong && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              class="px-3 py-1 text-xs font-medium text-gray-400 hover:text-gray-200 transition-colors"
            >
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
      )}
      <div class="flex items-center gap-3 flex-wrap">
        {isMessage ? (
          <button type="button" disabled={busy} onClick={() => act('approved', 'always')}
            title="Grants standing access so the agent's reply can be delivered."
            class={`${btn} bg-blue-600 hover:bg-blue-500 text-white`}>Approve</button>
        ) : (
          <div class="flex items-center gap-1.5">
            <span class="text-xs text-gray-500">Approve</span>
            <button type="button" disabled={busy} onClick={() => act('approved', 'once')}
              class={`${btn} bg-gray-800 hover:bg-gray-700 text-gray-200`}>once</button>
            <button type="button" disabled={busy} onClick={() => act('approved', 'always')}
              class={`${btn} bg-blue-600 hover:bg-blue-500 text-white`}>always</button>
          </div>
        )}
        <div class="flex items-center gap-1.5">
          <span class="text-xs text-gray-500">Reject</span>
          <button type="button" disabled={busy} onClick={() => act('rejected', 'once')}
            class={`${btn} bg-gray-800 hover:bg-gray-700 text-gray-200`}>once</button>
          <button type="button" disabled={busy} onClick={() => act('rejected', 'always')}
            class={`${btn} bg-gray-800 hover:bg-red-950/60 hover:text-red-300 text-gray-300`}>always</button>
        </div>
        {respond.error && <span class="text-xs text-red-400">{respond.error.message}</span>}
      </div>
    </div>
  );
}

/**
 * Plain-remove a single granted edge from acl.json `allowed`. The peer returns
 * to askable (not banned). Confirmed inline — reversible by re-granting via
 * Configure, but a misclick still pulls live access, so we gate it.
 */
function RevokeButton({ alias, peer, channel }: { alias: string; peer: string; channel: string }) {
  const utils = trpc.useUtils();
  const revoke = trpc.agent.revokeAclEdge.useMutation({
    onSuccess: () => utils.agent.getAcl.invalidate({ alias }),
  });
  return (
    <button
      type="button"
      disabled={revoke.isPending}
      onClick={() => {
        if (confirm(`Revoke ${peer} on "${channel}"? It loses this grant and becomes askable again (it can request access anew).`)) {
          revoke.mutate({ alias, peer, channel });
        }
      }}
      class="px-2.5 py-1 text-xs font-medium text-gray-300 bg-gray-800 hover:bg-red-950/60 hover:text-red-300 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
    >
      {revoke.isPending ? 'Revoking…' : 'Revoke'}
    </button>
  );
}

/** Map extension name → display label. Only extensions with UI components listed here.
 *  `service` is not an extension — it's the agent's service process, sharing this
 *  registry for the card grid + drill-in routing (the name is already reserved by
 *  the config/ext/service namespace, so no extension can collide with it). */
const EXTENSION_LABELS: Record<string, string> = {
  email: 'Email',
  'web-fetch': 'Web Fetch',
  calendar: 'Calendar',
  whatsapp: 'WhatsApp',
  service: 'Service',
};

const EXTENSION_PAGES: Record<string, (props: { alias: string }) => JSX.Element> = {
  email: EmailExtensionPage,
  'web-fetch': WebFetchExtensionPage,
  calendar: CalendarExtensionPage,
  whatsapp: WhatsAppExtensionPage,
  service: ServiceSecretsPage,
};

function ExtensionsTab({ alias, initialExtension }: { alias: string; initialExtension?: string | null }) {
  const [, navigate] = useLocation();
  const active = initialExtension ?? null;
  const enabled = trpc.extension.shared.listEnabled.useQuery({ alias });
  // Service card — rendered only when the agent's service manifest declares
  // something operator-facing: settings, secrets, or an admin page (the
  // query is cheap: one manifest + two flat-file reads).
  const serviceConfig = trpc.service.getConfig.useQuery({ alias });

  if (enabled.isLoading) return <p class="text-gray-500 text-sm">Loading...</p>;

  const enabledList = enabled.data ?? [];
  // Show the Service card whenever a service exists (to restart it and see its
  // status), not only when it declares operator-facing settings/secrets/admin.
  const serviceShown = (serviceConfig.data?.present ?? false) || (serviceConfig.data?.declared ?? false);

  if (active) {
    const Page = EXTENSION_PAGES[active];
    const entry = enabledList.find((e) => e.name === active);
    const isUnknown = entry && !entry.registered;
    return (
      <div class="space-y-4">
        <button
          onClick={() => navigate(`/agents/${alias}/capabilities/extensions`)}
          class="flex items-center gap-1 text-sm text-gray-400 hover:text-gray-200 transition-colors"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
          </svg>
          Extensions
        </button>
        <h2 class="text-sm font-medium text-white">{EXTENSION_LABELS[active] ?? active}</h2>
        {isUnknown ? (
          <p class="text-red-400 text-sm">
            Extension <code class="font-mono">{active}</code> is not registered on this server. Check the key name in <code class="font-mono">blueprint/props/capabilities.json</code> — it must match an installed extension exactly.
          </p>
        ) : Page ? <Page alias={alias} /> : <p class="text-gray-500 text-sm">No admin page for this extension.</p>}
      </div>
    );
  }

  if (enabledList.length === 0 && !serviceShown) {
    return <p class="text-gray-500 text-sm">No extensions enabled for this agent.</p>;
  }

  return (
    <div class="grid grid-cols-2 gap-3">
      {serviceShown && (
        <Link
          href={`/agents/${alias}/capabilities/extensions/service`}
          class="bg-gray-900 rounded-lg p-5 text-left hover:bg-gray-800 transition-colors block"
        >
          <h3 class="text-base font-medium text-white">Service</h3>
          <p class="text-sm text-gray-500 mt-1">Process, settings, and credentials</p>
        </Link>
      )}
      {enabledList.map(({ name, registered }) => {
        const href = `/agents/${alias}/capabilities/extensions/${name}`;
        const label = EXTENSION_LABELS[name] ?? name;
        if (!registered) {
          return (
            <Link
              key={name}
              href={href}
              class="bg-gray-900 rounded-lg p-5 text-left border border-red-900/50 hover:bg-gray-800 transition-colors block"
            >
              <h3 class="text-base font-medium text-red-400 font-mono">{name}</h3>
              <p class="text-sm text-red-400/70 mt-1">Not recognized — no such extension on this server</p>
            </Link>
          );
        }
        return (
          <Link
            key={name}
            href={href}
            class="bg-gray-900 rounded-lg p-5 text-left hover:bg-gray-800 transition-colors block"
          >
            <h3 class="text-base font-medium text-white">{label}</h3>
            <p class="text-sm text-gray-500 mt-1">Configure {label.toLowerCase()}</p>
          </Link>
        );
      })}
    </div>
  );
}
