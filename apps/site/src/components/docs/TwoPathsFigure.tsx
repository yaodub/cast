/**
 * Two figures for the "Two paths" section on the Migrating page.
 *
 * Both use the harness/zone visual vocabulary from the reach pillar
 * (how-it-works/data.tsx): internet zone above, harness as the boundary,
 * inside the harness below.
 *
 *   LiveDangerouslyFigure — a "skill" gateway pierces the harness; the
 *     agent reaches the internet directly. Red on the gateway.
 *
 *   PlayItSafeFigure — an agent service sits inside the harness between
 *     the agent and the harness boundary. The agent calls the service via
 *     MCP tools (entirely inside the harness); the service is the thing
 *     that pierces the harness to reach the internet. Green on the service.
 */

const W = 520;
const RED = '#B0203A';
const GREEN = '#1F8A5B';
const ARROW_SIZE = 7;
const cx = W / 2;

const ZONE_TOP = 16;
const ZONE_H = 40;
const HARNESS_Y = 80;

// ---- Shared primitives ----

function InternetZone() {
  return (
    <g>
      <rect x={0} y={ZONE_TOP} width={W} height={ZONE_H} fill="url(#paths-dots)" />
      <rect
        x={cx - 44}
        y={ZONE_TOP + ZONE_H / 2 - 10}
        width={88}
        height={20}
        fill="var(--code-bg)"
      />
      <text
        x={cx}
        y={ZONE_TOP + ZONE_H / 2}
        text-anchor="middle"
        dy="0.35em"
        class="fig-shade"
        fill="currentColor"
        font-size={13}
      >
        internet
      </text>
    </g>
  );
}

interface HarnessProps {
  hole?: { center: number; width: number };
}
function Harness({ hole }: HarnessProps = {}) {
  const segments = hole
    ? [
        { x1: 0, x2: hole.center - hole.width / 2 },
        { x1: hole.center + hole.width / 2, x2: W },
      ]
    : [{ x1: 0, x2: W }];
  return (
    <g>
      {[0, 5].map((d) =>
        segments.map((s, i) => (
          <line
            key={`${d}-${i}`}
            x1={s.x1}
            y1={HARNESS_Y + d}
            x2={s.x2}
            y2={HARNESS_Y + d}
            class="fig-harness"
            stroke="currentColor"
            stroke-width={1.4}
          />
        )),
      )}
      <text
        x={16}
        y={HARNESS_Y - 8}
        class="fig-harness"
        fill="currentColor"
        font-size={11}
        style={{ letterSpacing: '0.06em' }}
      >
        harness
      </text>
    </g>
  );
}

function AgentBox({ y }: { y: number }) {
  const w = 100;
  const h = 30;
  return (
    <g>
      <rect
        x={cx - w / 2}
        y={y}
        width={w}
        height={h}
        rx={2}
        fill="none"
        stroke="currentColor"
        stroke-width={1.3}
      />
      <text
        x={cx}
        y={y + h / 2}
        text-anchor="middle"
        dy="0.35em"
        fill="currentColor"
        font-size={13}
      >
        agent
      </text>
    </g>
  );
}

interface UpArrowProps {
  tipY: number;
  baseY: number;
  color: string;
  opacity?: number;
}
function UpArrow({ tipY, baseY, color, opacity = 1 }: UpArrowProps) {
  return (
    <g>
      <line
        x1={cx}
        y1={baseY}
        x2={cx}
        y2={tipY}
        stroke={color}
        stroke-opacity={opacity}
        stroke-width={1.4}
      />
      <polygon
        points={`${cx},${tipY - ARROW_SIZE} ${cx - ARROW_SIZE / 2},${tipY} ${cx + ARROW_SIZE / 2},${tipY}`}
        fill={color}
        fill-opacity={opacity}
      />
    </g>
  );
}

interface GatewayLabelProps {
  y: number;
  text: string;
  color: string;
  width: number;
}
function GatewayLabel({ y, text, color, width }: GatewayLabelProps) {
  return (
    <g>
      <rect
        x={cx - width / 2}
        y={y - 11}
        width={width}
        height={20}
        fill="var(--code-bg)"
      />
      <text
        x={cx}
        y={y}
        text-anchor="middle"
        dy="0.35em"
        fill={color}
        font-size={12}
      >
        {text}
      </text>
    </g>
  );
}

interface FrameProps {
  caption?: string;
  height: number;
  children: any;
}
function FigureFrame({ caption, height, children }: FrameProps) {
  return (
    <div class="code" style={{ margin: '0 0 22px' }}>
      {caption && (
        <div class="code-head">
          <span>{caption}</span>
        </div>
      )}
      <div
        style={{
          padding: '20px 0',
          display: 'flex',
          justifyContent: 'center',
          color: 'var(--code-fg)',
        }}
      >
        <svg
          viewBox={`0 0 ${W} ${height}`}
          width="100%"
          style={{ maxWidth: W + 40, height: 'auto' }}
          font-family="ui-monospace, 'JetBrains Mono', monospace"
        >
          <defs>
            <pattern id="paths-dots" width={6} height={6} patternUnits="userSpaceOnUse">
              <circle cx={1} cy={1} r={0.9} class="fig-shade" fill="currentColor" />
            </pattern>
          </defs>
          {children}
        </svg>
      </div>
    </div>
  );
}

// ---- Figure 1: Live Dangerously ----

export function LiveDangerouslyFigure({ caption }: { caption?: string }) {
  const H = 180;
  const AGENT_Y = 132;
  const SKILL_LABEL_Y = HARNESS_Y + 28; // 108

  return (
    <FigureFrame caption={caption} height={H}>
      <InternetZone />
      <Harness hole={{ center: cx, width: 36 }} />
      <UpArrow
        tipY={ZONE_TOP + ZONE_H / 2 + 14}
        baseY={AGENT_Y - 4}
        color={RED}
      />
      <GatewayLabel y={SKILL_LABEL_Y} text="skill" color={RED} width={60} />
      <AgentBox y={AGENT_Y} />
    </FigureFrame>
  );
}

// ---- Figure 2: Play It Safe ----

export function PlayItSafeFigure({ caption }: { caption?: string }) {
  const H = 230;
  const SERVICE_Y = 102;
  const SERVICE_H = 30;
  const AGENT_Y = 178;
  const MCP_LABEL_Y = 154;

  return (
    <FigureFrame caption={caption} height={H}>
      <InternetZone />
      <Harness />

      {/* Agent service box — inside the harness, between agent and harness boundary */}
      <rect
        x={cx - 150 / 2}
        y={SERVICE_Y}
        width={150}
        height={SERVICE_H}
        rx={3}
        fill="none"
        stroke={GREEN}
        stroke-width={1.3}
      />
      <text
        x={cx}
        y={SERVICE_Y + SERVICE_H / 2}
        text-anchor="middle"
        dy="0.35em"
        fill={GREEN}
        font-size={12}
      >
        agent service
      </text>

      {/* service → internet arrow (pierces harness) */}
      <UpArrow
        tipY={ZONE_TOP + ZONE_H / 2 + 14}
        baseY={SERVICE_Y - 4}
        color={GREEN}
      />

      {/* agent → service arrow (entirely inside harness) */}
      <UpArrow
        tipY={SERVICE_Y + SERVICE_H + 4}
        baseY={AGENT_Y - 4}
        color="currentColor"
        opacity={0.7}
      />
      <GatewayLabel y={MCP_LABEL_Y} text="mcp tools" color="currentColor" width={80} />

      <AgentBox y={AGENT_Y} />
    </FigureFrame>
  );
}
