// Hero tab switcher — toggles the hero between the two authoring surfaces:
// Claude Code (terminal) and the Design agent (browser console). Both are
// dark "screenshot" diagrams now, so the switch reads as one window changing
// mode rather than two unrelated widgets. Default is Claude Code (the mature
// path). Only the active diagram mounts, so its loop restarts on switch.

import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { HeroDiagram } from './HeroDiagram';
import { HeroDiagram2 } from './HeroDiagram2';
import { ConsoleAvatar } from '../docs/consoleTheme';

type Tab = 'claude' | 'design';

// The tab strip is transparent — only the tabs read above the page. The active
// tab takes its diagram's own dark surface and connects down into the window.
// The inactive tab is a distinctly lighter slate, deliberately NOT any diagram
// surface (the diagram's own dark navy is ~#0a1028–#191e35), so it never blends
// into the active diagram it sits against.
const INACTIVE_BG = '#3a4150';
const BORDER = '#1f2937';
const SURFACE: Record<Tab, string> = { claude: '#000000', design: '#0a1028' };
const ACCENT: Record<Tab, string> = { claude: '#ec4899', design: '#38bdf8' };

// Small Claude Code pixel mark — same silhouette as the banner in HeroDiagram2
// / the static ClaudeCodeMock, sized down to sit in a tab.
function ClaudeMark({ color }: { color: string }) {
  const d = [
    'M3 0H15V4H17V6H15V8H3V6H1V4H3Z',
    'M5 2H6V4H5Z',
    'M12 2H13V4H12Z',
    'M4 8H5V10H4Z',
    'M6 8H7V10H6Z',
    'M11 8H12V10H11Z',
    'M13 8H14V10H13Z',
  ].join(' ');
  return (
    <svg
      width={29}
      height={16}
      viewBox="0 0 18 10"
      aria-hidden="true"
      shapeRendering="crispEdges"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d={d} fill={color} style={{ fillRule: 'evenodd' }} />
    </svg>
  );
}

// "Preview" marker on the Design tab — in the design console's own sky tone
// rather than the green Seatbelts badge, so it doesn't fight the tab's hue.
function PreviewPill() {
  return (
    <span
      style={{
        fontSize: 9,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        fontWeight: 700,
        color: ACCENT.design,
        border: '1px solid rgba(56, 189, 248, 0.45)',
        borderRadius: 4,
        padding: '1px 5px',
        lineHeight: 1.4,
      }}
    >
      Preview
    </span>
  );
}

function TabButton({
  kind,
  active,
  first,
  onClick,
  children,
}: {
  kind: Tab;
  active: boolean;
  first?: boolean;
  onClick: () => void;
  children: ComponentChildren;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '9px 16px 10px',
        // Overlap the window's top border so the active tab connects to the
        // diagram surface below it; the inactive tab keeps its own bottom edge.
        marginBottom: -1,
        // Active tab takes its diagram's surface; inactive is a lighter slate
        // that never matches a diagram tone.
        background: active ? SURFACE[kind] : INACTIVE_BG,
        color: active ? '#f9fafb' : '#9ca3af',
        borderTop: `2px solid ${active ? ACCENT[kind] : 'transparent'}`,
        borderRight: `1px solid ${BORDER}`,
        // Only the leftmost tab needs its own left border; the others reuse the
        // previous tab's right border as their left edge (no doubled divider).
        borderLeft: first ? `1px solid ${BORDER}` : 'none',
        borderBottom: `1px solid ${active ? SURFACE[kind] : BORDER}`,
        cursor: 'pointer',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 13,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

export function HeroTabs() {
  const [tab, setTab] = useState<Tab>('claude');
  const claudeActive = tab === 'claude';
  const designActive = tab === 'design';
  return (
    <div>
      {/* Tab strip — transparent; sits above the window so the active tab can
          overlap and cover the window's top border where they meet. */}
      <div style={{ display: 'flex', position: 'relative', zIndex: 1 }}>
        <TabButton kind="claude" active={claudeActive} first onClick={() => setTab('claude')}>
          <span style={{ display: 'inline-flex', opacity: claudeActive ? 1 : 0.5 }}>
            <ClaudeMark color={ACCENT.claude} />
          </span>
          <span>Design with Claude Code</span>
        </TabButton>
        <TabButton kind="design" active={designActive} onClick={() => setTab('design')}>
          <span style={{ display: 'inline-flex', opacity: designActive ? 1 : 0.5 }}>
            <ConsoleAvatar kind="design" size={16} />
          </span>
          <span>Agent designer</span>
          <PreviewPill />
        </TabButton>
      </div>

      {/* Diagram window. */}
      <div style={{ border: `1px solid ${BORDER}`, overflow: 'hidden', background: SURFACE[tab] }}>
        {claudeActive ? <HeroDiagram2 /> : <HeroDiagram />}
      </div>
    </div>
  );
}
