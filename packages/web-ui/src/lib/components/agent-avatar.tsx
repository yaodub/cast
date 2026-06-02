/**
 * AgentAvatar — circular identity badge for an agent (the persona).
 *
 * Used by both the admin shell and the operator chat shell. Distinct from
 * `ConsoleAvatar`, which represents an *activity* (Design / Configure /
 * Review). The agent avatar represents the *agent itself* — the thing being
 * shaped.
 *
 * Two design choices:
 *   1. Always teal-tinted, matching the operator chat surface so admin ↔
 *      chat read as the same product family. Server brokers don't get one
 *      of these — they aren't personas.
 *   2. Initials derived from the alias (first letter of first two
 *      hyphen-separated segments) carry per-agent identity within the
 *      shared teal family.
 *
 * Sizes: sm (24px) sits next to ConsoleAvatar md / the All Agents box
 * in the chat-overlay header so the three identity icons read at the
 * same scale. md (32px) for the admin sidebar agent rows, page titles,
 * and chat list/header rows. lg (48px) reserved for future profile-
 * style usage.
 */

interface Props {
  alias: string;
  size?: 'sm' | 'md' | 'lg';
  /** Active = brighter, more saturated. Sidebar uses this on URL match. */
  active?: boolean;
  /** Adds a teal glow shadow when active. Sidebar-only — the middle
   *  column doesn't need a "selected" cue since it IS the focus. */
  glow?: boolean;
}

const SIZE_STYLES = {
  sm: { box: 'w-6 h-6', text: 'text-[10px]' },
  md: { box: 'w-8 h-8', text: 'text-xs' },
  lg: { box: 'w-12 h-12', text: 'text-base' },
};

export function AgentAvatar({ alias, size = 'sm', active = false, glow = false }: Props) {
  const sz = SIZE_STYLES[size];
  const initials = initialsFor(alias);
  const tone = active
    ? `bg-teal-600 text-white${glow ? ' shadow-[0_0_14px_rgba(20,184,166,0.5)]' : ''}`
    : 'bg-teal-900/40 text-teal-200 ring-1 ring-teal-500/30';
  return (
    <span
      class={`${sz.box} ${sz.text} ${tone} rounded-full flex items-center justify-center font-semibold shrink-0 select-none`}
      aria-hidden
    >
      {initials}
    </span>
  );
}

function initialsFor(alias: string): string {
  const parts = alias.split('-').filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return parts[0]!.slice(0, 2).toUpperCase();
}
