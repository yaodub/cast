/**
 * ConsoleAvatar — role badge for Design / Configure / Review consoles.
 *
 * Consoles are *development-time agents* — the things that compose,
 * configure, and audit the runtime agents. They render as a rounded
 * square (an "app-icon" affordance) so they read as a tool, not a
 * persona. Runtime agents get a separate component (`AgentAvatar`) —
 * round, with initials. The shape category is the primary "dev tool
 * vs user-facing agent" cue.
 *
 * Two signals on a console avatar:
 *
 *   1. Role (fill color + glyph): sky/PenTool (Design), amber/Sliders
 *      (Configure), emerald/Shield (Review). Same hue across scopes.
 *      Cool→warm→cool-bright reads as a temperature arc through the
 *      build → tweak → ship workflow without overloading red as a
 *      "stop"-coded role color.
 *
 *   2. Posture (optional badge overlay): emerald lock for `sdk-only`,
 *      amber globe for `full-net`. Used on chat-header avatars to
 *      remind operators whether the surface can reach the public web.
 *      (Note: posture's amber/emerald collides with Configure/Review
 *      role hues — context disambiguates, since posture only renders
 *      as a small overlay badge on a console avatar.)
 *
 * Scope (server vs per-agent) used to render as a colored ring here —
 * removed because the ring around per-agent consoles muddied the frame
 * and the "dev tool" shape category is enough on its own. Scope is
 * still carried by the surrounding chrome: sidebar section labels
 * (SCOPE_TEXT), the chat-header scope chip, and the agent-detail
 * page-title left border (SCOPE_BORDER).
 *
 * Sizes: sm (20px) for sidebar; md (24px) for chat header; lg (32px)
 * for chat-message bubbles where used.
 */
import { ConfigureIcon, DesignIcon, SecureIcon, LockIcon, GlobeIcon } from './icons';

export type ConsoleRole = 'design' | 'configure' | 'review';
export type ConsoleScope = 'server' | 'agent';
export type ConsolePosture = 'sdk-only' | 'full-net';

interface RoleStyle {
  bg: string;
  bgInactive: string;
  Icon: (props: { class?: string }) => preact.JSX.Element;
}

const ROLE_STYLES: Record<ConsoleRole, RoleStyle> = {
  // Sky-blue (not the CTA blue-600) — Design is the primary entry
  // point, so it gets a brighter, more inviting blue while staying
  // distinct from Save/Create/Submit buttons. The role/scope palette
  // is reserved for identity cues only.
  design: { bg: 'bg-sky-500', bgInactive: 'bg-gray-800', Icon: DesignIcon },
  configure: { bg: 'bg-amber-600', bgInactive: 'bg-gray-800', Icon: ConfigureIcon },
  review: { bg: 'bg-emerald-600', bgInactive: 'bg-gray-800', Icon: SecureIcon },
};

/** Scope leitmotifs — indigo extends the sidebar's dark-blue identity
 *  for "server / structural / cross-agent" things. Teal marks "this
 *  specific agent — the thing you're shaping," matching the operator
 *  chat surface so admin ↔ chat read as the same product family.
 *  Used on sidebar section labels, page-title accents, ring overlays. */
export const SCOPE_TEXT: Record<ConsoleScope, string> = {
  server: 'text-indigo-300',
  agent: 'text-teal-300',
};

export const SCOPE_BORDER: Record<ConsoleScope, string> = {
  server: 'border-indigo-500/50',
  agent: 'border-teal-500/50',
};

/** Single bottom-right corner L mark. Same geometry as one corner of
 *  the (previously-tried) four-corner frame — a 2-unit L at (21,21)
 *  pointing up-and-left in viewBox-24 units. Marks tiles that *dock a
 *  chat panel* (vs. tiles that navigate to a page), so the operator can
 *  tell at a glance which tiles open a panel from below. Applied to the
 *  fleet DM/CM/SM tiles, the per-agent Design/Configure tiles, and the
 *  ConsoleAvatar in the docked chat header. Color is controlled by the
 *  consumer via the `class` prop — typically `text-white` when the host
 *  tile is active and a darker shade like `text-gray-500` when inactive,
 *  so the marker reads as "lit" when the chat is docked. */
export function DockMark({ class: cls = '' }: { class?: string }): preact.JSX.Element {
  return (
    <svg
      class={`absolute inset-0 w-full h-full pointer-events-none ${cls}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden
    >
      <path d="M 19 21 L 21 21 L 21 19" />
    </svg>
  );
}

const SIZE_STYLES = {
  sm: { box: 'w-5 h-5', icon: 'w-3 h-3', badge: 'w-2.5 h-2.5', badgeIcon: 'w-1.5 h-1.5' },
  md: { box: 'w-6 h-6', icon: 'w-3.5 h-3.5', badge: 'w-3 h-3', badgeIcon: 'w-2 h-2' },
  lg: { box: 'w-8 h-8', icon: 'w-4 h-4', badge: 'w-3.5 h-3.5', badgeIcon: 'w-2.5 h-2.5' },
};

const POSTURE_TITLE: Record<ConsolePosture, string> = {
  'sdk-only': 'Locked surface — only reaches the AI. Safe to paste secrets, identifiers, or conversation history.',
  'full-net': 'Web-connected — reaches the public internet for package installs and doc lookups. Anything pasted here could be relayed by prompt injection.',
};

interface Props {
  role: ConsoleRole;
  size?: 'sm' | 'md' | 'lg';
  /** Active = full color saturation; inactive = muted gray. Defaults true. */
  active?: boolean;
  /** Optional posture badge overlay (lock/globe). Off by default. */
  posture?: ConsolePosture;
  /** When true, overlays the bottom-right `DockMark` L behind the role
   *  icon. Used on the ConsoleAvatar in a docked chat's header — the
   *  same marker the sidebar chat-dock RoleTiles carry, so the avatar
   *  identifies as "the tile that opened this panel." Off by default —
   *  per-message message-row avatars stay flat. */
  dock?: boolean;
}

export function ConsoleAvatar({ role, size = 'sm', active = true, posture, dock = false }: Props) {
  const style = ROLE_STYLES[role];
  const sz = SIZE_STYLES[size];
  const bg = active ? style.bg : style.bgInactive;
  const fg = active ? 'text-white' : 'text-gray-500';
  const avatar = (
    <span
      class={`relative ${sz.box} ${bg} ${fg} rounded flex items-center justify-center shrink-0 overflow-hidden`}
      aria-hidden
    >
      {dock && <DockMark class={active ? 'text-white' : 'text-gray-700'} />}
      <style.Icon class={`${sz.icon} relative`} />
    </span>
  );
  if (!posture) return avatar;
  const badgeBg = posture === 'sdk-only' ? 'bg-emerald-600' : 'bg-amber-600';
  const BadgeIcon = posture === 'sdk-only' ? LockIcon : GlobeIcon;
  return (
    <span class="relative inline-flex shrink-0" title={POSTURE_TITLE[posture]}>
      {avatar}
      <span
        class={`${sz.badge} ${badgeBg} ring-2 ring-gray-950 rounded-full absolute -bottom-0.5 -right-0.5 flex items-center justify-center text-white`}
        aria-label={posture === 'sdk-only' ? 'locked' : 'web-connected'}
      >
        <BadgeIcon class={sz.badgeIcon} />
      </span>
    </span>
  );
}

/** Map console-strategy name → role. */
export function consoleRole(consoleName: string): ConsoleRole {
  if (consoleName === 'design' || consoleName === 'design-manager') return 'design';
  if (consoleName === 'configure' || consoleName === 'config-manager') return 'configure';
  return 'review';
}

/** Map console-strategy name → scope. `*-manager` brokers run at server
 *  scope (cross-agent tools). Per-agent consoles (`design`, `configure`)
 *  run at agent scope. */
export function consoleScope(consoleName: string): ConsoleScope {
  return consoleName.endsWith('-manager') ? 'server' : 'agent';
}

/** Map console-strategy name → static surface posture. */
export function consolePosture(consoleName: string): ConsolePosture {
  if (consoleName === 'design' || consoleName === 'design-manager') return 'full-net';
  return 'sdk-only';
}
