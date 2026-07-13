import type { ComponentChildren } from 'preact';
import { PenTool, Sliders, ShieldCheck } from '../brand/Icon';

function cap(s: string) {
  return s[0]!.toUpperCase() + s.slice(1);
}

export type ConsoleKind = 'design' | 'configure' | 'review';

/**
 * Per-console color palette + icon. Mirrors the actual admin web UI tokens
 * defined in packages/web-ui/src/admin/components/icons.tsx and the role
 * accent shadows in packages/web-ui/src/admin/layout.tsx. Keep in sync.
 *
 *   design    sky-500  #0ea5e9   (icon: pen-tool)
 *   configure amber-600 #f59e0b  (icon: sliders-horizontal)
 *   review    emerald-600 #059669 (icon: shield-check; only at All-Agents scope)
 *
 * For docs prose contrast we use the one-shade-darker token for text/labels
 * (sky-600 / amber-700 / emerald-700) and the admin's base hue for icons,
 * borders, and translucent fills.
 */
export const consoleTheme: Record<
  ConsoleKind,
  { fg: string; icon: string; bg: string; border: string; label: string }
> = {
  design: {
    fg: '#0284C7',
    icon: '#0EA5E9',
    bg: 'rgba(14, 165, 233, 0.07)',
    border: 'rgba(14, 165, 233, 0.32)',
    label: '#0284C7',
  },
  configure: {
    fg: '#B45309',
    icon: '#F59E0B',
    bg: 'rgba(245, 158, 11, 0.08)',
    border: 'rgba(245, 158, 11, 0.32)',
    label: '#B45309',
  },
  review: {
    fg: '#047857',
    icon: '#059669',
    bg: 'rgba(5, 150, 105, 0.07)',
    border: 'rgba(5, 150, 105, 0.32)',
    label: '#047857',
  },
};

export function consoleIcon(kind: ConsoleKind, s = 14): ComponentChildren {
  if (kind === 'design') return <PenTool s={s} />;
  if (kind === 'configure') return <Sliders s={s} />;
  return <ShieldCheck s={s} />;
}

/**
 * ConsoleChip — THE standardized inline tag for referencing a console in
 * running prose. Always use this instead of bare "Configure console" text or
 * raw colored spans. Every console reference in docs prose should render as a
 * chip; this is the convention.
 *
 *   Yes:  "tell <ConsoleChip kind="configure" /> to wire up Telegram"
 *   No:   "tell the Configure console to wire up Telegram"
 *
 * Naming: the unqualified name (Design / Configure / Review) refers to the
 * fleet-scope console. For per-agent variants, write "Per-agent" as a prose
 * qualifier outside the chip — e.g., "Per-agent <ConsoleChip kind='configure' />".
 * The chip itself doesn't distinguish scope; context does.
 */
export function ConsoleChip({
  kind,
  label,
}: {
  kind: ConsoleKind;
  label?: string;
}) {
  const theme = consoleTheme[kind];
  const text = label ?? cap(kind);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        color: theme.label,
        fontWeight: 500,
        verticalAlign: 'middle',
        lineHeight: 1,
      }}
    >
      <ConsoleAvatar kind={kind} size={18} />
      <span>{text}</span>
    </span>
  );
}

/**
 * ConsolePageContext — THE standardized banner for marking a docs page as
 * scoped to a particular console. Drop it just below the lede on any page
 * whose entire content lives inside one console.
 *
 *   <ConsolePageContext kind="configure" />
 *
 * Carries the console's color identity. Renders as a small pill-shaped
 * label, not a heavy alert.
 */
export function ConsolePageContext({
  kind,
  name,
}: {
  kind: ConsoleKind;
  /** Override the displayed name — use this for "Per-agent Configure", etc. */
  name?: string;
}) {
  const theme = consoleTheme[kind];
  const text = name ?? cap(kind);
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 6,
        border: `1px solid ${theme.border}`,
        background: theme.bg,
        color: theme.label,
        fontSize: 12,
        fontFamily: 'JetBrains Mono, monospace',
        letterSpacing: '0.03em',
        fontWeight: 500,
        marginBottom: 24,
      }}
    >
      {consoleIcon(kind, 13)}
      <span>This page lives in {text}</span>
    </div>
  );
}

/**
 * ConsoleAvatar — the "app-icon" affordance for a console agent: a
 * rounded square with the role glyph on its color background. Mirrors
 * the admin UI's ConsoleAvatar component (`packages/web-ui/src/admin/
 * components/console-avatar.tsx`), which reads as "dev-time tool" vs
 * the round AgentAvatar used for runtime agents.
 */
export function ConsoleAvatar({ kind, size = 24 }: { kind: ConsoleKind; size?: number }) {
  const theme = consoleTheme[kind];
  return (
    <span
      aria-label={cap(kind)}
      title={cap(kind)}
      style={{
        width: size,
        height: size,
        background: theme.icon,
        color: 'white',
        borderRadius: 5,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {consoleIcon(kind, Math.round(size * 0.58))}
    </span>
  );
}

/**
 * AskConsole — THE standardized "you can say something like this" hint
 * format for sample requests to a console agent throughout the docs.
 *
 * Visual anchor is the console agent's avatar (the rounded-square
 * app-icon from the admin UI) plus a short text label, followed by an
 * input-style box containing the sample prompt. Deliberately has no
 * send button — the box is a sample, not an interactive control, and
 * an arrow in a rounded square reads as a button when it isn't one.
 * No agent reply rendered — the prose around the hint covers what
 * happens next.
 *
 *   <AskConsole kind="configure">
 *     Approve Sam for default channel access.
 *   </AskConsole>
 */
export function AskConsole({
  kind,
  children,
}: {
  kind: ConsoleKind;
  children: ComponentChildren;
}) {
  const theme = consoleTheme[kind];
  return (
    <div style={{ margin: '4px 0 22px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <ConsoleAvatar kind={kind} size={26} />
        <span
          style={{
            fontSize: 11,
            fontFamily: 'JetBrains Mono, monospace',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: theme.label,
            fontWeight: 600,
          }}
        >
          You ask {cap(kind)}
        </span>
      </div>
      <div
        style={{
          padding: '12px 16px',
          border: `1px solid ${theme.border}`,
          borderRadius: 8,
          background: theme.bg,
          fontSize: 15,
          lineHeight: 1.5,
          color: 'var(--fg)',
          fontStyle: 'italic',
        }}
      >
        {children}
      </div>
    </div>
  );
}
