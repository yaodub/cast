import type { ComponentChildren } from 'preact';
import {
  PenTool,
  Sliders,
  ShieldCheck,
  Globe,
  AllAgentsGrid,
  Users,
  Activity,
  Settings,
  Lock,
} from '../brand/Icon';
import { consoleTheme, ConsoleAvatar } from './consoleTheme';

/**
 * Visual approximations of the actual Cast Server Dashboard, built from the
 * design tokens in `packages/web-ui/src/admin/`. These are not screenshots —
 * they're lightweight component mocks that stay in sync with the real UI's
 * colors and shapes without rotting when the dashboard re-skins.
 *
 * Always-dark palette regardless of site theme: these read as "screenshot of
 * the dashboard" rather than "part of the docs page," which is the intended
 * framing — they show the operator what they'll see when they open the URL.
 */

const DARK = {
  sidebarBg: '#0a1028',
  panelBg: '#111827',
  panelBorder: '#1f2937',
  panelDivider: 'rgba(31, 41, 55, 0.7)',
  inputBg: '#030712',
  inputBorder: '#374151',
  tileInactive: '#1f2937',
  tileText: '#9ca3af',
  textPrimary: '#f9fafb',
  textSecondary: '#d1d5db',
  textMuted: '#6b7280',
  textDim: '#4b5563',
  serverAccent: '#6366f1',
  teal: '#14b8a6',
  draftBg: 'rgba(146, 64, 14, 0.4)',
  draftFg: '#fcd34d',
  amber: '#f59e0b',
  sky: '#0ea5e9',
  emerald: '#059669',
} as const;

function Frame({ children, label }: { children: ComponentChildren; label?: string }) {
  return (
    <div
      style={{
        margin: '8px 0 24px',
        border: '1px solid var(--border)',
        borderRadius: 10,
        overflow: 'hidden',
        background: '#000',
        boxShadow: 'var(--shadow)',
      }}
    >
      {label && (
        <div
          style={{
            padding: '7px 14px',
            background: '#0a1028',
            color: '#6b7280',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 10.5,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            borderBottom: '1px solid #1f2937',
          }}
        >
          {label}
        </div>
      )}
      {children}
    </div>
  );
}

function Tile({
  icon,
  label,
  active = false,
  accentColor,
}: {
  icon: ComponentChildren;
  label: string;
  active?: boolean;
  accentColor?: string;
}) {
  const bg = active && accentColor ? accentColor : DARK.tileInactive;
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5, padding: 4 }}
    >
      <span
        style={{
          width: 38,
          height: 38,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 6,
          background: bg,
          color: active ? 'white' : DARK.tileText,
          boxShadow: active && accentColor ? `0 0 14px ${accentColor}66` : undefined,
        }}
      >
        {icon}
      </span>
      <span
        style={{
          fontSize: 9.5,
          color: active ? 'white' : DARK.tileText,
          textAlign: 'center',
          whiteSpace: 'nowrap',
          fontWeight: 500,
        }}
      >
        {label}
      </span>
    </div>
  );
}

function SectionLabel({ children }: { children: ComponentChildren }) {
  return (
    <div
      style={{
        fontSize: 9.5,
        fontFamily: 'JetBrains Mono, monospace',
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: DARK.textMuted,
        fontWeight: 600,
        padding: '0 4px',
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function AgentRow({
  alias,
  active = false,
  draft = false,
  badge,
}: {
  alias: string;
  active?: boolean;
  draft?: boolean;
  badge?: number;
}) {
  return (
    <div
      style={{
        borderLeft: `3px solid ${active ? 'rgba(20, 184, 166, 0.6)' : 'rgba(55, 65, 81, 0.5)'}`,
        padding: '7px 10px',
        display: 'flex',
        alignItems: 'center',
        gap: 9,
      }}
    >
      <span
        style={{
          width: 22,
          height: 22,
          borderRadius: '50%',
          background: active ? DARK.teal : '#374151',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 10,
          fontWeight: 600,
          color: 'white',
          flexShrink: 0,
        }}
      >
        {alias[0]!.toUpperCase()}
      </span>
      <span
        style={{
          flex: 1,
          fontSize: 12,
          color: active ? 'white' : DARK.textSecondary,
          fontWeight: active ? 500 : 400,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {alias}
      </span>
      {draft && (
        <span
          style={{
            padding: '1px 5px',
            fontSize: 8.5,
            fontWeight: 500,
            background: DARK.draftBg,
            color: DARK.draftFg,
            borderRadius: 3,
          }}
        >
          draft
        </span>
      )}
      {badge !== undefined && (
        <span
          style={{
            background: '#ef4444',
            color: 'white',
            fontSize: 8.5,
            fontWeight: 700,
            borderRadius: 999,
            padding: '1px 5px',
            minWidth: 14,
            textAlign: 'center',
          }}
        >
          {badge}
        </span>
      )}
    </div>
  );
}

function Sidebar() {
  return (
    <div
      style={{
        background: DARK.sidebarBg,
        padding: 12,
        width: 260,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 0,
      }}
    >
      <SectionLabel>Server</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
        <Tile icon={<Globe s={16} />} label="Messaging" />
        <Tile icon={<Users s={16} />} label="Identities" />
        <Tile icon={<Activity s={16} />} label="Activity" />
        <Tile icon={<Settings s={16} />} label="Settings" />
      </div>

      <div style={{ height: 1, background: DARK.panelDivider, margin: '14px 0 12px' }} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 4 }}>
        <Tile icon={<AllAgentsGrid s={16} />} label="All Agents" active accentColor={DARK.teal} />
        <Tile icon={<PenTool s={16} />} label="Design" accentColor={DARK.sky} />
        <Tile icon={<Sliders s={16} />} label="Configure" accentColor={DARK.amber} />
        <Tile icon={<ShieldCheck s={16} />} label="Review" accentColor={DARK.emerald} />
      </div>

      <div style={{ marginTop: 16, marginBottom: 6 }}>
        <SectionLabel>On this server</SectionLabel>
      </div>

      <AgentRow alias="research-assistant" active />
      <AgentRow alias="email-triage" />
      <AgentRow alias="household" badge={3} />
      <AgentRow alias="prediction-edge" />
      <AgentRow alias="draft-bot" draft />
    </div>
  );
}

function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <div
      style={{
        background: DARK.panelBg,
        border: `1px solid ${DARK.panelBorder}`,
        borderRadius: 6,
        padding: '14px 16px',
      }}
    >
      <div
        style={{
          fontSize: 22,
          fontWeight: 600,
          color: DARK.textPrimary,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 10.5, color: DARK.textMuted, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function MainArea() {
  return (
    <div style={{ flex: 1, padding: 18, background: '#000', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span
          style={{
            width: 26,
            height: 26,
            borderRadius: 6,
            background: DARK.teal,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'white',
          }}
        >
          <AllAgentsGrid s={14} />
        </span>
        <span style={{ fontSize: 15, fontWeight: 600, color: DARK.textPrimary }}>All Agents</span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, marginBottom: 14 }}>
        <StatTile value="5" label="Agents" />
        <StatTile value="12" label="Conversations today" />
        <StatTile value="2" label="Pending pairings" />
      </div>

      <div
        style={{
          background: DARK.panelBg,
          border: `1px solid ${DARK.panelBorder}`,
          borderRadius: 6,
          padding: 14,
        }}
      >
        <div
          style={{ fontSize: 12, fontWeight: 500, color: DARK.textSecondary, marginBottom: 10 }}
        >
          Needs attention
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: DARK.textMuted }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: DARK.amber }} />
          1 draft pending review
        </div>
      </div>
    </div>
  );
}

/** Full dashboard layout — sidebar + main content showing the All Agents landing view. */
export function DashboardLandingMock() {
  return (
    <Frame label="Server Dashboard — http://localhost:54321">
      <div style={{ display: 'flex', minHeight: 360 }}>
        <Sidebar />
        <MainArea />
      </div>
    </Frame>
  );
}

/** Side-by-side mock: a panel (form) and a console (chat). */
export function PanelVsConsoleMock() {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
        gap: 12,
        margin: '8px 0 24px',
      }}
    >
      <Frame label="Panel — Transports">
        <div style={{ background: '#000', padding: 16 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 500,
              color: DARK.textSecondary,
              borderBottom: `1px solid ${DARK.panelBorder}`,
              paddingBottom: 6,
              marginBottom: 12,
            }}
          >
            Telegram
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: DARK.textSecondary }}>Enabled</span>
            <span
              style={{
                width: 32,
                height: 18,
                borderRadius: 999,
                background: DARK.teal,
                position: 'relative',
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  top: 2,
                  right: 2,
                  width: 14,
                  height: 14,
                  borderRadius: '50%',
                  background: 'white',
                }}
              />
            </span>
          </div>
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: DARK.textMuted, marginBottom: 4 }}>Bot token</div>
            <div
              style={{
                background: DARK.inputBg,
                border: `1px solid ${DARK.inputBorder}`,
                borderRadius: 4,
                padding: '6px 10px',
                fontSize: 11,
                color: DARK.textDim,
                fontFamily: 'JetBrains Mono, monospace',
              }}
            >
              ••••••••••••••••••••
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10.5, color: '#22c55e' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#22c55e' }} />
            Connected
          </div>
        </div>
      </Frame>

      <Frame label="Console agent — Configure">
        <div style={{ background: '#000' }}>
          <div
            style={{
              height: 4,
              background: 'rgba(245, 158, 11, 0.5)',
            }}
          />
          <div
            style={{
              background: 'rgba(120, 53, 15, 0.4)',
              borderBottom: '1px solid rgba(245, 158, 11, 0.25)',
              padding: '8px 14px',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <ConsoleAvatar kind="configure" size={22} />
            <span style={{ fontSize: 12, color: 'white', fontWeight: 500 }}>Configure</span>
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 9.5,
                color: '#34d399',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
              }}
            >
              <Lock s={10} />
              SDK-only
            </span>
          </div>
          <div style={{ padding: 14, minHeight: 110, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div
              style={{
                alignSelf: 'flex-end',
                background: '#115E59',
                color: '#F3F4F6',
                padding: '7px 11px',
                borderRadius: '12px 12px 3px 12px',
                fontSize: 11.5,
                maxWidth: '85%',
              }}
            >
              Wire this agent up to Telegram.
            </div>
            <div
              style={{
                background: 'rgba(245, 158, 11, 0.08)',
                border: `1px solid ${consoleTheme.configure.border}`,
                padding: '7px 11px',
                borderRadius: '12px 12px 12px 3px',
                fontSize: 11.5,
                color: DARK.textSecondary,
                maxWidth: '85%',
                lineHeight: 1.4,
              }}
            >
              Done. Telegram is enabled — Transports panel should show green.
            </div>
          </div>
          <div
            style={{
              borderTop: `1px solid ${DARK.panelBorder}`,
              padding: 10,
              background: '#0c1220',
            }}
          >
            <div
              style={{
                background: DARK.inputBg,
                border: `1px solid ${DARK.inputBorder}`,
                borderRadius: 4,
                padding: '6px 10px',
                fontSize: 11,
                color: DARK.textDim,
                fontStyle: 'italic',
              }}
            >
              Type to Configure…
            </div>
          </div>
        </div>
      </Frame>
    </div>
  );
}
