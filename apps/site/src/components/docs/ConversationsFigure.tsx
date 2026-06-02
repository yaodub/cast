/**
 * Before/after diagram for the Conversations concept page.
 *
 * Top half (WITHOUT RECONCILIATION): two long ongoing conversations, one per
 *   counterparty (Alice / Bob). The outline shows the full unbounded span;
 *   filled regions inside show moments of activity. No memory, no
 *   cross-counterparty sharing — each counterparty is one indefinite stream.
 * Bottom half (WITH RECONCILIATION): the same activity pattern, now broken
 *   into discrete bounded conversations on each row, with a shared /memory/
 *   rail between the rows and bootstrap/cleanup arrows at each conversation's
 *   boundaries. One visible overlap moment where both rows have active
 *   conversations sharing the same rail.
 *
 * Visual vocabulary follows the how-it-works SVG figures: monospace,
 * currentColor + per-class accent colors (fig-harness for Alice, fig-shade
 * for Bob, fig-arrow for the memory rail).
 */

interface Span {
  x: number;
  w: number;
}

const W = 560;
const H = 320;

const BOX_H = 26;
const ROW_X_START = 86; // left margin reserved for row labels
const ROW_X_END = W - 20;

// Activity spans (identical in both halves — same activity pattern, different
// conceptualization). Designed so Alice's middle span and Bob's middle span
// overlap in time.
const ALICE_SPANS: Span[] = [
  { x: 90, w: 80 },
  { x: 220, w: 110 }, // overlap zone with Bob's middle
  { x: 460, w: 80 },
];
const BOB_SPANS: Span[] = [
  { x: 170, w: 50 },
  { x: 270, w: 120 }, // overlap zone with Alice's middle
  { x: 400, w: 60 },
];

// Before half: two long ongoing conversations, close together
const BEFORE_HEADER_Y = 16;
const BEFORE_ALICE_Y = 42;
const BEFORE_BOB_Y = BEFORE_ALICE_Y + BOX_H + 8;
const BEFORE_AXIS_Y = BEFORE_BOB_Y + BOX_H + 14;

// Divider between halves
const DIVIDER_Y = 142;

// After half: Alice row, memory rail same height as boxes, Bob row.
// Small gaps so arrows can be short.
const AFTER_HEADER_Y = 160;
const AFTER_ALICE_Y = 188;
const AFTER_RAIL_Y = AFTER_ALICE_Y + BOX_H + 10;
const AFTER_BOB_Y = AFTER_RAIL_Y + BOX_H + 10;
const AFTER_AXIS_Y = AFTER_BOB_Y + BOX_H + 14;

// ----- Building blocks -----

function LongOutline({ y, className }: { y: number; className: string }) {
  return (
    <rect
      x={ROW_X_START}
      y={y}
      width={ROW_X_END - ROW_X_START}
      height={BOX_H}
      rx={3}
      class={className}
      stroke="currentColor"
      stroke-width={1.2}
      stroke-opacity={0.7}
      fill="none"
    />
  );
}

function ActivityFill({ x, y, w, className }: { x: number; y: number; w: number; className: string }) {
  return (
    <rect
      x={x}
      y={y + 2}
      width={w}
      height={BOX_H - 4}
      class={className}
      fill="currentColor"
      fill-opacity={0.32}
    />
  );
}

function BoundedConversation({
  x,
  y,
  w,
  className,
}: {
  x: number;
  y: number;
  w: number;
  className: string;
}) {
  return (
    <rect
      x={x}
      y={y}
      width={w}
      height={BOX_H}
      rx={3}
      class={className}
      fill="currentColor"
      fill-opacity={0.18}
      stroke="currentColor"
      stroke-width={1.4}
    />
  );
}

function RowLabel({ y, label, className }: { y: number; label: string; className: string }) {
  return (
    <text
      x={ROW_X_START - 12}
      y={y + BOX_H / 2}
      text-anchor="end"
      dy="0.35em"
      class={className}
      fill="currentColor"
      font-size={12}
      font-family="JetBrains Mono, monospace"
    >
      {label}
    </text>
  );
}

function HeaderText({ y, text }: { y: number; text: string }) {
  return (
    <text
      x={W / 2}
      y={y}
      text-anchor="middle"
      fill="currentColor"
      fill-opacity={0.8}
      font-size={11.5}
      font-family="JetBrains Mono, monospace"
      style={{ letterSpacing: '0.04em' }}
    >
      {text}
    </text>
  );
}

function TimeAxis({ y }: { y: number }) {
  return (
    <>
      <line
        x1={ROW_X_START}
        y1={y}
        x2={ROW_X_END}
        y2={y}
        stroke="currentColor"
        stroke-opacity={0.15}
        stroke-width={1}
      />
      <text
        x={ROW_X_END}
        y={y + 12}
        text-anchor="end"
        fill="currentColor"
        fill-opacity={0.4}
        font-size={10}
        font-family="JetBrains Mono, monospace"
      >
        time →
      </text>
    </>
  );
}

// Short bootstrap+cleanup arrow pair at each conversation's boundaries.
// Arrows are colored by direction, not by counterparty:
//   bootstrap (memory → conversation) uses the memory rail's color exactly
//     (fig-arrow class + currentColor) so the bootstrap flow visually
//     extends the rail into the new conversation.
//   cleanup (conversation → memory) uses a distinct green so contributions
//     into memory are legible against the rail.
const CLEANUP_COLOR = '#4ADE80';

function BoundaryArrows({
  box,
  rowY,
  rowAboveRail,
}: {
  box: Span;
  rowY: number;
  rowAboveRail: boolean;
}) {
  const INSET = 5;
  const HEAD = 4;
  const bootstrapX = box.x + INSET;
  const cleanupX = box.x + box.w - INSET;

  // Edge of the conversation box that points toward the rail
  const boxEdge = rowAboveRail ? rowY + BOX_H : rowY;
  // Edge of the rail that points toward the row
  const railEdge = rowAboveRail ? AFTER_RAIL_Y : AFTER_RAIL_Y + BOX_H;

  // Cleanup: from boxEdge → railEdge (arrowhead at rail)
  // Bootstrap: from railEdge → boxEdge (arrowhead at box)
  const cleanupHead = rowAboveRail
    ? `${cleanupX},${railEdge} ${cleanupX - HEAD / 2},${railEdge - HEAD} ${cleanupX + HEAD / 2},${railEdge - HEAD}`
    : `${cleanupX},${railEdge} ${cleanupX - HEAD / 2},${railEdge + HEAD} ${cleanupX + HEAD / 2},${railEdge + HEAD}`;
  const bootstrapHead = rowAboveRail
    ? `${bootstrapX},${boxEdge} ${bootstrapX - HEAD / 2},${boxEdge + HEAD} ${bootstrapX + HEAD / 2},${boxEdge + HEAD}`
    : `${bootstrapX},${boxEdge} ${bootstrapX - HEAD / 2},${boxEdge - HEAD} ${bootstrapX + HEAD / 2},${boxEdge - HEAD}`;

  return (
    <>
      <g class="fig-arrow">
        <line
          x1={bootstrapX}
          y1={railEdge}
          x2={bootstrapX}
          y2={boxEdge}
          stroke="currentColor"
          stroke-width={1.3}
        />
        <polygon points={bootstrapHead} fill="currentColor" />
      </g>
      <g>
        <line
          x1={cleanupX}
          y1={boxEdge}
          x2={cleanupX}
          y2={railEdge}
          stroke={CLEANUP_COLOR}
          stroke-width={1.3}
        />
        <polygon points={cleanupHead} fill={CLEANUP_COLOR} />
      </g>
    </>
  );
}

export function ConversationsFigure({ caption }: { caption?: string }) {
  return (
    <div class="code" style={{ margin: '0 0 22px' }}>
      {caption && (
        <div class="code-head">
          <span>{caption}</span>
        </div>
      )}
      <div
        style={{
          padding: '18px 0',
          display: 'flex',
          justifyContent: 'center',
          color: 'var(--code-fg)',
        }}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          style={{ maxWidth: W + 40, height: 'auto' }}
          font-family="JetBrains Mono, monospace"
        >
          {/* ----------- BEFORE — two long ongoing conversations ----------- */}
          <HeaderText
            y={BEFORE_HEADER_Y}
            text="WITHOUT RECONCILIATION — counterparties isolated in separate conversations"
          />

          <RowLabel y={BEFORE_ALICE_Y} label="Alice" className="fig-harness" />
          <LongOutline y={BEFORE_ALICE_Y} className="fig-harness" />
          {ALICE_SPANS.map((s, i) => (
            <ActivityFill key={`bf-a-${i}`} x={s.x} y={BEFORE_ALICE_Y} w={s.w} className="fig-harness" />
          ))}

          <RowLabel y={BEFORE_BOB_Y} label="Bob" className="fig-shade" />
          <LongOutline y={BEFORE_BOB_Y} className="fig-shade" />
          {BOB_SPANS.map((s, i) => (
            <ActivityFill key={`bf-b-${i}`} x={s.x} y={BEFORE_BOB_Y} w={s.w} className="fig-shade" />
          ))}

          <TimeAxis y={BEFORE_AXIS_Y} />

          {/* ----------- DIVIDER ----------- */}
          <line
            x1={40}
            y1={DIVIDER_Y}
            x2={W - 40}
            y2={DIVIDER_Y}
            stroke="currentColor"
            stroke-opacity={0.12}
            stroke-width={1}
            stroke-dasharray="2,3"
          />

          {/* ----------- AFTER — bounded conversations + memory rail ----------- */}
          <HeaderText
            y={AFTER_HEADER_Y}
            text="WITH RECONCILIATION — contexts bridged through shared memory"
          />

          {/* Alice row */}
          <RowLabel y={AFTER_ALICE_Y} label="Alice" className="fig-harness" />
          {ALICE_SPANS.map((s, i) => (
            <BoundedConversation
              key={`af-a-${i}`}
              x={s.x}
              y={AFTER_ALICE_Y}
              w={s.w}
              className="fig-harness"
            />
          ))}
          {ALICE_SPANS.map((s, i) => (
            <BoundaryArrows
              key={`af-a-arr-${i}`}
              box={s}
              rowY={AFTER_ALICE_Y}
              rowAboveRail={true}
            />
          ))}

          {/* Memory rail (same height as a conversation box) */}
          <rect
            x={ROW_X_START}
            y={AFTER_RAIL_Y}
            width={ROW_X_END - ROW_X_START}
            height={BOX_H}
            rx={3}
            class="fig-arrow"
            fill="currentColor"
            fill-opacity={0.12}
            stroke="currentColor"
            stroke-opacity={0.7}
            stroke-width={1.2}
          />
          <text
            x={ROW_X_START + 10}
            y={AFTER_RAIL_Y + BOX_H / 2}
            dy="0.35em"
            class="fig-arrow"
            fill="currentColor"
            font-size={11}
            font-family="JetBrains Mono, monospace"
          >
            /memory/
          </text>

          {/* Bob row */}
          <RowLabel y={AFTER_BOB_Y} label="Bob" className="fig-shade" />
          {BOB_SPANS.map((s, i) => (
            <BoundedConversation
              key={`af-b-${i}`}
              x={s.x}
              y={AFTER_BOB_Y}
              w={s.w}
              className="fig-shade"
            />
          ))}
          {BOB_SPANS.map((s, i) => (
            <BoundaryArrows
              key={`af-b-arr-${i}`}
              box={s}
              rowY={AFTER_BOB_Y}
              rowAboveRail={false}
            />
          ))}

          <TimeAxis y={AFTER_AXIS_Y} />
        </svg>
      </div>
    </div>
  );
}
