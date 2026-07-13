import type { ComponentChildren } from 'preact';
import { Code } from '../../components/ui/Code';
import { Placeholder } from '../../components/site/Placeholder';
import {
  proseP,
  proseH2,
  proseUl,
} from '../../components/docs/DocsLayout';

export type HIWThumb = 'folder' | 'reach' | 'channels' | 'peers';

export interface HIWPillar {
  slug: string;
  pillar: string;
  claim: string;
  blurb: string[];
  thumb: HIWThumb;
}

export interface HIWSection {
  h2: string;
  body: ComponentChildren;
}

export interface HIWDeep {
  title: string;
  lede: string;
  sections: HIWSection[];
}

function asciiClass(ch: string, onShadedLine: boolean, onPipeLine: boolean): string {
  if (ch === '░') return 'fig-shade';
  if (ch === '═') return 'fig-harness';
  if (ch === '╪' || ch === '▼' || ch === '▲' || ch === '◄' || ch === '►') {
    return 'fig-arrow';
  }
  if (ch === '│' && (onShadedLine || onPipeLine)) return 'fig-arrow';
  return '';
}

function AsciiFigure({ art, caption }: { art: string; caption?: string }) {
  const parts: { text: string; cls: string }[] = [];
  let cur: { text: string; cls: string } = { text: '', cls: '' };
  const lines = art.split('\n');
  lines.forEach((line, idx) => {
    const onShadedLine = line.includes('░');
    // "Pipe line" = the line consists only of │ and spaces (it's an arrow continuation,
    // not a box border row).
    const onPipeLine = line.includes('│') && /^[ │]+$/.test(line);
    for (const ch of line) {
      const c = asciiClass(ch, onShadedLine, onPipeLine);
      if (c === cur.cls) {
        cur.text += ch;
      } else {
        if (cur.text) parts.push(cur);
        cur = { text: ch, cls: c };
      }
    }
    if (idx < lines.length - 1) {
      if (cur.cls === '') {
        cur.text += '\n';
      } else {
        if (cur.text) parts.push(cur);
        cur = { text: '\n', cls: '' };
      }
    }
  });
  if (cur.text) parts.push(cur);
  return (
    <div class="code" style={{ margin: '0 0 22px' }}>
      {caption && (
        <div class="code-head">
          <span>{caption}</span>
        </div>
      )}
      <pre style={{ fontSize: 13.5, lineHeight: 1.45 }}>
        {parts.map((p, i) => (
          <span key={i} class={p.cls || undefined}>
            {p.text}
          </span>
        ))}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SVG figure primitives (HIW pillar diagrams)
// ---------------------------------------------------------------------------

function SvgFigureFrame({
  caption,
  children,
}: {
  caption?: string;
  children: any;
}) {
  return (
    <div class="code" style={{ margin: '0 0 22px' }}>
      {caption && (
        <div class="code-head">
          <span>{caption}</span>
        </div>
      )}
      <div style={{ padding: '20px 24px', color: 'var(--code-fg)' }}>{children}</div>
    </div>
  );
}

function FigDotsPattern({ id }: { id: string }) {
  return (
    <pattern id={id} width={6} height={6} patternUnits="userSpaceOnUse">
      <circle cx={1} cy={1} r={0.9} class="fig-shade" fill="currentColor" />
    </pattern>
  );
}

// Shared layout constants for the reach perimeter family (figs 1/2/3).
// Anchored so all three figures share the same harness line + agent box position.
const PERIM_W = 520;
const PERIM_H = 200;
const PERIM_ZONE_H = 64;
const PERIM_HARNESS_Y = 88;
const PERIM_AGENT_Y = 152;
const PERIM_AGENT_W = 100;
const PERIM_AGENT_H = 36;
const PERIM_GAP = 44; // half-width of the gap where a label breaks the harness

function FigZone({ label, patternId, labelHalfWidth = 56 }: { label: string; patternId: string; labelHalfWidth?: number }) {
  const mid = PERIM_W / 2;
  return (
    <>
      <rect x={0} y={0} width={PERIM_W} height={PERIM_ZONE_H} fill={`url(#${patternId})`} />
      <rect
        x={mid - labelHalfWidth}
        y={PERIM_ZONE_H / 2 - 10}
        width={labelHalfWidth * 2}
        height={20}
        fill="var(--code-bg)"
      />
      <text
        x={mid}
        y={PERIM_ZONE_H / 2}
        text-anchor="middle"
        dy="0.35em"
        class="fig-shade"
        fill="currentColor"
        font-size={14}
      >
        {label}
      </text>
    </>
  );
}

function FigHarness({ label = 'harness' }: { label?: string }) {
  // Continuous double-line so arrows can cross at any x without collision.
  // Label hangs above the line at the left as a header-style annotation.
  return (
    <>
      {[PERIM_HARNESS_Y, PERIM_HARNESS_Y + 5].map((y) => (
        <line
          key={y}
          x1={0}
          y1={y}
          x2={PERIM_W}
          y2={y}
          class="fig-harness"
          stroke="currentColor"
          stroke-width={1.4}
        />
      ))}
      <text
        x={16}
        y={PERIM_HARNESS_Y - 8}
        text-anchor="start"
        class="fig-harness"
        fill="currentColor"
        font-size={11}
        style={{ letterSpacing: '0.06em' }}
      >
        {label}
      </text>
    </>
  );
}

function FigAgentBox() {
  const mid = PERIM_W / 2;
  return (
    <>
      <rect
        x={mid - PERIM_AGENT_W / 2}
        y={PERIM_AGENT_Y}
        width={PERIM_AGENT_W}
        height={PERIM_AGENT_H}
        rx={2}
        fill="none"
        stroke="currentColor"
        stroke-width={1.3}
      />
      <text
        x={mid}
        y={PERIM_AGENT_Y + PERIM_AGENT_H / 2}
        text-anchor="middle"
        dy="0.35em"
        fill="currentColor"
        font-size={13}
      >
        agent
      </text>
    </>
  );
}

export function PerimeterFigure({ caption }: { caption?: string }) {
  return (
    <SvgFigureFrame caption={caption}>
      <svg
        viewBox={`0 0 ${PERIM_W} ${PERIM_H}`}
        style={{ display: 'block', width: '100%', maxWidth: PERIM_W }}
        font-family="ui-monospace, 'JetBrains Mono', monospace"
        font-size={13}
      >
        <defs>
          <FigDotsPattern id="perim-dots" />
        </defs>
        <FigZone label="out of bounds" patternId="perim-dots" />
        <FigHarness />
        <FigAgentBox />
      </svg>
    </SvgFigureFrame>
  );
}

// Three labeled exits/entries that pierce the harness. Used by figs 2 and 3.
// dir='up' = outbound (arrowhead in the zone, label below the harness, shaft rises from above the agent)
// dir='down' = inbound (label inside the zone, arrowhead just above the agent, shaft descends through the harness)
function FigGateways({ items, dir }: { items: string[]; dir: 'up' | 'down' }) {
  // Symmetric distribution across the full width: center on agent, outer arrows
  // flank it. This balances the figure and keeps the middle shaft aligned with
  // the agent column.
  const xs = [0.20, 0.50, 0.80].map((f) => PERIM_W * f);
  const arrowSize = 7;
  return (
    <>
      {xs.map((x, i) => {
        if (dir === 'up') {
          // Stop just below the zone label so the arrowhead "points into" the
          // label (e.g., 'internet') rather than passing through it.
          const shaftTop = PERIM_ZONE_H / 2 + 14;
          const shaftBottom = PERIM_AGENT_Y - 6;
          const labelY = PERIM_HARNESS_Y + 28;
          return (
            <g key={i}>
              <line
                x1={x}
                y1={shaftBottom}
                x2={x}
                y2={shaftTop}
                class="fig-arrow"
                stroke="currentColor"
                stroke-width={1.3}
              />
              <polygon
                points={`${x},${shaftTop - arrowSize} ${x - arrowSize / 2},${shaftTop} ${x + arrowSize / 2},${shaftTop}`}
                class="fig-arrow"
                fill="currentColor"
              />
              {/* clear-band under the label so the shaft breaks cleanly through it */}
              <rect
                x={x - 36}
                y={labelY - 9}
                width={72}
                height={18}
                fill="var(--code-bg)"
              />
              <text
                x={x}
                y={labelY}
                text-anchor="middle"
                dy="0.35em"
                fill="currentColor"
                font-size={13}
              >
                {items[i]}
              </text>
            </g>
          );
        } else {
          // inbound: long shaft from below the label down to just above the agent
          const shaftStartY = PERIM_ZONE_H / 2 + 14;
          const shaftEndY = PERIM_AGENT_Y - 6;
          const arrowTipY = shaftEndY;
          return (
            <g key={i}>
              {/* label sits inside the dotted zone, on a clear-band */}
              <rect
                x={x - 36}
                y={PERIM_ZONE_H / 2 - 10}
                width={72}
                height={20}
                fill="var(--code-bg)"
              />
              <text
                x={x}
                y={PERIM_ZONE_H / 2}
                text-anchor="middle"
                dy="0.35em"
                class="fig-shade"
                fill="currentColor"
                font-size={13}
              >
                {items[i]}
              </text>
              <line
                x1={x}
                y1={shaftStartY}
                x2={x}
                y2={arrowTipY - arrowSize}
                class="fig-arrow"
                stroke="currentColor"
                stroke-width={1.3}
              />
              <polygon
                points={`${x},${arrowTipY} ${x - arrowSize / 2},${arrowTipY - arrowSize} ${x + arrowSize / 2},${arrowTipY - arrowSize}`}
                class="fig-arrow"
                fill="currentColor"
              />
            </g>
          );
        }
      })}
    </>
  );
}

export function OutboundFigure({ caption }: { caption?: string }) {
  return (
    <SvgFigureFrame caption={caption}>
      <svg
        viewBox={`0 0 ${PERIM_W} ${PERIM_H}`}
        style={{ display: 'block', width: '100%', maxWidth: PERIM_W }}
        font-family="ui-monospace, 'JetBrains Mono', monospace"
        font-size={13}
      >
        <defs>
          <FigDotsPattern id="outbound-dots" />
        </defs>
        <FigZone label="internet" patternId="outbound-dots" labelHalfWidth={44} />
        <FigHarness />
        <FigGateways items={['network', 'extension', 'service']} dir="up" />
        <FigAgentBox />
      </svg>
    </SvgFigureFrame>
  );
}

export function InboundFigure({ caption }: { caption?: string }) {
  return (
    <SvgFigureFrame caption={caption}>
      <svg
        viewBox={`0 0 ${PERIM_W} ${PERIM_H}`}
        style={{ display: 'block', width: '100%', maxWidth: PERIM_W }}
        font-family="ui-monospace, 'JetBrains Mono', monospace"
        font-size={13}
      >
        <defs>
          <FigDotsPattern id="inbound-dots" />
        </defs>
        {/* No center label — the three gateway labels sit inside the zone instead */}
        <rect x={0} y={0} width={PERIM_W} height={PERIM_ZONE_H} fill="url(#inbound-dots)" />
        <FigHarness />
        <FigGateways items={['telegram', 'web']} dir="down" />
        <FigAgentBox />
      </svg>
    </SvgFigureFrame>
  );
}

// ---------------------------------------------------------------------------
// HIW index thumbnails — small SVG illustrations for each pillar card.
// Render bare (no .code frame); the card itself provides the surround.
// ---------------------------------------------------------------------------

const THUMB_W = 340;
const THUMB_H = 200;

function ThumbFrame({ children }: { children: any }) {
  return (
    <svg
      viewBox={`0 0 ${THUMB_W} ${THUMB_H}`}
      style={{ display: 'block', width: '100%', maxWidth: THUMB_W }}
      font-family="ui-monospace, 'JetBrains Mono', monospace"
      font-size={12}
    >
      {children}
    </svg>
  );
}

export function ThumbFolderSvg() {
  // Monotone tree. RO badge = dashed outline (locked); RW = solid (open).
  const rowH = 26;
  const startY = 22;
  const indentX = 28;
  const rows: { depth: number; name: string; tag?: 'RO' | 'RW'; last?: boolean; under?: boolean }[] = [
    { depth: 0, name: 'agent/' },
    { depth: 1, name: 'blueprint/', tag: 'RO' },
    { depth: 2, name: 'prompt.md', tag: 'RO', last: true, under: true },
    { depth: 1, name: 'memory/', tag: 'RW' },
    { depth: 1, name: 'home/', tag: 'RW', last: true },
  ];
  return (
    <ThumbFrame>
      {rows.map((r, i) => {
        const y = startY + i * rowH;
        const x = 16 + r.depth * indentX;
        return (
          <g key={i}>
            {r.depth > 0 && !r.under && (
              <>
                <line
                  x1={x - 14}
                  y1={y - rowH + 6}
                  x2={x - 14}
                  y2={r.last ? y : y + rowH - 6}
                  stroke="currentColor"
                  stroke-opacity={0.45}
                  stroke-width={1}
                />
                <line
                  x1={x - 14}
                  y1={y}
                  x2={x - 4}
                  y2={y}
                  stroke="currentColor"
                  stroke-opacity={0.45}
                  stroke-width={1}
                />
              </>
            )}
            {r.under && (
              <>
                <line
                  x1={x - 14}
                  y1={y - rowH + 6}
                  x2={x - 14}
                  y2={y}
                  stroke="currentColor"
                  stroke-opacity={0.45}
                  stroke-width={1}
                />
                <line
                  x1={x - 14}
                  y1={y}
                  x2={x - 4}
                  y2={y}
                  stroke="currentColor"
                  stroke-opacity={0.45}
                  stroke-width={1}
                />
              </>
            )}
            <text x={x} y={y} dy="0.35em" fill="currentColor" font-size={13}>
              {r.name}
            </text>
            {r.tag && (
              <>
                <rect
                  x={THUMB_W - 44}
                  y={y - 8}
                  width={32}
                  height={16}
                  rx={2}
                  fill="none"
                  stroke="currentColor"
                  stroke-opacity={r.tag === 'RO' ? 0.45 : 0.85}
                  stroke-width={1}
                  stroke-dasharray={r.tag === 'RO' ? '3 2' : undefined}
                />
                <text
                  x={THUMB_W - 28}
                  y={y}
                  dy="0.35em"
                  text-anchor="middle"
                  fill="currentColor"
                  fill-opacity={r.tag === 'RO' ? 0.55 : 0.95}
                  font-size={10.5}
                  style={{ letterSpacing: '0.06em' }}
                >
                  {r.tag}
                </text>
              </>
            )}
          </g>
        );
      })}
    </ThumbFrame>
  );
}

export function ThumbReachSvg() {
  // Monotone perimeter: faint dotted zone, harness double-line, agent box.
  const zoneH = 56;
  const harnessY = 80;
  const agentY = 130;
  const agentW = 100;
  const agentH = 36;
  const mid = THUMB_W / 2;
  return (
    <ThumbFrame>
      <defs>
        <pattern id="thumb-reach-dots" width={6} height={6} patternUnits="userSpaceOnUse">
          <circle cx={1} cy={1} r={0.9} fill="currentColor" fill-opacity={0.45} />
        </pattern>
      </defs>
      <rect x={0} y={0} width={THUMB_W} height={zoneH} fill="url(#thumb-reach-dots)" />
      <rect
        x={mid - 50}
        y={zoneH / 2 - 9}
        width={100}
        height={18}
        fill="var(--bg-elev)"
      />
      <text
        x={mid}
        y={zoneH / 2}
        text-anchor="middle"
        dy="0.35em"
        fill="currentColor"
        fill-opacity={0.7}
        font-size={12}
      >
        out of bounds
      </text>
      {[harnessY, harnessY + 4].map((y) => (
        <line
          key={y}
          x1={0}
          y1={y}
          x2={THUMB_W}
          y2={y}
          stroke="currentColor"
          stroke-opacity={0.75}
          stroke-width={1.2}
        />
      ))}
      <text
        x={14}
        y={harnessY - 8}
        fill="currentColor"
        fill-opacity={0.65}
        font-size={10.5}
        style={{ letterSpacing: '0.06em' }}
      >
        harness
      </text>
      <rect
        x={mid - agentW / 2}
        y={agentY}
        width={agentW}
        height={agentH}
        rx={2}
        fill="none"
        stroke="currentColor"
        stroke-width={1.2}
      />
      <text
        x={mid}
        y={agentY + agentH / 2}
        text-anchor="middle"
        dy="0.35em"
        fill="currentColor"
        font-size={13}
      >
        agent
      </text>
    </ThumbFrame>
  );
}

export function ThumbChannelsSvg() {
  // Three transports (users/alerts/tasks) descend through channel labels into
  // the agent. Channel labels sit just above the agent box.
  const cols = [0.18, 0.50, 0.82].map((f) => THUMB_W * f);
  const sources = ['users', 'alerts', 'tasks'];
  const channels = ['#default', '#email', '#cron'];
  const srcY = 18;
  const srcH = 28;
  const agentY = 148;
  const agentH = 34;
  const labelY = agentY - 10;       // channel label sits 10px above agent box top
  const arrowTipY = labelY - 10;    // arrowhead sits 10px above label
  return (
    <ThumbFrame>
      {cols.map((x, i) => (
        <g key={i}>
          {/* source box */}
          <rect
            x={x - 38}
            y={srcY}
            width={76}
            height={srcH}
            rx={2}
            fill="none"
            stroke="currentColor"
            stroke-width={1.1}
          />
          <text
            x={x}
            y={srcY + srcH / 2}
            text-anchor="middle"
            dy="0.35em"
            fill="currentColor"
            font-size={12}
          >
            {sources[i]}
          </text>
          {/* arrow shaft from below source to just above channel label */}
          <line
            x1={x}
            y1={srcY + srcH + 4}
            x2={x}
            y2={arrowTipY - 7}
            stroke="currentColor"
            stroke-opacity={0.7}
            stroke-width={1.2}
          />
          <polygon
            points={`${x},${arrowTipY} ${x - 5},${arrowTipY - 7} ${x + 5},${arrowTipY - 7}`}
            fill="currentColor"
            fill-opacity={0.7}
          />
          {/* channel label, just above the agent box */}
          <text
            x={x}
            y={labelY}
            text-anchor="middle"
            dy="0.35em"
            fill="currentColor"
            font-size={12.5}
          >
            {channels[i]}
          </text>
        </g>
      ))}
      {/* agent box spans wide at the bottom */}
      <rect
        x={20}
        y={agentY}
        width={THUMB_W - 40}
        height={agentH}
        rx={2}
        fill="none"
        stroke="currentColor"
        stroke-width={1.3}
      />
      <text
        x={THUMB_W / 2}
        y={agentY + agentH / 2}
        text-anchor="middle"
        dy="0.35em"
        fill="currentColor"
        font-size={13}
      >
        agent
      </text>
    </ThumbFrame>
  );
}

export function ThumbPeersSvg() {
  // Log-style peer exchange — monotone. Uniform 22px row spacing throughout;
  // the divider sits at the midpoint between the declared row and the first
  // exchange row, so visual rhythm is even.
  const padX = 14;
  const headerY = 24;
  const rowH = 22;
  const declaredY = headerY + 26;          // 50
  const dividerY = declaredY + rowH / 2 + 5; // 66
  const firstRowY = dividerY + rowH / 2 + 5; // 82
  const LEFT_X = padX;
  const MID_X = 124;
  const RIGHT_X = 172;
  const exchanges: { left: string; arrow: string; right: string }[] = [
    { left: 'writer', arrow: 'ask →', right: 'researcher' },
    { left: 'researcher', arrow: 'ans →', right: 'writer' },
    { left: 'writer', arrow: '✓', right: 'draft ready' },
  ];
  const lastRowY = firstRowY + (exchanges.length - 1) * rowH;
  const bottomRuleY = lastRowY + rowH / 2 + 6;

  return (
    <ThumbFrame>
      {/* header rule with inline label: ── peer log ──────────── */}
      <line x1={padX} y1={headerY - 2} x2={padX + 26} y2={headerY - 2} stroke="currentColor" stroke-opacity={0.55} stroke-width={1} />
      <text x={padX + 34} y={headerY} dy="0.35em" fill="currentColor" font-size={11.5} style={{ letterSpacing: '0.06em' }} fill-opacity={0.75}>
        peer log
      </text>
      <line x1={padX + 88} y1={headerY - 2} x2={THUMB_W - padX} y2={headerY - 2} stroke="currentColor" stroke-opacity={0.55} stroke-width={1} />

      {/* declared row */}
      <text x={LEFT_X} y={declaredY} dy="0.35em" fill="currentColor" font-size={12} fill-opacity={0.65}>
        reach:
      </text>
      <text x={RIGHT_X} y={declaredY} dy="0.35em" fill="currentColor" font-size={12} fill-opacity={0.95}>
        writer ↔ researcher
      </text>

      {/* divider between declared and the exchanges */}
      <line x1={padX} y1={dividerY} x2={THUMB_W - padX} y2={dividerY} stroke="currentColor" stroke-opacity={0.3} stroke-width={1} />

      {/* exchange rows */}
      {exchanges.map((r, i) => {
        const y = firstRowY + i * rowH;
        return (
          <g key={i}>
            <text x={LEFT_X} y={y} dy="0.35em" fill="currentColor" font-size={12} fill-opacity={0.95}>
              {r.left}
            </text>
            <text x={MID_X} y={y} dy="0.35em" fill="currentColor" font-size={12} fill-opacity={0.75}>
              {r.arrow}
            </text>
            <text x={RIGHT_X} y={y} dy="0.35em" fill="currentColor" font-size={12} fill-opacity={0.95}>
              {r.right}
            </text>
          </g>
        );
      })}

      {/* bottom rule */}
      <line x1={padX} y1={bottomRuleY} x2={THUMB_W - padX} y2={bottomRuleY} stroke="currentColor" stroke-opacity={0.55} stroke-width={1} />
    </ThumbFrame>
  );
}

// ---------------------------------------------------------------------------
// Knob widget primitives (used by channel anatomy + composition figures)
// ---------------------------------------------------------------------------

function AccessEmoji({ kind }: { kind: 'users' | 'peers' | 'internal' | 'anatomy' }) {
  const Item = ({ icon, on }: { icon: string; on: boolean }) => (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 18,
        lineHeight: 1,
        opacity: on ? 1 : 0.55,
      }}
    >
      <span>{icon}</span>
      <span
        style={{
          fontSize: 13,
          fontWeight: 700,
          color: on ? 'var(--code-fg)' : 'rgba(255,176,0,0.45)',
        }}
      >
        {on ? '✓' : '✗'}
      </span>
    </span>
  );
  const wrap = (...kids: any[]) => (
    <span style={{ display: 'inline-flex', gap: 16, verticalAlign: 'middle' }}>{kids}</span>
  );
  switch (kind) {
    case 'users':
      return wrap(<Item key="u" icon="👤" on />, <Item key="r" icon="🤖" on={false} />);
    case 'peers':
      return wrap(<Item key="u" icon="👤" on={false} />, <Item key="r" icon="🤖" on />);
    case 'internal':
      return wrap(<Item key="u" icon="👤" on={false} />, <Item key="r" icon="🤖" on={false} />);
    case 'anatomy':
      return wrap(
        <Item key="u-on" icon="👤" on />,
        <Item key="u-off" icon="👤" on={false} />,
        <Item key="r-on" icon="🤖" on />,
      );
    default:
      return null;
  }
}

function CapabilityList({ items }: { items: { name: string; disabled?: boolean }[] }) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '4px 12px',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 11.5,
        color: 'var(--code-fg)',
      }}
    >
      {items.map((item, i) => (
        <span
          key={i}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            opacity: item.disabled ? 0.55 : 0.95,
          }}
        >
          <span
            style={{
              display: 'inline-block',
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: item.disabled ? '#E63946' : '#7CC66A',
              flexShrink: 0,
            }}
          />
          {item.name}()
        </span>
      ))}
    </div>
  );
}

function MemorySlider({ position }: { position: 'ephemeral' | 'persistent' }) {
  const ACTIVE = '#7CC66A';
  const INACTIVE = 'rgba(160,160,160,0.45)';
  const isEphemeral = position === 'ephemeral';
  const dot = (active: boolean) => (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: active ? ACTIVE : INACTIVE,
        flexShrink: 0,
        zIndex: 1,
      }}
    />
  );
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        verticalAlign: 'middle',
      }}
    >
      <span style={{ fontSize: 10, opacity: isEphemeral ? 0.95 : 0.5 }}>ephemeral</span>
      <span
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          width: 70,
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: 4,
            right: 4,
            height: 1,
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'rgba(255,176,0,0.25)',
          }}
        />
        {dot(isEphemeral)}
        <span style={{ flex: 1 }} />
        {dot(!isEphemeral)}
      </span>
      <span style={{ fontSize: 10, opacity: !isEphemeral ? 0.95 : 0.5 }}>persistent</span>
    </span>
  );
}

function InstructionsBox({ snippet, placeholder }: { snippet?: string; placeholder?: boolean }) {
  return (
    <div
      style={{
        border: '1px solid rgba(255,176,0,0.35)',
        borderRadius: 3,
        padding: '6px 8px',
        background: 'rgba(255,176,0,0.04)',
        fontSize: 10.5,
        lineHeight: 1.4,
        minHeight: 38,
        fontFamily: 'JetBrains Mono, monospace',
        color: 'var(--code-fg)',
        opacity: placeholder ? 0.4 : 0.85,
        fontStyle: placeholder ? 'italic' : 'normal',
      }}
    >
      {snippet ? `▌${snippet}` : '▌'}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Channel anatomy + composition cards
// ---------------------------------------------------------------------------

const cardHead = {
  padding: '6px 12px',
  borderBottom: '1px solid rgba(255, 176, 0, 0.25)',
  fontSize: 10.5,
  letterSpacing: '0.08em',
  textTransform: 'uppercase' as const,
  opacity: 0.75,
  display: 'flex',
  justifyContent: 'space-between',
};

const knobNameStyle = {
  fontSize: 10.5,
  letterSpacing: '0.06em',
  opacity: 0.65,
  fontFamily: 'JetBrains Mono, monospace',
};

function ChannelAnatomyFigure({ caption }: { caption?: string }) {
  const rows: { name: string; widget: any; desc: string }[] = [
    {
      name: 'ACCESS',
      widget: <AccessEmoji kind="anatomy" />,
      desc: 'who is allowed to address it',
    },
    {
      name: 'CAPABILITIES',
      widget: (
        <CapabilityList
          items={[
            { name: 'web_fetch' },
            { name: 'send_email', disabled: true },
            { name: 'read_calendar' },
            { name: 'task_schedule', disabled: true },
            { name: 'push_to_channel' },
            { name: 'query_peer' },
          ]}
        />
      ),
      desc: 'which tools the agent can use',
    },
    {
      name: 'WORKING MEMORY',
      widget: <MemorySlider position="persistent" />,
      desc: 'whether short-term context survives between fires',
    },
    {
      name: 'INSTRUCTIONS',
      widget: <InstructionsBox placeholder snippet="(free text)" />,
      desc: 'how the agent should behave',
    },
  ];
  return (
    <div class="code" style={{ margin: '0 0 22px' }}>
      {caption && (
        <div class="code-head">
          <span>{caption}</span>
        </div>
      )}
      <div style={{ color: 'var(--code-fg)' }}>
        {rows.map((r) => (
          <div
            key={r.name}
            style={{
              display: 'grid',
              gridTemplateColumns: '130px 1fr',
              padding: '12px 14px',
              gap: 14,
              alignItems: 'center',
              borderBottom: '1px solid rgba(255,176,0,0.12)',
            }}
          >
            <span style={knobNameStyle}>{r.name}</span>
            <div>
              <div style={{ marginBottom: 4 }}>{r.widget}</div>
              <div style={{ fontSize: 11, opacity: 0.6, fontFamily: 'Inter, sans-serif' }}>
                {r.desc}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

type ChannelCardConfig = {
  name: string;
  sub: string;
  access: 'users' | 'peers' | 'internal';
  capabilities: { name: string; disabled?: boolean }[];
  workingMemory: 'ephemeral' | 'persistent';
  instructions: string;
};

function ChannelCard({ cfg }: { cfg: ChannelCardConfig }) {
  const rows = [
    { name: 'ACCESS', widget: <AccessEmoji kind={cfg.access} /> },
    { name: 'CAPABILITIES', widget: <CapabilityList items={cfg.capabilities} /> },
    { name: 'WORKING MEMORY', widget: <MemorySlider position={cfg.workingMemory} /> },
    { name: 'INSTRUCTIONS', widget: <InstructionsBox snippet={cfg.instructions} /> },
  ];
  return (
    <div
      style={{
        border: '1px solid rgba(255,176,0,0.35)',
        borderRadius: 3,
        flex: 1,
        minWidth: 0,
        background: 'rgba(255,176,0,0.02)',
      }}
    >
      <div style={cardHead}>
        <span style={{ opacity: 1, color: 'var(--code-fg)' }}>{cfg.name}</span>
        <span>{cfg.sub}</span>
      </div>
      {rows.map((r) => (
        <div
          key={r.name}
          style={{
            padding: '10px 12px',
            borderBottom: '1px solid rgba(255,176,0,0.12)',
            minHeight: 48,
          }}
        >
          <div style={{ ...knobNameStyle, marginBottom: 6 }}>{r.name}</div>
          <div>{r.widget}</div>
        </div>
      ))}
    </div>
  );
}

function ChannelCompositionFigure({ caption, channels }: {
  caption?: string;
  channels: ChannelCardConfig[];
}) {
  return (
    <div class="code" style={{ margin: '0 0 22px' }}>
      {caption && (
        <div class="code-head">
          <span>{caption}</span>
        </div>
      )}
      <div style={{ padding: 14, display: 'flex', gap: 10, color: 'var(--code-fg)' }}>
        {channels.map((c) => <ChannelCard key={c.name} cfg={c} />)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversation lifecycle loop diagram
// ---------------------------------------------------------------------------

function ConversationLoopFigure({ caption }: { caption?: string }) {
  const w = 400;
  const h = 170;
  const topY = 16;
  const topH = 44;
  const botY = 118;
  const botH = 44;
  const lx = w / 2 - 60;
  const rx = w / 2 + 60;
  return (
    <div class="code" style={{ margin: '0 0 22px' }}>
      {caption && (
        <div class="code-head">
          <span>{caption}</span>
        </div>
      )}
      <div
        style={{
          padding: '14px 0',
          display: 'flex',
          justifyContent: 'center',
          color: 'var(--code-fg)',
        }}
      >
        <svg
          viewBox={`0 0 ${w} ${h}`}
          width="100%"
          style={{ maxWidth: w + 40, height: 'auto' }}
        >
          <rect x={20} y={topY} width={w - 40} height={topH} rx={3}
            fill="var(--bg-elev)" fill-opacity={0.3}
            stroke="currentColor" stroke-opacity={0.5} stroke-width={1.2} />
          <text x={w / 2} y={topY + 22} font-size={12}
            font-family="JetBrains Mono, monospace" text-anchor="middle" fill="currentColor">
            /memory/
          </text>
          <text x={w / 2} y={topY + 37} font-size={10}
            font-family="JetBrains Mono, monospace" text-anchor="middle"
            fill="currentColor" fill-opacity={0.6}>
            long-term, durable notes
          </text>

          <g class="fig-arrow" stroke="currentColor" fill="currentColor">
            <line x1={lx} y1={topY + topH + 4} x2={lx} y2={botY - 4} stroke-width={1.5} />
            <polygon points={`${lx - 4},${botY - 8} ${lx},${botY - 2} ${lx + 4},${botY - 8}`} />
          </g>
          <text x={lx - 8} y={(topY + topH + botY) / 2 + 4} font-size={10}
            font-family="JetBrains Mono, monospace" text-anchor="end"
            fill="currentColor" fill-opacity={0.75}>
            bootstrap
          </text>

          <g class="fig-arrow" stroke="currentColor" fill="currentColor">
            <line x1={rx} y1={botY} x2={rx} y2={topY + topH + 4} stroke-width={1.5} />
            <polygon points={`${rx - 4},${topY + topH + 8} ${rx},${topY + topH + 2} ${rx + 4},${topY + topH + 8}`} />
          </g>
          <text x={rx + 8} y={(topY + topH + botY) / 2 + 4} font-size={10}
            font-family="JetBrains Mono, monospace" text-anchor="start"
            fill="currentColor" fill-opacity={0.75}>
            cleanup
          </text>

          <rect x={20} y={botY} width={w - 40} height={botH} rx={3}
            fill="var(--bg-elev)" fill-opacity={0.3}
            class="fig-arrow"
            stroke="currentColor" stroke-opacity={1} stroke-width={1.8} />
          <text x={w / 2} y={botY + 22} font-size={12}
            font-family="JetBrains Mono, monospace" text-anchor="middle" fill="currentColor">
            conversation
          </text>
          <text x={w / 2} y={botY + 37} font-size={10}
            font-family="JetBrains Mono, monospace" text-anchor="middle"
            fill="currentColor" fill-opacity={0.6}>
            short-term working context
          </text>
        </svg>
      </div>
    </div>
  );
}

function ChannelsFigure({
  agent = 'agent',
  channels,
  caption,
}: {
  agent?: string;
  channels: string[];
  caption?: string;
}) {
  const chW = 72;
  const chH = 22;
  const chGap = 8;
  const totalW = channels.length * chW + (channels.length - 1) * chGap;
  const agentW = 80;
  const agentH = 24;
  const agentX = totalW / 2 - agentW / 2;
  const agentY = 6;
  const busY = 50;
  const chY = 70;
  const h = chY + chH + 6;
  return (
    <div class="code" style={{ margin: '0 0 22px' }}>
      {caption && (
        <div class="code-head">
          <span>{caption}</span>
        </div>
      )}
      <div
        style={{
          padding: '14px 0',
          display: 'flex',
          justifyContent: 'center',
          color: 'var(--code-fg)',
        }}
      >
        <svg
          viewBox={`0 0 ${totalW} ${h}`}
          width="100%"
          style={{ maxWidth: totalW + 40, height: 'auto' }}
        >
          <rect
            x={agentX}
            y={agentY}
            width={agentW}
            height={agentH}
            rx={3}
            fill="var(--bg-elev)"
            fillOpacity={0.3}
            stroke="currentColor"
            strokeOpacity={0.5}
            strokeWidth={1.2}
          />
          <text
            x={totalW / 2}
            y={agentY + 16}
            fontSize={11}
            fontFamily="JetBrains Mono, monospace"
            textAnchor="middle"
            fill="currentColor"
          >
            {agent}
          </text>
          <line
            x1={totalW / 2}
            y1={agentY + agentH}
            x2={totalW / 2}
            y2={busY}
            stroke="currentColor"
            strokeOpacity={0.3}
            strokeWidth={1}
          />
          <line
            x1={chW / 2}
            y1={busY}
            x2={totalW - chW / 2}
            y2={busY}
            stroke="currentColor"
            strokeOpacity={0.3}
            strokeWidth={1}
          />
          {channels.map((c, i) => {
            const x = i * (chW + chGap);
            const cx = x + chW / 2;
            return (
              <g key={i}>
                <line
                  x1={cx}
                  y1={busY}
                  x2={cx}
                  y2={chY}
                  stroke="currentColor"
                  strokeOpacity={0.3}
                  strokeWidth={1}
                />
                <rect
                  x={x}
                  y={chY}
                  width={chW}
                  height={chH}
                  rx={3}
                  fill="none"
                  stroke="currentColor"
                  strokeOpacity={0.45}
                  strokeWidth={1}
                />
                <text
                  x={cx}
                  y={chY + 14}
                  fontSize={9.5}
                  fontFamily="JetBrains Mono, monospace"
                  textAnchor="middle"
                  fill="currentColor"
                >
                  {c}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Peer roster card — captures "what an agent knows about its peers" as
// the small log-style view the system would emit when asked.
// ---------------------------------------------------------------------------

type RosterEntry = { peer: string; channel: string };

function PeerRosterCard({ owner, entries }: { owner: string; entries: RosterEntry[] }) {
  return (
    <div
      style={{
        border: '1px solid rgba(255,176,0,0.35)',
        borderRadius: 3,
        flex: 1,
        minWidth: 0,
        background: 'rgba(255,176,0,0.02)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={cardHead}>
        <span style={{ opacity: 1, color: 'var(--code-fg)' }}>
          {owner} · peer roster
        </span>
      </div>
      {entries.length === 0 ? (
        <div
          style={{
            padding: '16px 14px',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12.5,
            fontStyle: 'italic',
            opacity: 0.55,
          }}
        >
          (no peers reachable yet)
        </div>
      ) : (
        entries.map((e, i) => (
          <div
            key={e.peer + e.channel}
            style={{
              padding: '9px 14px',
              borderBottom:
                i < entries.length - 1
                  ? '1px solid currentColor'
                  : 'none',
              borderBottomColor: 'rgba(255,255,255,0.08)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 13,
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
            }}
          >
            <span style={{ opacity: 0.7 }}>↳</span>
            <span>{e.peer}</span>
            <span style={{ opacity: 0.55, fontSize: 11.5 }}>on</span>
            <span>
              <span style={{ opacity: 0.55 }}>#</span>
              {e.channel}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Exchange shapes — three traffic cards showing q/a, r/a, push as they
// would appear in a log of the system in motion.
// ---------------------------------------------------------------------------

type TrafficLine =
  | { kind: 'verb'; sender: string; verb: string; receiver: string; body?: string }
  | { kind: 'absence'; text: string }
  | { kind: 'event'; text: string };

type TeletextColor = 'cyan' | 'magenta' | 'green';

const TELETEXT_PALETTE: Record<TeletextColor, string> = {
  cyan: 'var(--y2k-crt-cyan, #5BB0E8)',
  magenta: 'var(--y2k-crt-magenta, #FF4FB1)',
  green: '#7CC66A',
};

function TrafficCard({
  scenario,
  color = 'cyan',
  lines,
}: {
  scenario: string;
  color?: TeletextColor;
  lines: TrafficLine[];
}) {
  const swatch = TELETEXT_PALETTE[color];
  return (
    <div>
      <div
        style={{
          display: 'inline-block',
          background: swatch,
          color: '#0A0E1A',
          padding: '1px 10px 2px',
          fontFamily: "'VT323', 'JetBrains Mono', monospace",
          fontSize: 17,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          fontWeight: 700,
          lineHeight: 1.15,
          marginBottom: 8,
        }}
      >
        ▌ Scenario
      </div>
      <div
        style={{
          fontSize: 14,
          lineHeight: 1.55,
          opacity: 0.95,
          marginBottom: 12,
          paddingLeft: 12,
          borderLeft: `3px solid ${swatch}`,
        }}
      >
        {scenario}
      </div>
      <div
        style={{
          borderTop: '1px solid rgba(255,176,0,0.25)',
          paddingTop: 10,
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 13,
        }}
      >
        {lines.map((line, i) => {
          if (line.kind === 'verb') {
            return (
              <div key={i} style={{ padding: '5px 0' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ minWidth: 130, display: 'inline-block' }}>
                    {line.sender}
                  </span>
                  <span style={{ opacity: 0.5 }}>─</span>
                  <span style={{ color: 'var(--accent)' }}>{line.verb}</span>
                  <span style={{ opacity: 0.5 }}>─→</span>
                  <span>{line.receiver}</span>
                </div>
                {line.body && (
                  <div
                    style={{
                      paddingLeft: 138,
                      marginTop: 2,
                      opacity: 0.7,
                      fontStyle: 'italic',
                      fontSize: 12.5,
                    }}
                  >
                    “{line.body}”
                  </div>
                )}
              </div>
            );
          }
          if (line.kind === 'absence') {
            return (
              <div
                key={i}
                style={{
                  padding: '5px 0 5px 24px',
                  opacity: 0.6,
                  fontStyle: 'italic',
                }}
              >
                ({line.text})
              </div>
            );
          }
          return (
            <div
              key={i}
              style={{
                padding: '5px 0 5px 24px',
                fontStyle: 'italic',
                opacity: 0.85,
              }}
            >
              ── {line.text} ──
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ExchangeShapesFigure({
  caption,
  cards,
}: {
  caption?: string;
  cards: { scenario: string; color?: TeletextColor; lines: TrafficLine[] }[];
}) {
  return (
    <div class="code" style={{ margin: '0 0 22px' }}>
      {caption && (
        <div class="code-head">
          <span>{caption}</span>
        </div>
      )}
      <div
        style={{
          padding: '16px 18px',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
          color: 'var(--code-fg)',
        }}
      >
        {cards.map((c, i) => (
          <TrafficCard key={i} scenario={c.scenario} color={c.color} lines={c.lines} />
        ))}
      </div>
    </div>
  );
}

function PeerRosterFigure({
  caption,
  rosters,
  arrowLabel = 'owner approves',
}: {
  caption?: string;
  rosters: { owner: string; entries: RosterEntry[] }[];
  arrowLabel?: string;
}) {
  return (
    <div class="code" style={{ margin: '0 0 22px' }}>
      {caption && (
        <div class="code-head">
          <span>{caption}</span>
        </div>
      )}
      <div
        style={{
          padding: 14,
          display: 'flex',
          gap: 12,
          alignItems: 'stretch',
          color: 'var(--code-fg)',
        }}
      >
        {rosters.flatMap((r, i) => {
          const card = (
            <PeerRosterCard
              key={`card-${i}`}
              owner={r.owner}
              entries={r.entries}
            />
          );
          if (i === 0) return [card];
          const arrow = (
            <div
              key={`arrow-${i}`}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                color: 'var(--accent)',
                fontFamily: 'JetBrains Mono, monospace',
                flexShrink: 0,
                padding: '0 4px',
              }}
            >
              <span style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.85 }}>
                {arrowLabel}
              </span>
              <span style={{ fontSize: 24, lineHeight: 1 }}>→</span>
            </div>
          );
          return [arrow, card];
        })}
      </div>
    </div>
  );
}

export const hiwPillars: HIWPillar[] = [
  {
    slug: 'agents-as-folders',
    pillar: 'Your agent is a folder',
    claim: 'The agent edits itself, but only where you let it',
    blurb: [
      "An agent in Cast is a directory on your disk. Open it in Finder. The instructions, skills, and memory are plain files you can read. blueprint/ is mounted read-only, memory/ is writable. The agent updates its memory and working files as it works, but never edits the prompt that tells it who it is, because the harness doesn't let it.",
    ],
    thumb: 'folder',
  },
  {
    slug: 'reach',
    pillar: 'The harness draws the reach',
    claim: 'Mount tables, allowlists, tool surfaces: declared, not requested',
    blurb: [
      "Every agent runs in its own container. Scoped filesystem: only the folders you mounted are visible. Scoped network: only the hosts on its allowlist are reachable. Tools are declared per channel, so the same agent can have a full surface in your main conversation and a narrow one in an automated lane. A clever model can't argue past it.",
    ],
    thumb: 'reach',
  },
  {
    slug: 'channels',
    pillar: 'One agent, many channels',
    claim: 'Same agent, different rooms, different rules in each room',
    blurb: [
      "A channel in Cast isn't just a way to reach the agent. It's a room with its own rules. Default for real conversations. Email triages incoming mail with a narrowed tool surface. Scheduled runs overnight maintenance with no user interaction. Peer is how this agent talks to another. Each room has its own tools, lifecycle, and memory conventions.",
    ],
    thumb: 'channels',
  },
  {
    slug: 'peers',
    pillar: 'Agents talking to agents',
    claim: 'Agents discover each other; every edge is approved',
    blurb: [
      "Agents can discover each other, but reaching is gated. An edge is per-channel and directional, and it becomes real only when the receiver's owner approves it. The sender needs reach, the receiver needs to accept. Until both are there, nothing crosses. The cook-agent can ask the calendar what's on tonight, but it has no path to the journal.",
    ],
    thumb: 'peers',
  },
];

export const hiwDeep: Record<string, HIWDeep> = {
  'agents-as-folders': {
    title: 'Your agent is a folder',
    lede: 'A directory on disk: three separated concerns, three owners, one workflow loop that runs through them.',
    sections: [
      {
        h2: 'A folder on disk',
        body: (
          <>
            <Code lang="bash">{`agents/my-agent/
├── blueprint/        # who the agent is — instructions, skills, channels
├── config/           # how it runs — model, keys, integrations, who's allowed in
├── memory/           # what it has learned, kept across conversations
├── home/             # the agent's working scratch
├── sessions/         # per-conversation transcripts (server-managed)
├── state/            # runtime state (server-managed)
├── service/          # optional cron triggers and custom tools
└── ext/              # extension caches and credentials`}</Code>
            <p style={proseP}>
              That's a real agent. The whole thing. You can <code>cp -r</code> it,{' '}
              <code>git</code> it, zip it, email it to a friend. There's no database row,
              no cloud account. The folder <em>is</em> the agent.
            </p>
            <p style={proseP}>
              But the folder is not undifferentiated. It's three separated concerns, each
              owned by a different actor, each with a different access boundary.
            </p>
          </>
        ),
      },
      {
        h2: 'Blueprint: who the agent is',
        body: (
          <>
            <p style={proseP}>
              The <strong>blueprint</strong> is the agent's identity: its instructions,
              skills, channels, props. This is what a developer composes. It
              holds no secrets, no personal data, no memory. You can hand it to a friend
              and they can run their own copy with their own settings.
            </p>
            <p style={proseP}>
              At runtime, the blueprint is <strong>mounted read-only</strong>. The agent
              can read all of it (it has to, to know who it is), but it cannot rewrite a
              single byte. Not because we ask nicely, but because the harness doesn't mount it
              writable. The thing that says "you are a careful researcher" is, mechanically,
              not editable from inside the agent.
            </p>
            <Code lang="bash">{`blueprint/
├── prompt.md         # who am I, what do I do
├── channels.txt      # cli, web, email, telegram, …
├── skills/           # tools I can call
├── manifest.json     # ACL, channel routing
└── service/          # optional code that runs alongside`}</Code>
          </>
        ),
      },
      {
        h2: 'Configuration: how the agent runs',
        body: (
          <>
            <p style={proseP}>
              The <strong>configuration</strong> is everything an operator decides about
              deploying the blueprint: which model, which API keys, which transport tokens,
              which hosts the network allowlist permits, which humans are allowed in as
              admins.
            </p>
            <p style={proseP}>
              These files never reach the agent. Your API keys, your transport tokens, your
              allowlist. The agent has no path to read them, even if instructed to. The
              secrets you put here stay where you put them.
            </p>
            <p style={proseP}>
              That separation is what lets the same blueprint be shared, copied, or
              version-controlled without leaking anything. You publish the blueprint, and you
              keep the configuration.
            </p>
          </>
        ),
      },
      {
        h2: 'Working files: what the agent does, and remembers',
        body: (
          <>
            <p style={proseP}>
              <code>memory/</code>, <code>home/</code>, <code>state/</code>,{' '}
              <code>sessions/</code>. These are the agent's working life. What it jots
              down, what survives across conversations, what the server keeps for
              bookkeeping.
            </p>
            <p style={proseP}>
              The agent can read and write <code>memory/</code> and <code>home/</code>.
              That's where <strong>self-learning</strong> happens. Each session, the agent
              updates its memory with what it learned about its participants, the work it
              just did, the conventions emerging. Next session, it reads that memory before
              responding. It gets better over time, and what it's learned is sitting in a
              plain markdown file you can open.
            </p>
            <p style={proseP}>
              <code>state/</code> and <code>sessions/</code> are server-managed, opaque
              even to the agent itself. They exist for replay, recovery, and auditing, not
              for the agent's own use. Self-learning lives in memory, where you can see it.
            </p>
          </>
        ),
      },
      {
        h2: 'Develop · Refine · Run',
        body: (
          <>
            <p style={proseP}>
              The same three surfaces map to three phases of work that flow into one
              another.
            </p>
            <ul style={proseUl}>
              <li>
                <strong>Develop.</strong> You author the blueprint. Write the prompt, list
                the skills, declare the channels.
              </li>
              <li>
                <strong>Run.</strong> The agent operates. It reads its blueprint, runs
                under your config, and writes what it's learning into <code>memory/</code>.
              </li>
              <li>
                <strong>Refine.</strong> You open <code>memory/</code> and read what the
                agent has been jotting down. You see what's working, what's drifting, what
                convention has emerged. You feed that back into the blueprint or the
                configuration, and the cycle continues.
              </li>
            </ul>
            <p style={proseP}>
              This loop is only safe because the surfaces are separated. The agent learns
              in its own working files, its identity is held still in the blueprint, and the
              developer can read both and refine without colliding. Self-learning becomes{' '}
              <em>safe</em> (the agent can't rewrite who it is) and{' '}
              <em>inspectable</em> (you can read what it's learned, in plain text).
            </p>
          </>
        ),
      },
    ],
  },

  reach: {
    title: 'The harness draws the reach',
    lede: "An agent holds personal information. The harness keeps it sealed by default, and lets you open it deliberately, in both directions.",
    sections: [
      {
        h2: 'What the agent holds',
        body: (
          <>
            <p style={proseP}>
              An agent accumulates things about you: what you've told it, what your
              participants have said, the work it has done on your behalf. Over time it
              becomes a small, specific record of your life, addressed to you, written
              down in <code>memory/</code>, sitting in a folder on your disk.
            </p>
            <p style={proseP}>
              That makes the agent a single security surface worth protecting. The reach
              question is simply: <em>what can touch this surface, and on whose say-so?</em>
            </p>
          </>
        ),
      },
      {
        h2: 'Sealed by default',
        body: (
          <>
            <PerimeterFigure caption="fig. 1: the default perimeter" />
            <p style={proseP}>
              By default the agent runs in its own sandbox. It cannot read your filesystem
              beyond the folders you mounted. It cannot reach the network beyond the
              Anthropic SDK (the API it uses to think). And nobody can reach in to talk to
              it without you having explicitly let them.
            </p>
            <p style={proseP}>
              That floor is not enforced by asking the model nicely. It's enforced
              mechanically, by the container the agent runs in, the mount table the
              harness fixes, and the network policy the operator sets. The agent has no
              path around any of it.
            </p>
          </>
        ),
      },
      {
        h2: 'Letting the agent reach out',
        body: (
          <>
            <OutboundFigure caption="fig. 2: outbound gateways" />
            <p style={proseP}>
              When the agent needs to do more than think (fetch a web page, call an API,
              read your calendar), you give it a deliberate way out. Three of them, in
              order of escalating trust:
            </p>
            <ul style={proseUl}>
              <li>
                <strong>Widen the network.</strong> Add specific hosts to the allowlist,
                or open the network entirely. The most direct option, and also the least
                contained.
              </li>
              <li>
                <strong>Plug in an extension.</strong> Extensions are vetted gateways
                provided by the harness. Each one bridges the agent to a specific outside
                service (email, web fetch, calendar) on a defined surface. Trust them as
                you'd trust the harness.
              </li>
              <li>
                <strong>Write service code.</strong> If you need a capability nobody has
                packaged, you can write it yourself. Service code lives in your blueprint
                and runs in the agent's trust class. It's how you give the agent something
                new without leaving the model behind.
              </li>
            </ul>
            <p style={proseP}>
              The tradeoff is the same shape each time: more reach, more functionality,
              more surface area you're vouching for. Cast doesn't pick for you. It exposes
              the choice.
            </p>
            <p style={proseP}>
              MCP is supported as an escape hatch for connecting to third-party servers,
              but we don't currently recommend it. The trust surface is unsettled. Each
              MCP server is third-party code, and the agent reads its tool descriptions
              and outputs directly as context, so a compromised server can manipulate the
              agent through either. The admin console has the full caveats before you
              turn one on.
            </p>
          </>
        ),
      },
      {
        h2: 'Letting people reach in',
        body: (
          <>
            <InboundFigure caption="fig. 3: inbound gateways" />
            <p style={proseP}>
              The other direction matters just as much. The agent listens on transports,
              the protocols by which people contact it: CLI, web, telegram, and so on. A
              transport is just a wire. On its own it grants nothing.
            </p>
            <p style={proseP}>
              When a message arrives, the identity provider resolves who the sender is. A
              stranger gets a fresh identity but no permissions, and their first message is
              held. To let them in, you approve that held message from the dashboard, once
              or for good. An allow-always grant is durable, and from then on the agent
              recognizes them.
            </p>
            <p style={proseP}>
              That approval is the gate at the front door. Without it, no inbound message earns
              the agent's real attention. With it, a specific person, at a specific
              transport, can carry on a real conversation, and their messages accrue into
              the agent's memory addressed to them.
            </p>
          </>
        ),
      },
      {
        h2: "Where Cast's guarantees end",
        body: (
          <>
            <p style={proseP}>
              Cast secures the perimeter mechanically. What sits <em>inside</em> the
              perimeter is your judgment, not Cast's: the extensions you've installed, the
              service code you've written, the laptop the harness runs on, the operator at
              the keyboard. If you install a malicious extension, it runs. If your laptop is
              compromised, the agent is compromised. The sandbox protects{' '}
              <em>your other things</em> from <em>the agent</em>, not the other way
              around.
            </p>
            <p style={proseP}>
              That's the honest scope. The mechanical guarantees do real work, and the rest is
              the standard developer-on-their-own-machine trust model.
            </p>
          </>
        ),
      },
    ],
  },

  channels: {
    title: 'One agent, many channels',
    lede: 'A channel is a room the agent listens in, and four knobs make each room what it is.',
    sections: [
      {
        h2: 'What a channel is',
        body: (
          <>
            <p style={proseP}>
              A channel is a labeled room on the agent. The agent's brain, identity, and
              memory are shared across all of its channels. What the agent <em>does</em>{' '}
              in any one room is shaped by that room's configuration.
            </p>
            <p style={proseP}>
              Rooms run in parallel. The agent in its email room and the agent in your
              chat are independent live sessions, not a queue. The agent can triage
              incoming mail while you're talking to it, reflect overnight while a
              deferred fire lands. And within any one room, each person who reaches the
              agent there gets their own private conversation. Same room, same rules,
              separate histories.
            </p>
            <p style={proseP}>
              There's nothing built in to subscribe to. Every channel is something the
              operator declares. <code>default</code> is conventionally the user-facing
              conversation room, and everything else (e.g. <code>events</code>,{' '}
              <code>reflection</code>, <code>ask</code>, <code>review</code>) is named
              by whoever wrote the agent. The four knobs are what make each room what it
              is.
            </p>
          </>
        ),
      },
      {
        h2: 'Conversations and the learning loop',
        body: (
          <>
            <ConversationLoopFigure caption="fig. 1: conversation lifecycle" />
            <p style={proseP}>
              Inside a channel, the unit of work is a <em>conversation</em>, a bounded
              live session with a finite context window. Conversations have lifecycles:
              they start, accumulate context as the agent works, and end (either when
              the channel's idle timer expires, or right after the reply if the channel
              is ephemeral).
            </p>
            <p style={proseP}>
              Two hooks bridge across. <strong>Bootstrap</strong> fires at the start and
              reads <code>/memory/</code> to pull forward what matters.{' '}
              <strong>Cleanup</strong> fires at the end and writes back what the
              conversation learned: distilled notes, summaries, anything worth keeping.
              This is how the agent learns over time without an unbounded window: each
              conversation is a focused chunk. Durable notes accumulate in memory and
              recall at the next bootstrap when relevant. Token-efficient by construction.
            </p>
          </>
        ),
      },
      {
        h2: 'The four knobs',
        body: (
          <>
            <ChannelAnatomyFigure caption="fig. 2: the four knobs" />
            <p style={proseP}>Every channel is defined by four settings.</p>
            <ul style={proseUl}>
              <li>
                <strong>Access.</strong> Who is allowed to address the channel. The
                operator grants per-peer permissions: granted users get conversational
                read/write, peer agents get query-only doors, some channels stay
                internal, so only schedule fires and the like reach them.
              </li>
              <li>
                <strong>Capabilities.</strong> Which tools the agent can reach in this
                channel. A peer-query room might block everything outbound. An email
                triage room might block writes to peers and schedules. A conversation
                room usually grants the full toolkit.
              </li>
              <li>
                <strong>Working memory.</strong> Whether the channel's short-term context
                survives between fires. Persistent: the conversation picks up where it
                left off, and the agent's working context stays warm across turns.
                Ephemeral: every visit starts fresh, with the agent rebuilding context
                from <code>/memory/</code> at bootstrap. Persistent fits conversations,
                ephemeral fits scheduled jobs, event handlers, and peer queries, where
                state from the last fire would contaminate the next.
              </li>
              <li>
                <strong>Instructions.</strong> The channel's own behavior prompt, plus
                optional bootstrap (read at start) and cleanup (read at end) hooks. The
                agent reads them on every visit.
              </li>
            </ul>
          </>
        ),
      },
      {
        h2: 'How the knobs combine into rooms',
        body: (
          <>
            <ChannelCompositionFigure
              caption="fig. 3: one agent, many channels"
              channels={[
                {
                  name: 'default',
                  sub: 'conversation',
                  access: 'users',
                  capabilities: [
                    { name: 'web_fetch' },
                    { name: 'send_email' },
                    { name: 'read_calendar' },
                    { name: 'task_schedule' },
                    { name: 'push_to_channel' },
                    { name: 'query_peer' },
                  ],
                  workingMemory: 'persistent',
                  instructions: 'Help with whatever the user brings.',
                },
                {
                  name: 'reflection',
                  sub: 'scheduled',
                  access: 'internal',
                  capabilities: [
                    { name: 'read_memory' },
                    { name: 'web_fetch' },
                    { name: 'task_schedule', disabled: true },
                    { name: 'push_to_channel', disabled: true },
                    { name: 'query_peer', disabled: true },
                  ],
                  workingMemory: 'ephemeral',
                  instructions: 'Each evening, compress what was learned.',
                },
                {
                  name: 'ask',
                  sub: 'query door',
                  access: 'peers',
                  capabilities: [
                    { name: 'read_memory' },
                    { name: 'send_email', disabled: true },
                    { name: 'web_fetch', disabled: true },
                    { name: 'push_to_channel', disabled: true },
                    { name: 'task_schedule', disabled: true },
                  ],
                  workingMemory: 'ephemeral',
                  instructions: 'Answer the query. Nothing else.',
                },
              ]}
            />
            <p style={proseP}>
              Different settings of the four knobs produce recognizable shapes:
            </p>
            <ul style={proseUl}>
              <li>
                <strong>A conversation room.</strong> Granted-user access + full
                capabilities + persistent working memory + conversational instructions.
                The default shape, and the agent picks up where you left off.
              </li>
              <li>
                <strong>A scheduled reflection room.</strong> Internal-only access +
                narrowed capabilities + ephemeral working memory + reflection-shape
                instructions. Each evening's pass is independent, and nothing from yesterday
                bleeds into tonight.
              </li>
              <li>
                <strong>A peer-query door.</strong> Designated-peer access +
                outbound-blocked capabilities + ephemeral working memory + answer-shape
                instructions. Callers ask, the agent answers, the session ends. The same
                agent can hold sensitive data its caller doesn't.
              </li>
              <li>
                <strong>An event-handler room.</strong> Push/file-watch access +
                narrowed capabilities + ephemeral working memory + triage-shape
                instructions. The agent decides per-event whether to act silently or
                surface to the user's channel.
              </li>
            </ul>
            <p style={proseP}>
              The point isn't that these are the only shapes. It's that one mechanism
              with four dials produces all of them. New shapes are new combinations, not
              new mechanisms.
            </p>
          </>
        ),
      },
      {
        h2: 'Where channels stop',
        body: (
          <>
            <p style={proseP}>
              A channel is not a security wall. The agent's brain is the same brain
              everywhere. If it's compromised in one room, it's the same agent in the
              others. What channels give you is <em>defense in depth</em> inside the one
              trust boundary that's actually mechanical (the container). They let you
              match the agent's behavior in each context to the trust posture of that
              context, without splitting the agent itself.
            </p>
            <p style={proseP}>
              The wall is pillar 2. The partition is here.
            </p>
          </>
        ),
      },
    ],
  },

  peers: {
    title: 'Agents talking to agents',
    lede: 'Agents in Cast can find each other and talk, along edges their owners approved.',
    sections: [
      {
        h2: 'Why agents talk to each other',
        body: (
          <>
            <p style={proseP}>
              An agent on its own is a specialist. It knows what you've taught
              it, in the room you put it in, with the reach you gave it. A
              repo-watcher tracks commits on your codebase. An inbox-triage
              reads new mail as it lands. A meetings agent holds what's on
              your week. Each is good at its slice and nothing more.
            </p>
            <p style={proseP}>
              Sometimes you want a view that crosses the slices, a
              Monday-morning brief of what changed across all of them, in one
              place. Cast lets agents reach across each other so that a{' '}
              <strong>reviewer</strong> can ask each specialist what's worth
              your attention this week, weave the answers together, and hand
              you a single summary. The specialists keep their focus, and the
              reviewer borrows from each.
            </p>
          </>
        ),
      },
      {
        h2: 'Discovery is not access',
        body: (
          <>
            <PeerRosterFigure
              caption="fig. 1: the reviewer's roster, before and after access is granted"
              rosters={[
                { owner: 'reviewer', entries: [] },
                {
                  owner: 'reviewer',
                  entries: [
                    { peer: 'repo-watcher', channel: 'review' },
                    { peer: 'inbox-triage', channel: 'review' },
                    { peer: 'meetings', channel: 'review' },
                  ],
                },
              ]}
            />
            <p style={proseP}>
              Agents can find each other. Each one can list the peers around it
              and see which it could reach. But discovery is not access. Seeing
              that another agent exists, and being able to talk to it, are two
              different things, and the second one is gated.
            </p>
            <p style={proseP}>
              An edge becomes real when the owner on the receiving side approves
              it. The sender's reach and the receiver's acceptance both have to
              be there. Until they are, nothing crosses. An agent can request a
              new edge at runtime, but the request waits for a yes. Cast never
              infers a connection from proximity, naming, or intent. Every edge
              that exists, someone approved.
            </p>
            <p style={proseP}>
              Edges sit at <strong>channels</strong>, the same channels a person
              would reach the agent on. An edge isn't blanket trust. It's
              permission for one kind of exchange on one labeled surface. And
              every message that crosses carries the sender's identity, so the
              receiver always knows who's on the other end.
            </p>
          </>
        ),
      },
      {
        h2: 'The three kinds of exchange',
        body: (
          <>
            <p style={proseP}>
              Cast recognizes three things one agent can do to another. Every
              line on the chart is one of these.
            </p>
            <ExchangeShapesFigure
              caption="fig. 2: the three exchange shapes, as they appear in traffic"
              cards={[
                {
                  scenario:
                    'The reviewer is composing your Monday-morning brief and needs to know what inbox-triage has flagged as stuck this week before it can finish.',
                  color: 'cyan',
                  lines: [
                    {
                      kind: 'verb',
                      sender: 'reviewer',
                      verb: 'ask',
                      receiver: 'inbox-triage',
                      body: "What's been sitting unread or unreplied since Monday?",
                    },
                    {
                      kind: 'verb',
                      sender: 'inbox-triage',
                      verb: 'ans',
                      receiver: 'reviewer',
                      body: 'Three threads: a vendor renewal, a board ask, and Marco re: the rollout.',
                    },
                  ],
                },
                {
                  scenario:
                    "The reviewer wants an article read. It hands the job to web-researcher and moves on. That's a task, not a question, so there's no reply trip, and web-researcher does the work on its own terms.",
                  color: 'magenta',
                  lines: [
                    {
                      kind: 'verb',
                      sender: 'reviewer',
                      verb: 'task',
                      receiver: 'web-researcher',
                      body: 'Read example.com/article and summarize it.',
                    },
                    { kind: 'absence', text: 'no reply path' },
                  ],
                },
                {
                  scenario:
                    "Alex is mid-conversation with the triage agent, and the question turns out to be a billing one. Triage hands Alex over. Billing picks up the conversation, and triage drops out.",
                  color: 'green',
                  lines: [
                    {
                      kind: 'verb',
                      sender: 'triage',
                      verb: 'push: alex',
                      receiver: 'billing',
                      body: 'Alex was asking about a duplicate charge on last month’s invoice.',
                    },
                    { kind: 'event', text: 'alex now talking to billing' },
                  ],
                },
              ]}
            />
            <ul style={proseUl}>
              <li>
                <strong>A question, answered.</strong> One agent asks another
                what it holds and uses the reply. The reviewer asks the
                inbox-triage what's stuck this week, reads the answer, weaves
                it into the brief alongside what the other specialists said.
              </li>
              <li>
                <strong>A task, dispatched without a reply.</strong> The
                sender hands work to the receiver and the bus carries nothing
                back. The point of the shape is safety. When an agent is asked
                to read something untrusted on its caller's behalf, like a web
                page or an inbound email, a reply path would be a way for that
                material to speak back into the caller's mind. Cut the return
                trip, and there's no channel for the injection to travel.
              </li>
              <li>
                <strong>A person, handed over.</strong> Someone is talking to
                one agent and gets routed to another. A triage agent passes
                the user to a specialist, a household assistant hands the kid
                to the homework-helper. The first agent steps out, and the
                conversation continues with the new one as if it had been
                there all along.
              </li>
            </ul>
          </>
        ),
      },
      {
        h2: 'A system you can read',
        body: (
          <>
            <p style={proseP}>
              What you end up with is a map of approved edges, in plain text,
              in front of you. An agent can ask to reach another at runtime, but
              nothing connects until the owner says yes, and every edge that
              exists is one you can see. No hidden connection, no traffic you
              never approved. The fleet is legible because its edges are written
              down, and there are no others.
            </p>
          </>
        ),
      },
    ],
  },
};
