// Hero diagram 2 — STILL twin. A no-animation snapshot of HeroDiagram2's final
// frame: the committed prompt, the plan line, the three tool calls, the "I
// propose three agents" headline, then the three agents collapsed onto ONE
// wrapping line (no hard breaks), the wiring diagram, the security note, and the
// confirm.
//
// Deliberately self-contained — its own copy of the palette, the pixel mark, and
// the content. Nothing is shared with HeroDiagram2.tsx so this can be tweaked or
// deleted on its own. Standalone; drop <HeroDiagram2Still /> wherever.

// --- Palette --------------------------------------------------------------
// Always-dark "screenshot of the terminal" palette.
const T = {
  panelBorder: '#1f2937',
  inputBg: '#030712',
  textPrimary: '#f9fafb',
  textSecondary: '#d1d5db',
  textMuted: '#6b7280',
  textDim: '#4b5563',
  green: '#22c55e',
  pink: '#ec4899',
  cyan: '#7DD3FC',
} as const;

// --- The pixel Claude mark (faithful CLI banner silhouette) ---------------
function ClaudeMark({ pixel = 6, color }: { pixel?: number; color: string }) {
  const d = [
    'M3 0H15V4H17V6H15V8H3V6H1V4H3Z',
    'M5 2H6V4H5Z',
    'M12 2H13V4H12Z',
    'M4 8H5V10H4Z',
    'M6 8H7V10H6Z',
    'M11 8H12V10H11Z',
    'M13 8H14V10H13Z',
  ].join(' ');
  const w = 18 * pixel;
  const h = 10 * pixel;
  const scale = 0.8;
  return (
    <svg
      width={w * scale}
      height={h * scale}
      viewBox="0 0 18 10"
      aria-hidden="true"
      shapeRendering="crispEdges"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <path d={d} fill={color} style={{ fillRule: 'evenodd' }} />
    </svg>
  );
}

// --- Content (own copy) ---------------------------------------------------

const PROMPT = "I want to track the AI hype and know when the bubble's about to pop.";
const INTRO = "I'll review the Cast docs, weigh the hype against real numbers, then design the team.";
const HEAD = "I propose three agents.";
const NOTE = "Each agent runs sandboxed. Network access only where it's needed.";

const TOOLS: Array<{ name: string; arg: string }> = [
  { name: 'Read', arg: 'agent-schema/SPEC.md' },
  { name: 'Read', arg: 'manuals/multi-agent-composition.md' },
  { name: 'WebSearch', arg: 'AI mega-rounds, valuations, skeptic warnings' },
];

// The three agents — rendered on one wrapping line in the still (not bulleted).
const AGENTS: Array<{ label: string; body: string }> = [
  { label: 'hype-meter', body: 'the froth — funding rounds, headlines, hype.' },
  { label: 'reality-check', body: 'the fundamentals — revenue, adoption, layoffs.' },
  { label: 'briefer', body: 'reads both each morning, calls which side is winning.' },
];

const ASCII_LINES = [
  '  hype-meter ─────┐',
  '                  ├──►  briefer ──► you',
  '  reality-check ──┘',
];

// --- Still frame ----------------------------------------------------------

export function HeroDiagram2Still() {
  const headerMeta = [
    <>
      Claude Code <span style={{ color: T.textPrimary }}>v2.1.150</span>
    </>,
    <>
      <span style={{ color: T.textPrimary }}>Opus 4.8</span> (1M context) · Claude Max
    </>,
    <span style={{ color: T.textPrimary }}>~/.cast/agents/</span>,
  ];

  return (
    <div
      style={{
        border: `1px solid ${T.panelBorder}`,
        borderRadius: 0,
        overflow: 'hidden',
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 13.5,
      }}
    >
      {/* Banner header. */}
      <div style={{ display: 'flex', gap: 14, padding: '16px 18px 14px', borderBottom: `1px solid ${T.panelBorder}` }}>
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <ClaudeMark color={T.pink} />
        </div>
        <div
          style={{
            fontSize: 12.5,
            lineHeight: 1.45,
            color: T.textSecondary,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
          }}
        >
          {headerMeta.map((m, i) => (
            <div key={i}>{m}</div>
          ))}
        </div>
      </div>

      {/* Transcript — fully revealed, no animation. */}
      <div style={{ padding: '16px 18px' }}>
        {/* Committed prompt. */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
          <span style={{ color: T.pink, flexShrink: 0 }}>&gt;</span>
          <span style={{ color: T.textSecondary }}>
            <span style={{ color: T.cyan, fontWeight: 600 }}>/cast-build</span>{' '}
            {PROMPT}
          </span>
        </div>

        {/* Plain plan line. */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginTop: 14, lineHeight: 1.6 }}>
          <span style={{ color: T.pink, flexShrink: 0 }}>⏺</span>
          <span style={{ color: T.textPrimary }}>{INTRO}</span>
        </div>

        {/* Tool-call flashes. */}
        {TOOLS.map((t) => (
          <div
            key={t.name + t.arg}
            style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginTop: 4 }}
          >
            <span style={{ color: T.green, flexShrink: 0 }}>⏺</span>
            <span style={{ color: T.cyan, fontWeight: 600 }}>{t.name}</span>
            <span style={{ color: T.textDim, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              ({t.arg})
            </span>
          </div>
        ))}

        {/* Reply headline. */}
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginTop: 14, lineHeight: 1.6 }}>
          <span style={{ color: T.pink, flexShrink: 0 }}>⏺</span>
          <span style={{ color: T.textPrimary, fontWeight: 600 }}>{HEAD}</span>
        </div>

        {/* Body, indented under the assistant marker. */}
        <div style={{ paddingLeft: 22 }}>
          {/* The three agents on a single wrapping line — no bullets, no breaks. */}
          <div style={{ marginTop: 12, lineHeight: 1.6, color: T.textPrimary }}>
            {AGENTS.map((a, i) => (
              <span key={a.label}>
                <span style={{ color: T.cyan, fontWeight: 700 }}>{a.label}</span>
                <span> — {a.body}</span>
                {i < AGENTS.length - 1 ? ' ' : ''}
              </span>
            ))}
          </div>

          {/* Wiring diagram. */}
          <div
            style={{
              margin: '14px 0 2px',
              color: T.textPrimary,
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 13.5,
              lineHeight: 1.5,
              whiteSpace: 'pre',
              overflow: 'hidden',
            }}
          >
            {ASCII_LINES.join('\n')}
          </div>

          {/* Security note. */}
          <div style={{ marginTop: 16, lineHeight: 1.6, color: T.textPrimary, fontWeight: 700 }}>
            {NOTE}
          </div>

          {/* Confirm. */}
          <div style={{ marginTop: 14 }}>
            <span style={{ color: T.pink, fontWeight: 700 }}>Build all three?</span>
          </div>
        </div>
      </div>

      {/* Input bar chrome — empty, static (no blinking caret). */}
      <div
        style={{
          borderTop: `1px solid ${T.panelBorder}`,
          background: T.inputBg,
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 14,
        }}
      >
        <span style={{ color: T.pink, flexShrink: 0 }}>&gt;</span>
        <span style={{ color: T.textMuted, opacity: 0.7 }}>▎</span>
      </div>
    </div>
  );
}
