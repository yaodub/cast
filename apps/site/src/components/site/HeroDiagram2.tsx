// Hero diagram 2 — CLAUDE CODE mode. The mirror of HeroDiagram: same person,
// same opening request, the *other* interface.
//
// HeroDiagram is the console (Design/Configure) face — topology + multi-chat.
// This one is the terminal face. Styled like the ClaudeCodeMock in Home.tsx
// (Claude pixel banner, always-dark palette, header meta), it plays one beat
// loop:
//   1. the operator types the SAME prompt the hero opens with, into the input
//      box, then submits — it commits upward into the transcript as a `>` line
//   2. Claude Code "goes vibing": a spinner + a few tool-call flashes scroll by
//      (WebSearch, reading SPEC, thinking about the seam) so it reads as real
//      work
//   3. the reply streams in — a condensed architecture pitch, split between the
//      hero's punchy bubbles and a real Claude Code design dump: the system,
//      the wiring diagram, why three agents, the H−R divergence model, and the
//      safe-by-default discovery note
//
// Standalone — not wired into any page yet. Drop <HeroDiagram2 /> wherever.

import { useEffect, useReducer, useRef, useState } from 'preact/hooks';

// --- Palette --------------------------------------------------------------
// Always-dark "screenshot of the terminal" palette. Mirrors Home.tsx
// TRACK_DARK so this reads as the same surface as the static ClaudeCodeMock.
const T = {
  panelBorder: '#1f2937',
  inputBg: '#030712',
  inputBorder: '#374151',
  textPrimary: '#f9fafb',
  textSecondary: '#d1d5db',
  textMuted: '#6b7280',
  textDim: '#4b5563',
  green: '#22c55e',
  pink: '#ec4899',
  amber: '#f59e0b',
  cyan: '#7DD3FC',
  slate: '#9ca3af',
} as const;

// --- The pixel Claude mark (faithful CLI banner silhouette) ---------------
// Copied from Home.tsx ClaudeMark so the header reads identically to the
// static mock. Two eye holes + four bottom pixels, single evenodd path.
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

// --- Content --------------------------------------------------------------

// The request the hero opens with, in its Claude Code form: prefixed with the
// /cast-build skill command. The console face (HeroDiagram) uses the bare
// natural-language request instead — slash commands are a terminal thing.
const CMD = '/cast-build';
const REQUEST = "I want to track the AI hype and know when the bubble's about to pop.";
const PROMPT = `${CMD} ${REQUEST}`;

// A plain-language output line BEFORE any tool calls — Claude stating the plan
// in clear terms ("I'll do X, Y, then Z"). It types out, then sits a beat for
// reading before the tool calls fire.
const INTRO = "I'll review the Cast docs, weigh the hype against real numbers, then design the team.";

// Claude's reply headline — the "here's the plan" beat.
const HEAD = "I propose three agents.";

// Security guarantee line — types in letter by letter (not a fade-in block).
const NOTE = "Each agent runs sandboxed. Network access only where it's needed.";

// Tool-call flashes shown while vibing — Claude reads the Cast spec + a manual
// (clearly Cast files, so the run reads as Cast, not vanilla Claude Code), then
// researches the market on the web. Revealed one at a time.
const TOOLS: Array<{ name: string; arg: string; cast?: boolean }> = [
  { name: 'Read', arg: 'agent-schema/SPEC.md' },
  { name: 'Read', arg: 'manuals/multi-agent-composition.md' },
  { name: 'WebSearch', arg: 'AI mega-rounds, valuations, skeptic warnings' },
];

// The proposal. Mirrors the hero diagram: three agents, one punchy line each
// for what it does, then the wiring, then the build confirm. Every line has to
// be readable in the ~1.7s it's on screen before the next appears.
type Item =
  | { kind: 'kv'; label: string; body: string }
  | { kind: 'ascii'; lines: string[] }
  | { kind: 'note'; text: string }
  | { kind: 'confirm'; label: string };

const BODY: Item[] = [
  { kind: 'kv', label: 'hype-meter', body: 'the froth — funding rounds, headlines, hype.' },
  { kind: 'kv', label: 'reality-check', body: 'the fundamentals — revenue, adoption, layoffs.' },
  { kind: 'kv', label: 'briefer', body: 'reads both each morning, calls which side is winning.' },
  {
    kind: 'ascii',
    lines: [
      '  hype-meter ─────┐',
      '                  ├──►  briefer ──► you',
      '  reality-check ──┘',
    ],
  },
  { kind: 'note', text: NOTE },
  { kind: 'confirm', label: 'Build all three?' },
];

const SPIN = ['✶', '✸', '✻', '✺', '✹', '✷'];

// --- State + timeline -----------------------------------------------------

interface State {
  inputStarted: boolean; // input box has begun typing
  inputTyped: number; // chars shown in the input box
  submitted: boolean; // prompt committed upward into transcript
  introStarted: boolean; // plain plan line has begun typing
  introTyped: number; // chars of INTRO typed
  working: boolean; // vibing spinner visible
  workT: number; // ticks elapsed while working (drives spinner + timer)
  tools: number; // tool-call lines revealed
  headStarted: boolean; // reply headline has begun typing
  headTyped: number; // chars of HEAD typed
  blocks: number; // BODY items revealed
  noteTyped: number; // chars of the security NOTE typed (letter-by-letter)
  t: number; // global tick counter (spinner phase)
}

const INITIAL: State = {
  // The loop opens with the request ALREADY fully typed in the input box — the
  // typing-out of the prompt is trimmed from the start.
  inputStarted: true,
  inputTyped: PROMPT.length,
  submitted: false,
  introStarted: false,
  introTyped: 0,
  working: false,
  workT: 0,
  tools: 0,
  headStarted: false,
  headTyped: 0,
  blocks: 0,
  noteTyped: 0,
  t: 0,
};

type Beat = { at: number; patch: (s: State) => State };

// Typing runs at ~27 chars/sec (tick=30ms, cpt=0.8 — half speed). Beats are
// spaced generously so the whole loop reads unhurried (~22s).
const TIMELINE: Beat[] = [
  // The loop opens with the request already typed (see INITIAL). Hold ~1s on
  // the full prompt (caret blinking), then hit enter — the prompt commits into
  // the transcript. No spinner yet.
  { at: 1000, patch: (s) => ({ ...s, submitted: true }) },

  // ~1s after submit, Claude states the plan in plain language. The line types
  // out (no spinner yet), then sits a beat for reading.
  { at: 2000, patch: (s) => ({ ...s, introStarted: true }) },

  // Vibing spinner appears first, ALONE. Then the tool calls flash in above it
  // one at a time, with the delay after each call doubling (1.3s → 2.6s): read
  // the spec, read a manual, then web research.
  { at: 6800, patch: (s) => ({ ...s, working: true }) },
  { at: 8100, patch: (s) => ({ ...s, tools: 1 }) },
  { at: 9400, patch: (s) => ({ ...s, tools: 2 }) },
  { at: 12000, patch: (s) => ({ ...s, tools: 3 }) },

  // Vibe a touch longer after the last flash, then the spinner clears and the
  // reply headline types in.
  { at: 14200, patch: (s) => ({ ...s, working: false, headStarted: true }) },

  // Proposal lines cascade in after the headline finishes, ~1.7s apart so each
  // is readable before the next lands. The security note (block 5) types in
  // letter by letter, so the confirm waits for it to finish (~2.4s).
  { at: 15900, patch: (s) => ({ ...s, blocks: 1 }) }, // hype-meter
  { at: 17600, patch: (s) => ({ ...s, blocks: 2 }) }, // reality-check
  { at: 19300, patch: (s) => ({ ...s, blocks: 3 }) }, // briefer
  { at: 21000, patch: (s) => ({ ...s, blocks: 4 }) }, // wiring diagram
  { at: 22700, patch: (s) => ({ ...s, blocks: 5 }) }, // security note (types in)
  { at: 26100, patch: (s) => ({ ...s, blocks: 6 }) }, // build all three?
];

const HOLD_MS = 4500;
const LAST_BEAT = TIMELINE[TIMELINE.length - 1]!.at;
const TOTAL_MS = LAST_BEAT + HOLD_MS;

const CPT = 0.8;

type Action = { type: 'patch'; patch: (s: State) => State } | { type: 'tick' } | { type: 'reset' };

function reducer(s: State, a: Action): State {
  if (a.type === 'patch') return a.patch(s);
  if (a.type === 'reset') return INITIAL;
  const step = (cur: number, max: number) => Math.min(cur + CPT, max);
  return {
    ...s,
    t: s.t + 1,
    workT: s.working ? s.workT + 1 : s.workT,
    inputTyped:
      s.inputStarted && !s.submitted ? step(s.inputTyped, PROMPT.length) : s.inputTyped,
    introTyped: s.introStarted ? step(s.introTyped, INTRO.length) : s.introTyped,
    headTyped:
      s.headStarted && !s.working ? step(s.headTyped, HEAD.length) : s.headTyped,
    noteTyped: s.blocks >= 5 ? step(s.noteTyped, NOTE.length) : s.noteTyped,
  };
}

// --- Styles ---------------------------------------------------------------

const STYLES = `
  @keyframes h2-caret-blink { 0%,50% { opacity: 1; } 50.01%,100% { opacity: 0; } }
  .h2-caret { display: inline-block; margin-left: 1px; animation: h2-caret-blink 0.9s steps(1) infinite; }

  @keyframes h2-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
  .h2-in { animation: h2-in 280ms cubic-bezier(.2,.7,.3,1) both; }

  @keyframes h2-dot { 0%,100% { opacity: 0.3; } 50% { opacity: 1; } }
`;

// --- Bits -----------------------------------------------------------------

function Caret() {
  return (
    <span className="h2-caret" style={{ color: T.textMuted, opacity: 0.7 }}>
      ▎
    </span>
  );
}

// Render a (possibly partial) prompt string with the leading /cast-build skill
// command tinted cyan and the rest in `rest`. Used by both the input bar and
// the committed transcript line so the command reads identically in both. Wrap
// the result in a single element — it emits two spans.
function PromptSpans({ shown, rest }: { shown: string; rest: string }) {
  const cmd = shown.slice(0, CMD.length);
  const tail = shown.length > CMD.length ? shown.slice(CMD.length) : '';
  return (
    <>
      <span style={{ color: T.cyan, fontWeight: 600 }}>{cmd}</span>
      <span style={{ color: rest }}>{tail}</span>
    </>
  );
}

// A single tool-call flash line: run-dot, tool name, arg. The Cast skill step
// (`cast`) gets a pink dot + pink name + brighter arg so it stands out from the
// generic green/cyan tool flashes — the "this is Cast" beat.
function ToolLine({ name, arg, cast }: { name: string; arg: string; cast?: boolean }) {
  return (
    <div
      className="h2-in"
      style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginTop: 4 }}
    >
      <span style={{ color: cast ? T.pink : T.green, flexShrink: 0 }}>⏺</span>
      <span style={{ color: cast ? T.pink : T.cyan, fontWeight: 600 }}>{name}</span>
      <span style={{ color: cast ? T.textSecondary : T.textDim, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        ({arg})
      </span>
    </div>
  );
}

function VibingLine({ glyph, secs }: { glyph: string; secs: number }) {
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginTop: 8, color: T.textMuted }}>
      <span style={{ color: T.amber, width: 12, display: 'inline-block', flexShrink: 0 }}>{glyph}</span>
      <span style={{ color: T.textSecondary }}>Vibing…</span>
      <span style={{ color: T.textDim }}>({secs}s · esc to interrupt)</span>
    </div>
  );
}

// One agent in the proposal — a bulleted line, agent name in cyan, the rest
// plain. Mirrors the hero diagram's "• [hype-meter] — froth" list.
function KvBlock({ label, body }: { label: string; body: string }) {
  return (
    <div className="h2-in" style={{ marginTop: 12, lineHeight: 1.6, display: 'flex', gap: 8 }}>
      <span style={{ color: T.textDim, flexShrink: 0 }}>•</span>
      <span>
        <span style={{ color: T.cyan, fontWeight: 700 }}>{label}</span>
        <span style={{ color: T.textPrimary }}> — {body}</span>
      </span>
    </div>
  );
}

// Rendered as a <div>, not a <pre>: the site's y2k skin forces a navy
// background + amber shadow on every <pre> via `!important`, which an inline
// style can't override. A div with white-space: pre keeps it plain white
// terminal text — same color/size as the rest, no box.
function AsciiBlock({ lines }: { lines: string[] }) {
  return (
    <div
      className="h2-in"
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
      {lines.join('\n')}
    </div>
  );
}

// The security guarantee line — a plain statement (not an agent bullet) that
// types in letter by letter. No marker; reads as ordinary terminal output.
function NoteBlock({ text, typed }: { text: string; typed: number }) {
  return (
    <div style={{ marginTop: 16, lineHeight: 1.6, color: T.textPrimary, fontWeight: 700 }}>
      {text.slice(0, Math.floor(typed))}
      {typed < text.length && <Caret />}
    </div>
  );
}

function ConfirmBlock({ label }: { label: string }) {
  return (
    <div className="h2-in" style={{ marginTop: 14 }}>
      <span style={{ color: T.pink, fontWeight: 700 }}>{label}</span>
    </div>
  );
}

// --- Transcript (scroll-pinned to the bottom, terminal-style) -------------

function Transcript({ state }: { state: State }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);

  // Recompute whenever revealed content changes. Pin the bottom once the
  // transcript overflows the viewport, otherwise sit at the top.
  const rev =
    (state.submitted ? 1 : 0) +
    Math.floor(state.introTyped) * 7 +
    state.tools * 1000 +
    (state.working ? 1 : 0) +
    Math.floor(state.headTyped) * 7000 +
    state.blocks * 2000000 +
    Math.floor(state.noteTyped) * 90000;

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const c = containerRef.current;
      const inner = innerRef.current;
      if (!c || !inner) return;
      const overflow = inner.scrollHeight - c.clientHeight;
      setShift(overflow > 0 ? overflow : 0);
    });
    return () => cancelAnimationFrame(raf);
  }, [rev]);

  const glyph = SPIN[Math.floor(state.workT / 5) % SPIN.length]!;
  const secs = Math.max(1, Math.floor((state.workT * 30) / 1000));

  return (
    <div ref={containerRef} style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}>
      <div
        ref={innerRef}
        style={{
          transform: `translateY(${-shift}px)`,
          transition: 'transform 500ms cubic-bezier(.2,.7,.3,1)',
          willChange: 'transform',
        }}
      >
        {/* The committed prompt line. */}
        {state.submitted && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
            <span style={{ color: T.pink, flexShrink: 0 }}>&gt;</span>
            <span>
              <PromptSpans shown={PROMPT} rest={T.textSecondary} />
            </span>
          </div>
        )}

        {/* Plain plan line — Claude stating what it'll do, before any tools. */}
        {state.introStarted && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginTop: 14, lineHeight: 1.6 }}>
            <span style={{ color: T.pink, flexShrink: 0 }}>⏺</span>
            <span style={{ color: T.textPrimary }}>
              {INTRO.slice(0, Math.floor(state.introTyped))}
              {state.introTyped < INTRO.length && <Caret />}
            </span>
          </div>
        )}

        {/* Tool-call flashes. */}
        {TOOLS.slice(0, state.tools).map((t) => (
          <ToolLine key={t.name + t.arg} name={t.name} arg={t.arg} cast={t.cast} />
        ))}

        {/* The vibing spinner — only while working. */}
        {state.working && <VibingLine glyph={glyph} secs={secs} />}

        {/* Reply headline, typed. Pink assistant marker. */}
        {state.headStarted && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', marginTop: 14, lineHeight: 1.6 }}>
            <span style={{ color: T.pink, flexShrink: 0 }}>⏺</span>
            <span style={{ color: T.textPrimary, fontWeight: 600 }}>
              {HEAD.slice(0, Math.floor(state.headTyped))}
              {state.headTyped < HEAD.length && <Caret />}
            </span>
          </div>
        )}

        {/* Architecture blocks, indented under the assistant marker. */}
        <div style={{ paddingLeft: 22 }}>
          {BODY.slice(0, state.blocks).map((item, i) => {
            if (item.kind === 'ascii') return <AsciiBlock key={i} lines={item.lines} />;
            if (item.kind === 'note') return <NoteBlock key={i} text={item.text} typed={state.noteTyped} />;
            if (item.kind === 'confirm') return <ConfirmBlock key={i} label={item.label} />;
            return <KvBlock key={i} label={item.label} body={item.body} />;
          })}
        </div>
      </div>
    </div>
  );
}

// --- Input bar (chrome) ---------------------------------------------------

function InputBar({ state }: { state: State }) {
  // Before submit the prompt types here; after submit it goes empty + idle.
  const typing = state.inputStarted && !state.submitted;
  const shown = typing ? PROMPT.slice(0, Math.floor(state.inputTyped)) : '';
  return (
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
      <span style={{ color: T.textPrimary, minWidth: 0, flex: 1 }}>
        <PromptSpans shown={shown} rest={T.textPrimary} />
        {!state.submitted && <Caret />}
        {state.submitted && (
          <span style={{ color: T.textDim }}>
            <Caret />
          </span>
        )}
      </span>
    </div>
  );
}

// --- Frame ----------------------------------------------------------------

function AnimatedTerminal({ runKey }: { runKey: number }) {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  useEffect(() => {
    dispatch({ type: 'reset' });
    const timers: number[] = [];
    for (const beat of TIMELINE) {
      timers.push(window.setTimeout(() => dispatch({ type: 'patch', patch: beat.patch }), beat.at));
    }
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [runKey]);

  useEffect(() => {
    const tick = window.setInterval(() => dispatch({ type: 'tick' }), 30);
    return () => window.clearInterval(tick);
  }, []);

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
        // No border here — when embedded in HeroTabs the tab window frames it.
        // Aspect harmonized with HeroDiagram (920/525) so tabbing doesn't jump.
        borderRadius: 0,
        overflow: 'hidden',
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
        aspectRatio: '920 / 525',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 13.5,
      }}
    >
      {/* Banner header — identical register to the static ClaudeCodeMock. */}
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

      {/* Transcript — the live conversation. */}
      <div style={{ flex: 1, overflow: 'hidden', padding: '16px 18px', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Transcript state={state} />
      </div>

      {/* Input bar chrome. */}
      <InputBar state={state} />
    </div>
  );
}

export function HeroDiagram2() {
  const [runKey, setRunKey] = useState(0);

  useEffect(() => {
    const t = window.setTimeout(() => setRunKey((k) => k + 1), TOTAL_MS);
    return () => window.clearTimeout(t);
  }, [runKey]);

  return (
    <>
      <style>{STYLES}</style>
      <AnimatedTerminal key={runKey} runKey={runKey} />
    </>
  );
}
