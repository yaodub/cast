/**
 * Peer-dialogue figure: two agents talking directly — one asks, the other
 * answers back. Unlike the grid figures, this format doesn't carry the
 * (agent, participant, channel) dimensions on its axes, so each cell spells
 * them out underneath — and the symmetry shows that each agent is a
 * participant in the other's grid. Unframed, theme-adaptive ink, fixed cell
 * colors.
 */

interface Side {
  agent: string;
  participant: string;
  channel: string;
  color: string;
}

interface Props {
  left: Side;
  right: Side;
  caption?: string;
}

const W = 460;
const H = 152;
const CELL_W = 156;
const CELL_H = 50;
const LX = 22;
const RX = W - 22 - CELL_W;
const CYTOP = 24;
const HEAD = 5;

const DIMS: { key: 'agent' | 'participant' | 'channel'; label: string }[] = [
  { key: 'agent', label: 'agent' },
  { key: 'participant', label: 'participant' },
  { key: 'channel', label: 'channel' },
];

function DimLabels({ side, x }: { side: Side; x: number }) {
  const startY = CYTOP + CELL_H + 22;
  return (
    <>
      {DIMS.map((d, i) => {
        const y = startY + i * 18;
        const val = d.key === 'channel' ? `#${side.channel}` : side[d.key];
        return (
          <g key={d.label}>
            <text x={x} y={y} font-size={11} style={{ fill: 'var(--fg-subtle)' }}>
              {d.label}
            </text>
            <text x={x + 86} y={y} font-size={11} style={{ fill: 'var(--fg)' }}>
              {val}
            </text>
          </g>
        );
      })}
    </>
  );
}

export function PeerDialogueFigure({ left, right, caption }: Props) {
  const lEdge = LX + CELL_W;
  const rEdge = RX;
  const mid = (lEdge + rEdge) / 2;
  const askY = CYTOP + 16;
  const ansY = CYTOP + CELL_H - 16;

  return (
    <div style={{ margin: '8px 0 24px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ maxWidth: W, height: 'auto' }}
        font-family="JetBrains Mono, monospace"
      >
        {/* Cells */}
        <rect x={LX} y={CYTOP} width={CELL_W} height={CELL_H} rx={5} fill={left.color} />
        <rect x={RX} y={CYTOP} width={CELL_W} height={CELL_H} rx={5} fill={right.color} />

        {/* Ask — left to right */}
        <text x={mid} y={askY - 6} text-anchor="middle" font-size={10.5} style={{ fill: 'var(--fg-muted)' }}>
          ask
        </text>
        <line x1={lEdge + 6} y1={askY} x2={rEdge - 8} y2={askY} stroke-width={1.6} style={{ stroke: 'var(--fg-muted)' }} />
        <polygon
          points={`${rEdge - 4},${askY} ${rEdge - 4 - HEAD},${askY - HEAD} ${rEdge - 4 - HEAD},${askY + HEAD}`}
          style={{ fill: 'var(--fg-muted)' }}
        />

        {/* Answer — right to left */}
        <line x1={rEdge - 6} y1={ansY} x2={lEdge + 8} y2={ansY} stroke-width={1.6} style={{ stroke: 'var(--fg-muted)' }} />
        <polygon
          points={`${lEdge + 4},${ansY} ${lEdge + 4 + HEAD},${ansY - HEAD} ${lEdge + 4 + HEAD},${ansY + HEAD}`}
          style={{ fill: 'var(--fg-muted)' }}
        />
        <text x={mid} y={ansY + 15} text-anchor="middle" font-size={10.5} style={{ fill: 'var(--fg-muted)' }}>
          answer
        </text>

        {/* Per-cell dimension labels */}
        <DimLabels side={left} x={LX} />
        <DimLabels side={right} x={RX} />
      </svg>
      {caption && (
        <div
          style={{
            marginTop: 10,
            textAlign: 'center',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            color: 'var(--fg-muted)',
          }}
        >
          {caption}
        </div>
      )}
    </div>
  );
}
