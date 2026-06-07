/**
 * Conversation-grid figure for the "Conversation grid" concept page.
 *
 * A small, unframed grid of rectangles with one dimension pinned: rows ×
 * channels. Each lit cell is a solid color that matches its chat panel's
 * bubble (color keys the cell to the conversation, not to a person). An
 * optional arrow shows a move between cells. Structural ink uses theme tokens
 * so the figure reads on any page background; cells keep their fixed bubble
 * colors.
 */

interface Cell {
  row: number;
  col: number;
}
interface ColorCell extends Cell {
  color: string;
}

interface Props {
  /** Row labels — people, or agents when the user is the pinned dimension. */
  rows: string[];
  /** Channel names (rendered as #name). */
  cols: string[];
  /** The held-fixed dimension, e.g. "agent: assistant". */
  pinned?: string;
  /** Lit conversations, solid-filled in their color. */
  cells?: ColorCell[];
  arrow?: { from: Cell; to: Cell };
  /** A cell with a two-way exchange (ask out, answer back), marked with a ⇄. */
  exchange?: Cell;
  caption?: string;
}

const PAD_L = 116;
const PAD_T = 48;
const CELL_W = 122;
const CELL_H = 44;
const GAP_X = 14;
const GAP_Y = 14;

const cx = (c: number) => PAD_L + c * (CELL_W + GAP_X);
const cy = (r: number) => PAD_T + r * (CELL_H + GAP_Y);
const midX = (c: number) => cx(c) + CELL_W / 2;
const midY = (r: number) => cy(r) + CELL_H / 2;

export function ConversationGridFigure({ rows, cols, pinned, cells = [], arrow, exchange, caption }: Props) {
  const gridRight = PAD_L + cols.length * (CELL_W + GAP_X) - GAP_X;
  const gridBottom = PAD_T + rows.length * (CELL_H + GAP_Y) - GAP_Y;
  const W = gridRight + 24 + (exchange ? 22 : 0);
  const H = gridBottom + 16;
  const colorOf = (r: number, c: number) => cells.find((x) => x.row === r && x.col === c)?.color;

  return (
    <div style={{ margin: '8px 0 24px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ maxWidth: W + 70, height: 'auto' }}
        font-family="JetBrains Mono, monospace"
      >
        {pinned && (
          <text x={16} y={18} font-size={11} style={{ fill: 'var(--fg-subtle)', letterSpacing: '0.03em' }}>
            {`▸ ${pinned}`}
          </text>
        )}

        {/* Column headers */}
        {cols.map((c, i) => (
          <text
            key={`col-${i}`}
            x={midX(i)}
            y={PAD_T - 12}
            text-anchor="middle"
            font-size={12}
            style={{ fill: 'var(--fg-muted)' }}
          >
            {`#${c}`}
          </text>
        ))}

        {/* Rows: label + cells */}
        {rows.map((label, r) => (
          <g key={`row-${r}`}>
            <text
              x={PAD_L - 16}
              y={midY(r)}
              text-anchor="end"
              dy="0.35em"
              font-size={12.5}
              style={{ fill: 'var(--fg)' }}
            >
              {label}
            </text>
            {cols.map((_, c) => {
              const color = colorOf(r, c);
              return color ? (
                <rect
                  key={`cell-${r}-${c}`}
                  x={cx(c)}
                  y={cy(r)}
                  width={CELL_W}
                  height={CELL_H}
                  rx={5}
                  fill={color}
                />
              ) : (
                <rect
                  key={`cell-${r}-${c}`}
                  x={cx(c)}
                  y={cy(r)}
                  width={CELL_W}
                  height={CELL_H}
                  rx={5}
                  fill="none"
                  stroke-width={1}
                  stroke-dasharray="3,3"
                  style={{ stroke: 'var(--border-strong)' }}
                />
              );
            })}
          </g>
        ))}

        {arrow && <MoveArrow from={arrow.from} to={arrow.to} />}

        {exchange && (
          <text
            x={cx(exchange.col) + CELL_W + 8}
            y={midY(exchange.row)}
            dy="0.35em"
            font-size={17}
            style={{ fill: 'var(--fg-muted)' }}
          >
            ⇄
          </text>
        )}
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

function MoveArrow({ from, to }: { from: Cell; to: Cell }) {
  const sameCol = from.col === to.col;
  const sameRow = from.row === to.row;
  const HEAD = 5;
  let sx: number;
  let sy: number;
  let ex: number;
  let ey: number;
  let head: string;

  if (sameCol) {
    const down = to.row > from.row;
    sx = midX(from.col);
    ex = midX(to.col);
    sy = cy(from.row) + (down ? CELL_H : 0);
    ey = cy(to.row) + (down ? 0 : CELL_H);
    const dir = down ? 1 : -1;
    head = `${ex},${ey} ${ex - HEAD},${ey - dir * HEAD} ${ex + HEAD},${ey - dir * HEAD}`;
  } else if (sameRow) {
    const right = to.col > from.col;
    sy = midY(from.row);
    ey = midY(to.row);
    sx = cx(from.col) + (right ? CELL_W : 0);
    ex = cx(to.col) + (right ? 0 : CELL_W);
    const dir = right ? 1 : -1;
    head = `${ex},${ey} ${ex - dir * HEAD},${ey - HEAD} ${ex - dir * HEAD},${ey + HEAD}`;
  } else {
    // Diagonal — both axes change. Run corner-to-corner with the arrowhead
    // rotated to the line angle; the axis-aligned heads above don't fit a slope.
    const down = to.row > from.row;
    const right = to.col > from.col;
    sx = cx(from.col) + (right ? CELL_W : 0);
    sy = cy(from.row) + (down ? CELL_H : 0);
    ex = cx(to.col) + (right ? 0 : CELL_W);
    ey = cy(to.row) + (down ? 0 : CELL_H);
    const back = Math.atan2(ey - sy, ex - sx) + Math.PI;
    const SPREAD = 0.5;
    const HLEN = 7;
    head =
      `${ex},${ey} ` +
      `${ex + HLEN * Math.cos(back - SPREAD)},${ey + HLEN * Math.sin(back - SPREAD)} ` +
      `${ex + HLEN * Math.cos(back + SPREAD)},${ey + HLEN * Math.sin(back + SPREAD)}`;
  }

  return (
    <g>
      <line x1={sx} y1={sy} x2={ex} y2={ey} stroke-width={1.8} style={{ stroke: 'var(--fg-muted)' }} />
      <polygon points={head} style={{ fill: 'var(--fg-muted)' }} />
    </g>
  );
}
