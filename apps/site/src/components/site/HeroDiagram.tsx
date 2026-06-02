// Hero diagram — TOPOLOGY-ON-TOP animated mock.
//
// Top section (~28% of frame) is the topology view: agent fixed in center,
// PM persistent on left, peer transient on right. On-demand flowing-dash
// arrows show message direction. "Thinking" indicator lives next to the
// agent in the topo when between consultations.
//
// Bottom section (chats) — two side-by-side chat panels. Headers simplified
// to just two small avatars (no names, no arrows, no via X). Bubble content
// is the conversation itself.
//
// Spacer in secondary chat keeps the agent's right-side bubble vertically
// aligned with the agent "..." on the left chat — the row position IS the
// timeline.

import { useEffect, useReducer, useRef, useState } from 'preact/hooks';
import { TWEMOJI, type TwemojiKey } from './twemoji';

// --- Data -----------------------------------------------------------------

interface PeerHeader {
  label: string;
  kind: 'human' | 'agent';
  initials?: string;
  gender?: 'male' | 'female';
  // Mark an agent as having privileged data access — adds a lock badge to
  // its avatar in topology. Signals "this agent sees private data; the
  // fleet only sees its summarized output."
  secure?: boolean;
  // Per-identity hue (oklch) — fixed L/C, only hue varies. When set, avatar
  // and chat bubble use this hue with white foreground. Absent for the main
  // agent-designer agent, which stays on a neutral grey-on-dark-text palette
  // so the colored peers/users read as foils against it.
  hue?: number;
}

// Central orchestrator — DM (All-Agents Design). Neutral palette so the
// colored agents being briefed read as foils against it.
const DM:       PeerHeader = { label: 'agent-designer', kind: 'agent' };
// Three new agents being briefed. Hues spread around the wheel; hype-meter
// gets the warmest (froth → heat); reality-check gets sober teal;
// briefer gets editorial violet.
const HYPE:     PeerHeader = { label: 'hype-meter',    kind: 'agent', hue: 25  };
const REALITY:  PeerHeader = { label: 'reality-check', kind: 'agent', hue: 160 };
const BRIEFER:  PeerHeader = { label: 'briefer',       kind: 'agent', hue: 280 };
const USER_HDR: PeerHeader = { label: 'Mark', kind: 'human', initials: 'M', gender: 'male', hue: 230 };

// Fixed lightness + chroma, only hue varies per identity. L=68/C=0.18 gives
// a vivid mid-tone that still reads cleanly with white text on top — more
// saturated than the original soft palette but well shy of neon. Hues are
// spread around the wheel so adjacent peers in topology don't collide.
const FIXED_L = 68;
const FIXED_C = 0.18;
function peerColor(hue: number, alpha?: number): string {
  return alpha === undefined
    ? `oklch(${FIXED_L}% ${FIXED_C} ${hue})`
    : `oklch(${FIXED_L}% ${FIXED_C} ${hue} / ${alpha})`;
}

interface PeerTone {
  avatarBg: string;
  avatarFg: string;
  bubbleBg: string;
  bubbleFg: string;
  // Optional bubble outline. Only the agent-designer uses it (the "Design
  // console" treatment); colored peers/user fill solid and stay borderless.
  bubbleBorder?: string;
}
function peerTone(p: PeerHeader): PeerTone {
  // Main agent — neutral surface so colored peers read against it. Uses
  // the local --cast-hero-agent-surface token (flips light/dark behaviour) so
  // the bubble stays visible on the chat surface in both themes.
  if (p.label === 'agent-designer') {
    return {
      avatarBg: 'var(--cast-hero-agent-surface)',
      avatarFg: 'var(--cast-hero-agent-fg)',
      bubbleBg: 'var(--cast-hero-agent-surface)',
      bubbleFg: 'var(--cast-hero-agent-fg)',
      bubbleBorder: 'var(--cast-hero-agent-border)',
    };
  }
  if (p.hue !== undefined) {
    const c = peerColor(p.hue);
    if (p.kind === 'agent') {
      // Mirror the agent-designer "console" treatment in each agent's own
      // hue: translucent fill, vivid hue outline, light text.
      return {
        avatarBg: c,
        avatarFg: '#fff',
        bubbleBg: peerColor(p.hue, 0.15),
        bubbleFg: '#f9fafb',
        bubbleBorder: `1px solid ${c}`,
      };
    }
    // Human (the operator) keeps a solid fill so they read distinct from
    // the agent fleet.
    return { avatarBg: c, avatarFg: '#fff', bubbleBg: c, bubbleFg: '#fff' };
  }
  return { avatarBg: 'var(--bg-elev)', avatarFg: 'var(--fg)', bubbleBg: 'var(--bg-elev)', bubbleFg: 'var(--fg)' };
}

// Twemoji key for a peer — gendered if we know, generic otherwise.
function peerEmoji(p: PeerHeader): TwemojiKey {
  if (p.kind === 'agent') return 'robot';
  if (p.gender === 'male') return 'male';
  if (p.gender === 'female') return 'female';
  return 'person';
}

// Render a Twemoji SVG as an <img>. Used everywhere the diagram shows an
// emoji — agent/human avatars in the topology, the prefix in bubble labels,
// and the final 👍 reply bubble. Going through Twemoji guarantees the same
// glyph on every OS / browser (Apple, Windows, Linux, Android all ship
// different native emoji fonts).
function TwImg({ name, size, style }: { name: TwemojiKey; size: number; style?: Record<string, string | number> }) {
  return (
    <img
      src={TWEMOJI[name]}
      width={size}
      height={size}
      alt=""
      style={{ display: 'inline-block', verticalAlign: 'middle', ...(style || {}) }}
    />
  );
}

type BubbleState =
  | { kind: 'hidden' }
  | { kind: 'dots' }
  | { kind: 'text'; text: string; typed: number }
  | { kind: 'emoji'; name: TwemojiKey };

type ArrowState = 'hidden' | 'right' | 'left';

// One bubble entry in a chat column. Defined up here because State holds an
// array of these (the secondary chat's history).
interface ChatItem {
  key: string;
  speaker: PeerHeader;
  bubble: BubbleState;
  alignSelf: 'flex-start' | 'flex-end';
  // Suppress the bubble-in mount animation. Used for history items that were
  // flushed from a stable `cur-*` key into a new history key — visually they
  // should be a no-op, not "fly in from below".
  noAnim?: boolean;
}

interface State {
  pm: BubbleState;
  laAck: BubbleState;       // LA's "let me check" acknowledgment (stays visible)
  agentLeft: BubbleState;   // LA's response slot: dots while consulting → synthesis text
  secondaryOpen: boolean;
  peer: PeerHeader | null;
  // LA's single outgoing bubble in the secondary chat. Morphs in place
  // between dots (bridge/thinking) and text (the question to the current
  // peer). It is never reset to "hidden" between consultations — it just
  // changes content — which gives the user the visual effect of the "..."
  // becoming the next question.
  laBubble: BubbleState;
  peerBubble: BubbleState;
  pmReply: BubbleState;
  pmArrow: ArrowState;      // arrow between PM and agent in topo
  peerArrow: ArrowState;    // arrow between agent and peer in topo
  // Completed Q+R blocks from prior peer consultations. Each peer transition
  // flushes the current peer's typed question + reply here so they persist
  // and scroll up out of view rather than vanishing.
  secondaryHistory: ChatItem[];
}

const INITIAL: State = {
  pm: { kind: 'hidden' },
  laAck: { kind: 'hidden' },
  agentLeft: { kind: 'hidden' },
  secondaryOpen: false,
  peer: null,
  laBubble: { kind: 'hidden' },
  peerBubble: { kind: 'hidden' },
  pmReply: { kind: 'hidden' },
  pmArrow: 'hidden',
  peerArrow: 'hidden',
  secondaryHistory: [],
};

// Freeze the current peer's question + reply into the history list. Called
// AFTER the peer has replied (i.e. between consultations), so the current
// laBubble holds the question text and peerBubble holds the reply text. The
// active laBubble is NOT flushed — after the flush, callers set laBubble to
// dots (the bridge) which then morphs into the next question's text in
// place, in the same DOM bubble.
function flushSecondary(s: State): ChatItem[] {
  if (!s.peer) return s.secondaryHistory;
  const peer = s.peer;
  const base = s.secondaryHistory.length;
  const items: ChatItem[] = [];
  if (s.laBubble.kind !== 'hidden') {
    items.push({ key: `h${base}-q`, speaker: DM, bubble: s.laBubble, alignSelf: 'flex-start', noAnim: true });
  }
  if (s.peerBubble.kind !== 'hidden') {
    items.push({ key: `h${base}-r`, speaker: peer, bubble: s.peerBubble, alignSelf: 'flex-end', noAnim: true });
  }
  return [...s.secondaryHistory, ...items];
}

// --- Timeline -------------------------------------------------------------

type Beat = { at: number; patch: (s: State) => State };

// Timing notes: tick interval is 30ms with cpt=1 (see AnimatedDiagram below),
// so typing runs at ~33 chars/sec. The new briefs are denser than the parked
// diagram's chat — speeding the typewriter keeps total under 60s without
// shortening the script.

// Timing: typing speed is ~33 chars/sec (tick=30ms, cpt=1).
// All transition gaps after a bubble finishes typing are normalized to
// ~400-500ms — long enough to read, short enough not to drag.

const TIMELINE: Beat[] = [
  // Beat 1 — Mark briefs DM. ~68 chars × 30ms ≈ 2.0s typing → done ~3140.
  { at: 200,   patch: (s) => ({ ...s, pmArrow: 'right' }) },
  { at: 400,   patch: (s) => ({ ...s, pm: { kind: 'dots' } }) },
  { at: 1100,  patch: (s) => ({ ...s, pm: { kind: 'text', text: "I want to track the AI hype and know when the bubble's about to pop.", typed: 0 } }) },

  // Beat 2 — DM proposes shape. ~126 chars × 30ms ≈ 3.8s typing → done ~8100.
  { at: 3700,  patch: (s) => ({ ...s, pmArrow: 'left', laAck: { kind: 'dots' } }) },
  { at: 4300,  patch: (s) => ({ ...s, laAck: { kind: 'text', text: "Creating three agents:\n• [hype-meter] — froth\n• [reality-check] — substance\n• [briefer] — synthesis", typed: 0 } }) },
  { at: 8500,  patch: (s) => ({ ...s, pmArrow: 'hidden' }) },
  { at: 8700,  patch: (s) => ({ ...s, agentLeft: { kind: 'dots' } }) },

  // Beat 3 — hype-meter. Brief ~110 chars × 30ms ≈ 3.3s → done ~13300.
  // Response 69 chars ≈ 2.1s → done ~16370.
  { at: 9000,  patch: (s) => ({ ...s, secondaryOpen: true, peer: HYPE }) },
  { at: 9400,  patch: (s) => ({ ...s, peerArrow: 'right' }) },
  { at: 9600,  patch: (s) => ({ ...s, laBubble: { kind: 'dots' } }) },
  { at: 10000, patch: (s) => ({ ...s, laBubble: { kind: 'text', text: "[hype-meter], go deep on AI hype. Track VC announcements, press, investor chatter. Develop the read on what's overheated.", typed: 0 } }) },
  { at: 14200, patch: (s) => ({ ...s, peerArrow: 'hidden', peerBubble: { kind: 'dots' } }) },
  { at: 14100, patch: (s) => ({ ...s, peerArrow: 'left' }) },
  { at: 14800, patch: (s) => ({ ...s, peerBubble: { kind: 'text', text: "Got it. The angle I'll work: where the talk runs ahead of the money.", typed: 0 } }) },
  { at: 16800, patch: (s) => ({ ...s, peerArrow: 'hidden' }) },

  // Beat 4 — reality-check. Brief ~113 chars ≈ 3.4s → done ~22200. Response ~82 chars ≈ 2.5s → done ~25700.
  { at: 17500, patch: (s) => ({ ...s, secondaryHistory: flushSecondary(s), laBubble: { kind: 'dots' }, peerBubble: { kind: 'hidden' } }) },
  { at: 18000, patch: (s) => ({ ...s, peer: REALITY }) },
  { at: 18400, patch: (s) => ({ ...s, peerArrow: 'right' }) },
  { at: 18800, patch: (s) => ({ ...s, laBubble: { kind: 'text', text: "[reality-check], go deep on AI adoption. Track revenue, wind-downs, ARR multiples. Develop the read on what's actually working.", typed: 0 } }) },
  { at: 23100, patch: (s) => ({ ...s, peerArrow: 'hidden', peerBubble: { kind: 'dots' } }) },
  { at: 23000, patch: (s) => ({ ...s, peerArrow: 'left' }) },
  { at: 23700, patch: (s) => ({ ...s, peerBubble: { kind: 'text', text: "Understood. The angle: where companies announce big and the numbers don't match.", typed: 0 } }) },
  { at: 26100, patch: (s) => ({ ...s, peerArrow: 'hidden' }) },

  // Beat 5 — briefer. Brief ~110 chars ≈ 3.3s → done ~31400. Response ~82 chars ≈ 2.5s → done ~34900.
  { at: 26800, patch: (s) => ({ ...s, secondaryHistory: flushSecondary(s), laBubble: { kind: 'dots' }, peerBubble: { kind: 'hidden' } }) },
  { at: 27300, patch: (s) => ({ ...s, peer: BRIEFER }) },
  { at: 27700, patch: (s) => ({ ...s, peerArrow: 'right' }) },
  { at: 28100, patch: (s) => ({ ...s, laBubble: { kind: 'text', text: "[briefer], you're the editor. Each morning, ask [hype-meter] and [reality-check] what they see. The gap is the signal.", typed: 0 } }) },
  { at: 32000, patch: (s) => ({ ...s, peerArrow: 'hidden', peerBubble: { kind: 'dots' } }) },
  { at: 32200, patch: (s) => ({ ...s, peerArrow: 'left' }) },
  { at: 32600, patch: (s) => ({ ...s, peerBubble: { kind: 'text', text: "On it. Each morning I'll force a single bottom-line call — which side is winning.", typed: 0 } }) },
  { at: 35300, patch: (s) => ({ ...s, peerArrow: 'hidden' }) },

  // Beat 6 — DM closes secondary, synthesizes to Mark. 71 chars ≈ 2.1s → done ~39100.
  { at: 36300, patch: (s) => ({ ...s, secondaryOpen: false }) },
  { at: 36800, patch: (s) => ({ ...s, pmArrow: 'left' }) },
  { at: 37000, patch: (s) => ({
    ...s,
    agentLeft: {
      kind: 'text',
      text: "Your two reporters and the editor are live. They'll reach out shortly.",
      typed: 0,
    },
  }) },
  { at: 39500, patch: (s) => ({ ...s, pmArrow: 'hidden' }) },

  // Beat 7 — Mark thumbs up.
  { at: 39800, patch: (s) => ({ ...s, pmReply: { kind: 'dots' } }) },
  { at: 40800, patch: (s) => ({ ...s, pmArrow: 'right' }) },
  { at: 41000, patch: (s) => ({ ...s, pmReply: { kind: 'emoji', name: 'thumbsUp' } }) },
  { at: 42100, patch: (s) => ({ ...s, pmArrow: 'hidden' }) },
];

const HOLD_MS = 4000;
const LAST_BEAT = TIMELINE[TIMELINE.length - 1]!.at;
const TOTAL_MS = LAST_BEAT + HOLD_MS;

// --- Reducer --------------------------------------------------------------

type Action =
  | { type: 'patch'; patch: (s: State) => State }
  | { type: 'tick' }
  | { type: 'reset' };

function advance(b: BubbleState, charsPerTick: number): BubbleState {
  if (b.kind === 'text' && b.typed < b.text.length) {
    return { ...b, typed: Math.min(b.typed + charsPerTick, b.text.length) };
  }
  return b;
}

function reducer(s: State, a: Action): State {
  if (a.type === 'patch') return a.patch(s);
  if (a.type === 'reset') return INITIAL;
  const cpt = 1;
  return {
    ...s,
    pm: advance(s.pm, cpt),
    laAck: advance(s.laAck, cpt),
    agentLeft: advance(s.agentLeft, cpt),
    laBubble: advance(s.laBubble, cpt),
    peerBubble: advance(s.peerBubble, cpt),
    pmReply: advance(s.pmReply, cpt),
  };
}

// --- Styles ---------------------------------------------------------------

const STYLES = `
  @keyframes cast-hero-pulse-dot {
    0%, 80%, 100% { opacity: 0.25; }
    40% { opacity: 1; }
  }
  .cast-hero-dot { animation: cast-hero-pulse-dot 1.3s ease-in-out infinite; }
  .cast-hero-dot-2 { animation-delay: 0.18s; }
  .cast-hero-dot-3 { animation-delay: 0.36s; }

  @keyframes cast-hero-bubble-in {
    from { opacity: 0; transform: translateY(8px) scale(0.97); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  .cast-hero-bubble { animation: cast-hero-bubble-in 240ms cubic-bezier(.2,.7,.3,1); }

  /* Larger rise — used when a bubble appears at the top of a freshly-mounted
     secondary chat, evoking the interthink dots "moving up" from the previous
     chat's bottom. */
  @keyframes cast-hero-bubble-rise {
    from { opacity: 0; transform: translateY(80px) scale(0.96); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  .cast-hero-bubble-rise { animation: cast-hero-bubble-rise 520ms cubic-bezier(.2,.7,.3,1); }

  @keyframes cast-hero-panel-in {
    from { opacity: 0; transform: translateX(20px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  .cast-hero-panel-in { animation: cast-hero-panel-in 380ms cubic-bezier(.2,.7,.3,1); }

  @keyframes cast-hero-peer-in {
    from { opacity: 0; transform: translateX(12px); }
    to   { opacity: 1; transform: translateX(0); }
  }
  .cast-hero-peer-enter { animation: cast-hero-peer-in 280ms ease-out; }

  @keyframes cast-hero-thinking-in {
    from { opacity: 0; transform: scale(0.8); }
    to   { opacity: 1; transform: scale(1); }
  }
  .cast-hero-thinking { animation: cast-hero-thinking-in 280ms ease-out; }

  @keyframes cast-hero-caret-blink {
    0%, 50% { opacity: 1; }
    50.01%, 100% { opacity: 0; }
  }
  .cast-hero-caret { animation: cast-hero-caret-blink 0.9s steps(1) infinite; display: inline-block; margin-left: 1px; }

  /* Flowing dash animation — dashoffset cycles to give the appearance of
     dashes moving along the line. Negative delta = move toward positive x
     (left to right). Positive = right to left. */
  @keyframes cast-hero-flow-ltr {
    from { stroke-dashoffset: 0; }
    to   { stroke-dashoffset: -16; }
  }
  @keyframes cast-hero-flow-rtl {
    from { stroke-dashoffset: 0; }
    to   { stroke-dashoffset: 16; }
  }
  .cast-hero-flow-ltr { animation: cast-hero-flow-ltr 0.6s linear infinite; }
  .cast-hero-flow-rtl { animation: cast-hero-flow-rtl 0.6s linear infinite; }

  /* Peer enters by arcing in from above (12 o'clock) around the launch-agent
     pivot. Outgoing peer arcs down/away (6 o'clock). Pivot = (AGENT_CX,
     NODE_CY) = (360, 56). Radius = PEER_CX - AGENT_CX = 165. The transform
     chain (translate to pivot → rotate → translate out by radius) is
     replicated verbatim in both keyframes so CSS only animates the rotation
     component. Note: PeerCentered renders centered at (0, 0). */
  @keyframes cast-hero-peer-arc-in {
    from { transform: translate(360px, 56px) rotate(-45deg) translate(165px, 0); opacity: 0; }
    to   { transform: translate(360px, 56px) rotate(0deg)   translate(165px, 0); opacity: 1; }
  }
  @keyframes cast-hero-peer-arc-out {
    from { transform: translate(360px, 56px) rotate(0deg)  translate(165px, 0); opacity: 1; }
    to   { transform: translate(360px, 56px) rotate(90deg) translate(165px, 0); opacity: 0; }
  }
  /* End-of-sequence exit: no arc, just fade out at the active position. */
  @keyframes cast-hero-peer-fade-out {
    from { transform: translate(525px, 56px); opacity: 1; }
    to   { transform: translate(525px, 56px); opacity: 0; }
  }
  .cast-hero-peer-arc-in   { animation: cast-hero-peer-arc-in   900ms cubic-bezier(.3,.1,.3,1) both; }
  .cast-hero-peer-arc-out  { animation: cast-hero-peer-arc-out  900ms cubic-bezier(.4,.1,.7,.4) both; }
  .cast-hero-peer-fade-out { animation: cast-hero-peer-fade-out 500ms ease-out both; }

  .cast-hero-frame {
    /* Chat fills the full frame. The frame is just a positioning context. */
    position: relative;
    aspect-ratio: 920 / 525;
    overflow: hidden;

    /* Always-dark, matching the screenshot-style mocks in Home.tsx
       (TRACK_DARK). The hero reads as a console screenshot regardless of
       site theme — it does not follow the page theme. */
    --cast-hero-frame-bg: #0a1028;
    background: var(--cast-hero-frame-bg);

    /* Agent-designer bubble borrows the "Design console" styling from the
       DualTracks mock below: a translucent sky tint with a bright sky
       outline and light text, not a solid fill. The colored peers/user keep
       their solid oklch fills with white text. */
    --cast-hero-agent-surface: #38bdf814;
    --cast-hero-agent-fg: #f9fafb;
    --cast-hero-agent-border: 1px solid #38bdf8;

    /* Panel delineation — the active panel lifts slightly lighter than the
       frame; the inactive (slid-out) panel darkens. Together they read as
       the same sheet with the active side clearly forward. */
    --cast-hero-active-bg: rgba(255, 255, 255, 0.06);
    --cast-hero-inactive-bg: rgba(0, 0, 0, 0.35);

    /* Light-on-dark text + accent, scoped to the frame so the rest of the
       page's tokens are untouched. */
    --fg: #e5e7eb;
    --fg-muted: #9ca3af;
    --fg-subtle: #6b7280;
    --accent: #38bdf8;
  }
  .cast-hero-chat-area {
    position: absolute;
    inset: 0;
    overflow: hidden;
  }
  /* Both panels stay a constant 65% wide and only translate — neither
     reflows. Closed: primary visible 0–65% (left), secondary visible
     65–100% (right 35%, dark bg, empty placeholder). Open: both panels
     translate left by 30% of frame; primary's left 30% goes off-screen
     (visible 0–35%, dark bg), secondary slides in fully (visible 35–100%,
     light bg). Symmetric — both translate, neither resizes. */
  .cast-hero-primary, .cast-hero-secondary {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 65%;
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
    /* Topo is gone — chat fills the frame, starting just below the
       loop-progress bar. */
    padding: 28px 24px 20px;
    gap: 14px;
    transition: transform 500ms cubic-bezier(.2,.7,.3,1),
                background 500ms cubic-bezier(.2,.7,.3,1);
  }
  .cast-hero-primary {
    left: 0;
    /* Active by default — lifted lighter than the frame. */
    background: var(--cast-hero-active-bg);
  }
  .cast-hero-secondary {
    left: 35%;
    background: var(--cast-hero-inactive-bg);
    /* Shifted right in closed state — only the right 35% of the 65%-wide
       panel is visible at the right edge of the frame. */
    transform: translateX(46.154%);
  }
  .cast-hero-frame.has-secondary .cast-hero-primary {
    transform: translateX(-46.154%);
    background: var(--cast-hero-inactive-bg);
  }
  .cast-hero-frame.has-secondary .cast-hero-secondary {
    transform: translateX(0);
    background: var(--cast-hero-active-bg);
  }

  /* Slid-out panel content fades to match the dimmed-avatar treatment in
     topology (0.5). The active panel's content stays at full opacity. The
     fade targets direct children (the ChatPanel / SecondaryPanel root) so
     it doesn't interfere with the panel's own translate transition. */
  .cast-hero-primary > *, .cast-hero-secondary > * {
    transition: opacity 500ms cubic-bezier(.2,.7,.3,1);
  }
  .cast-hero-secondary > * { opacity: 0.5; }
  .cast-hero-frame.has-secondary .cast-hero-primary > * { opacity: 0.5; }
  .cast-hero-frame.has-secondary .cast-hero-secondary > * { opacity: 1; }
`;

// --- Components -----------------------------------------------------------

function Dots() {
  // Dots inherit the bubble's text color via currentColor so they read on
  // both white-on-color bubbles and dark-on-grey (main-agent) bubbles.
  const dot = { width: 6, height: 6, borderRadius: '50%', background: 'currentColor' };
  return (
    <span style={{ display: 'inline-flex', gap: 5, alignItems: 'center', color: 'inherit', opacity: 0.85 }}>
      <span className="cast-hero-dot" style={dot} />
      <span className="cast-hero-dot cast-hero-dot-2" style={dot} />
      <span className="cast-hero-dot cast-hero-dot-3" style={dot} />
    </span>
  );
}

// --- Topology view --------------------------------------------------------

// Coordinates in viewBox space. ViewBox width matches the rendered frame
// width so avatar/text pixels in viewBox space ≈ pixels on screen — narrowing
// the container doesn't shrink the topology content.
// Viewbox is sized to the floating topo overlay (not the full frame).
// AGENT_CX sits at the horizontal centre; PM and peer flank symmetrically
// at a 165-unit spacing.
const TOPO_W = 720;
const TOPO_H = 128;
const PM_CX = 195;
const AGENT_CX = 360;
const PEER_CX = 525;
const NODE_CY = 56;
const HUMAN_R = 28;
const AGENT_SIZE = HUMAN_R * 2; // 56 — rounded square, same envelope as the user circle's diameter
const AGENT_HALF = AGENT_SIZE / 2;

// Initials shown inside an agent square. Take the first letter of each hyphen-/
// space-separated word, max 2 chars, lowercased. "launch-agent" → "la".
function agentInitials(label: string): string {
  const parts = label.split(/[-_\s]/).filter(Boolean);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return (parts[0][0]! + parts[1][0]!).toLowerCase();
  }
  return label.slice(0, 2).toLowerCase();
}

// Topology avatars embed the same HTML/CSS avatar used in chat headers via
// foreignObject — gives real flexbox centering instead of fighting SVG
// baseline math.
const AGENT_RX = 12;

// HTML avatar block, intended for embedding inside an SVG foreignObject. Same
// styling vocabulary as the chat SimpleAvatar (HTML flexbox centering, real
// font metrics — no SVG baseline guesswork).
function TopoAvatarHtml({ peer, size, highlight }: { peer: PeerHeader; size: number; highlight?: boolean }) {
  const isAgent = peer.kind === 'agent';
  const tone = peerTone(peer);
  const badgeSize = Math.round(size * 0.4);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: isAgent ? AGENT_RX : '50%',
        background: tone.avatarBg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        // Outer ring matching the arrow color, drawn when an active arrow
        // points at this avatar. Spread transitions from 0 → 3 so the ring
        // fades in rather than snapping.
        boxShadow: highlight ? '0 0 0 3px var(--accent)' : '0 0 0 0 var(--accent)',
        transition: 'box-shadow 240ms cubic-bezier(.2,.7,.3,1)',
      }}
    >
      <TwImg name={peerEmoji(peer)} size={Math.round(size * 0.7)} />
      {peer.secure && (
        <div
          style={{
            position: 'absolute',
            right: -Math.round(badgeSize * 0.25),
            bottom: -Math.round(badgeSize * 0.25),
            width: badgeSize,
            height: badgeSize,
            borderRadius: '50%',
            background: 'var(--bg)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <TwImg name="lock" size={Math.round(badgeSize * 0.65)} />
        </div>
      )}
    </div>
  );
}

function TopoLabelHtml({ peer }: { peer: PeerHeader }) {
  if (!peer.label) return null;
  const isAgent = peer.kind === 'agent';
  return (
    <div
      style={{
        marginTop: 6,
        fontSize: 13,
        fontFamily: isAgent ? 'JetBrains Mono, monospace' : 'Inter, sans-serif',
        fontWeight: 600,
        color: 'var(--fg)',
        textAlign: 'center',
        whiteSpace: 'nowrap',
      }}
    >
      {isAgent ? `[${peer.label}]` : peer.label}
    </div>
  );
}

// Wraps the HTML avatar + label in a foreignObject so it lives at the right SVG
// coords. fo width is wider than the avatar so labels can overflow horizontally
// without clipping.
// 4px vertical buffer above the avatar so the highlight ring's 2px outer
// box-shadow (+ a touch of safety margin) isn't clipped by the
// foreignObject's top edge. Pushed back via paddingTop on the inner flex
// container so the avatar stays visually centered at `cy`.
const AVATAR_FO_PAD = 4;
function TopoNodeFO({ cx, cy, peer, size, highlight }: { cx: number; cy: number; peer: PeerHeader; size: number; highlight?: boolean }) {
  const foW = 240;
  const foH = 96;
  return (
    <foreignObject x={cx - foW / 2} y={cy - size / 2 - AVATAR_FO_PAD} width={foW} height={foH + AVATAR_FO_PAD}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: AVATAR_FO_PAD }}>
        <TopoAvatarHtml peer={peer} size={size} highlight={highlight} />
        <TopoLabelHtml peer={peer} />
      </div>
    </foreignObject>
  );
}

// Used by the arc-in/arc-out keyframes (peer rendered centered at SVG 0,0).
function PeerCentered({ peer, showLabel, highlight }: { peer: PeerHeader; showLabel: boolean; highlight?: boolean }) {
  const size = AGENT_SIZE;
  return (
    <foreignObject x={-120} y={-size / 2 - AVATAR_FO_PAD} width={240} height={96 + AVATAR_FO_PAD}>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: AVATAR_FO_PAD }}>
        <TopoAvatarHtml peer={peer} size={size} highlight={highlight} />
        {showLabel && <TopoLabelHtml peer={peer} />}
      </div>
    </foreignObject>
  );
}

// Peer + the connector to the launch-agent, rendered together in the peer's
// local frame so the connector rotates/translates with the peer during arc
// transitions. When `arrow` is hidden, the connector is a static dim line at
// 30% opacity; when it's set, the connector is the flowing-dash arrow in the
// same place. The buffer is sized so the visible connector is ~15% shorter
// than the full edge-to-edge span (gives the avatars more breathing room).
const PEER_LINE_BUFFER = 15;
const PEER_LINE_X1 = -((PEER_CX - AGENT_CX) - AGENT_HALF - PEER_LINE_BUFFER); // agent's right edge in peer-local
const PEER_LINE_X2 = -(AGENT_HALF + PEER_LINE_BUFFER);                        // peer's left edge in peer-local
function PeerWithConnector({ peer, showLabel, arrow, highlight }: { peer: PeerHeader; showLabel: boolean; arrow: ArrowState; highlight?: boolean }) {
  return (
    <g>
      {arrow === 'hidden' ? (
        <line
          x1={PEER_LINE_X1}
          y1={0}
          x2={PEER_LINE_X2}
          y2={0}
          stroke="var(--accent)"
          stroke-width="2"
          stroke-dasharray="6 6"
          opacity={0.5}
        />
      ) : (
        <FlowingArrow x1={PEER_LINE_X1} x2={PEER_LINE_X2} y={0} dir={arrow} />
      )}
      <PeerCentered peer={peer} showLabel={showLabel} highlight={highlight} />
    </g>
  );
}

// Static connecting line between two topology nodes. Visible whenever no
// directional arrow is active on that edge — communicates "channel exists"
// passively, so the topology never has a blank stretch between avatars.
function BaseLine({ x1, x2, y }: { x1: number; x2: number; y: number }) {
  return (
    <line
      x1={x1}
      y1={y}
      x2={x2}
      y2={y}
      stroke="var(--accent)"
      stroke-width="2"
      stroke-dasharray="6 6"
      opacity={0.5}
    />
  );
}

function FlowingArrow({
  x1, x2, y, dir,
}: { x1: number; x2: number; y: number; dir: 'right' | 'left' }) {
  // Static arrow — solid line + arrowhead at the destination end.
  const tipX = dir === 'right' ? x2 : x1;
  const baseX = dir === 'right' ? x2 - 12 : x1 + 12;
  const headPts = `${tipX},${y} ${baseX},${y - 6} ${baseX},${y + 6}`;
  return (
    <g>
      <line
        x1={x1}
        y1={y}
        x2={x2}
        y2={y}
        stroke="var(--accent)"
        stroke-width="2"
      />
      <polygon points={headPts} fill="var(--accent)" />
    </g>
  );
}

// Shared arrow-endpoint computation. PM↔agent and agent↔peer are the same
// center-to-center distance (PEER_CX - AGENT_CX == AGENT_CX - PM_CX) and the
// nodes have equal radii, so both edges use the same buffer — visible length
// stays equal and the layout reads symmetric.
function topoEdges(peer: PeerHeader | null) {
  const agentLeftEdge = AGENT_CX - AGENT_HALF;
  const agentRightEdge = AGENT_CX + AGENT_HALF;
  const pmRightEdge = PM_CX + HUMAN_R;
  const peerLeftEdge = PEER_CX - (peer?.kind === 'agent' ? AGENT_HALF : HUMAN_R);
  const BUFFER = 15;
  return {
    pmArrowX1: pmRightEdge + BUFFER,
    pmArrowX2: agentLeftEdge - BUFFER,
    peerArrowX1: agentRightEdge + BUFFER,
    peerArrowX2: peerLeftEdge - BUFFER,
  };
}

// Soft, desaturated, blurred ghost avatars on the left and right periphery
// of the topo box — some clipped by the box edges — to signal "this is a
// viewport into a larger topology". Same shape vocabulary as the active
// avatars (circles for humans, rounded squares for agents) but filled
// with a neutral grey and the emoji greyscaled + blurred, so they read as
// "more of the same kind of entities, out of focus". Sized at ~65-75% of
// active avatar (56 → ~36-42).
type GhostFace = 'male' | 'female' | 'robot';
const GHOSTS: Array<{ cx: number; cy: number; face: GhostFace; size: number }> = [
  { cx: 5,   cy: 32,  face: 'female', size: 48 }, // clipped at left
  { cx: 55,  cy: 98,  face: 'robot',  size: 46 },
  { cx: 125, cy: 24,  face: 'male',   size: 40 },
  { cx: 605, cy: 26,  face: 'female', size: 40 },
  { cx: 660, cy: 100, face: 'robot',  size: 46 },
  { cx: 725, cy: 34,  face: 'male',   size: 50 }, // clipped at right
];
// Two faint connector lines between ghost pairs (left-side and right-side),
// each pairing a human with an agent — mirrors the active topology and
// suggests the wider fleet has its own channels open. Endpoints are
// pulled in beyond each ghost's radius so the line never touches the
// silhouettes.
const GHOST_EDGES: Array<{ a: number; b: number }> = [
  { a: 0, b: 1 }, // leftmost pair: female (5,32) ↔ robot (55,98)
  { a: 1, b: 2 }, // left: robot (55,98) ↔ male (125,24)
  { a: 3, b: 4 }, // right: female (605,26) ↔ robot (660,100)
  { a: 4, b: 5 }, // rightmost pair: robot (660,100) ↔ male (725,34)
];
// Ghost lines run center-to-center. They render before the avatars, which
// paint over the middle of each segment with the blurred grey shape, so the
// visible part is naturally the edge-to-edge run with no extra trim needed.
function ghostEdge(a: (typeof GHOSTS)[number], b: (typeof GHOSTS)[number]) {
  return { x1: a.cx, y1: a.cy, x2: b.cx, y2: b.cy };
}
function GhostBackdrop() {
  // Group opacity (one value on the outer <g>) instead of per-element. Inside
  // the group, lines and avatars are fully opaque and share the same colour,
  // so where an avatar paints over a line the overlap is invisible. The whole
  // composited group then drops to 0.25 in one step.
  return (
    <g aria-hidden="true" style={{ opacity: 0.35 }}>
      <g
        style={{ filter: 'blur(2.2px)' }}
        stroke="var(--cast-hero-ghost-bg)"
        stroke-width="3"
        fill="none"
      >
        {GHOST_EDGES.map((e, i) => {
          const seg = ghostEdge(GHOSTS[e.a]!, GHOSTS[e.b]!);
          return <line key={i} {...seg} />;
        })}
      </g>
      {GHOSTS.map((g, i) => {
        const isAgent = g.face === 'robot';
        return (
          <foreignObject
            key={i}
            x={g.cx - g.size / 2}
            y={g.cy - g.size / 2}
            width={g.size}
            height={g.size}
          >
            <div
              style={{
                width: g.size,
                height: g.size,
                borderRadius: isAgent ? Math.round(g.size * 0.21) : '50%',
                background: 'var(--cast-hero-ghost-bg)',
                filter: 'blur(1.5px)',
              }}
            />
          </foreignObject>
        );
      })}
    </g>
  );
}

// Variant A — carousel: previous peer slides out left as the next slides in from right.
function TopologyCarousel({ state }: { state: State }) {
  const e = topoEdges(state.peer);

  // Track the most recently active peer so we can render it briefly as "exiting"
  // when state.peer changes. A swap to a different peer uses the arc-out (so it
  // sweeps away to make room for the next arc-in); a swap to null uses the
  // fade-out (the sequence is over, no replacement to make way for).
  const [exiting, setExiting] = useState<{ peer: PeerHeader; mode: 'arc' | 'fade' } | null>(null);
  const lastPeerRef = useRef<PeerHeader | null>(null);

  useEffect(() => {
    const prev = lastPeerRef.current;
    const curLabel = state.peer?.label ?? null;
    const prevLabel = prev?.label ?? null;
    lastPeerRef.current = state.peer;
    if (prevLabel !== curLabel && prev) {
      const mode: 'arc' | 'fade' = curLabel === null ? 'fade' : 'arc';
      setExiting({ peer: prev, mode });
      const ttl = mode === 'fade' ? 520 : 900;
      const t = window.setTimeout(() => setExiting(null), ttl);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [state.peer?.label]);

  // Highlight an avatar with an accent ring whenever an active arrow points
  // AT it. The agent is the target of inbound traffic from either Mark
  // (pmArrow=right) or the current peer (peerArrow=left).
  const markHL  = state.pmArrow === 'left';
  const agentHL = state.pmArrow === 'right' || state.peerArrow === 'left';
  const peerHL  = state.peerArrow === 'right';

  return (
    <svg viewBox={`0 0 ${TOPO_W} ${TOPO_H}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
      <GhostBackdrop />
      {/* Mark fades to 80% while the agent is consulting peers — the focus
          is on the peer conversation, not on Mark waiting. */}
      <g style={{
        opacity: state.secondaryOpen ? 0.6 : 1,
        transition: 'opacity 500ms cubic-bezier(.2,.7,.3,1)',
      }}>
        <TopoNodeFO cx={PM_CX} cy={NODE_CY} peer={USER_HDR} size={AGENT_SIZE} highlight={markHL} />
      </g>
      <TopoNodeFO cx={AGENT_CX} cy={NODE_CY} peer={DM} size={AGENT_SIZE} highlight={agentHL} />

      {/* PM ↔ launch-agent connector. Static edge; never rotates. */}
      {state.pmArrow === 'hidden' ? (
        <BaseLine x1={e.pmArrowX1} x2={e.pmArrowX2} y={NODE_CY} />
      ) : (
        <FlowingArrow x1={e.pmArrowX1} x2={e.pmArrowX2} y={NODE_CY} dir={state.pmArrow} />
      )}

      {/* launch-agent ↔ peer connector lives inside each peer's animated
          group so the line/arrow rotates with the peer during arc-in and
          arc-out. The exiting peer carries its own connector out; the
          entering peer carries one in. */}
      {exiting && (
        <g
          key={exiting.peer.label + '-exit'}
          className={exiting.mode === 'fade' ? 'cast-hero-peer-fade-out' : 'cast-hero-peer-arc-out'}
        >
          <PeerWithConnector peer={exiting.peer} showLabel={true} arrow="hidden" />
        </g>
      )}
      {state.peer && (
        <g key={state.peer.label + '-enter'} className="cast-hero-peer-arc-in">
          {/* Mirror of Mark's fade: when the secondary panel closes after the
              last consultation, the peer stays in topology but dims out — the
              focus shifts back to the LA → Mark synthesis. */}
          <g style={{
            opacity: state.secondaryOpen ? 1 : 0.6,
            transition: 'opacity 500ms cubic-bezier(.2,.7,.3,1)',
          }}>
            <PeerWithConnector peer={state.peer} showLabel={true} arrow={state.peerArrow} highlight={peerHL} />
          </g>
        </g>
      )}
    </svg>
  );
}

// --- Chat panel components ------------------------------------------------

function SimpleAvatar({ partner, size = 26 }: { partner: PeerHeader; size?: number }) {
  const isAgent = partner.kind === 'agent';
  const tone = peerTone(partner);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: isAgent ? 6 : '50%',
        background: tone.avatarBg,
        color: tone.avatarFg,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 700,
        fontSize: Math.round(size * 0.42),
        fontFamily: isAgent ? 'JetBrains Mono, monospace' : 'Inter, sans-serif',
        flexShrink: 0,
      }}
    >
      {isAgent ? agentInitials(partner.label) : (partner.initials || partner.label.slice(0, 2))}
    </div>
  );
}

function ChatHeader({ left, right }: { left: PeerHeader; right: PeerHeader }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <SimpleAvatar partner={left} />
        <PartnerLabel partner={left} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <PartnerLabel partner={right} />
        <SimpleAvatar partner={right} />
      </div>
    </div>
  );
}

function PartnerLabel({ partner }: { partner: PeerHeader }) {
  if (!partner.label) return null;
  if (partner.kind === 'agent') {
    return (
      <span style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600, fontSize: 13, color: 'var(--fg)' }}>
        [{partner.label}]
      </span>
    );
  }
  return (
    <span style={{ fontFamily: 'Inter, sans-serif', fontWeight: 500, fontSize: 13, color: 'var(--fg)' }}>
      {partner.label}
    </span>
  );
}

// Per-bubble-group name label. Sits above the first bubble in a run of
// consecutive same-speaker bubbles. No avatar (intentional, for now).
function BubbleLabel({ speaker, alignSelf }: { speaker: PeerHeader; alignSelf: 'flex-start' | 'flex-end' }) {
  const isAgent = speaker.kind === 'agent';
  return (
    <div
      style={{
        alignSelf,
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        fontFamily: isAgent ? 'JetBrains Mono, monospace' : 'Inter, sans-serif',
        fontWeight: 600,
        color: 'var(--fg-muted)',
        letterSpacing: '0.02em',
        padding: '0 8px',
      }}
    >
      <TwImg name={peerEmoji(speaker)} size={14} />
      <span>{isAgent ? `[${speaker.label}]` : speaker.label}</span>
    </div>
  );
}

// Renders a column of bubbles. A speaker label appears above the first bubble
// in any run of consecutive bubbles from the same speaker (hidden bubbles are
// skipped before determining "consecutive"). Each item is wrapped in a div
// with data-bubble-key so callers (e.g. the secondary-panel scroller) can
// locate a specific item's DOM node.
function ChatPanel({ items }: { items: ChatItem[] }) {
  const visible = items.filter((i) => i.bubble.kind !== 'hidden');
  // 2px horizontal padding so the bubble outlines (the 1px borders) aren't
  // shaved by a panel's overflow:hidden clip when a bubble aligns flush to the
  // edge (the right-side secondary panel especially).
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '0 2px' }}>
      {visible.map((item, i) => {
        const prev = visible[i - 1];
        const showLabel = !prev || prev.speaker.label !== item.speaker.label;
        const alignItems = item.alignSelf === 'flex-end' ? 'flex-end' : 'flex-start';
        return (
          <div
            key={item.key}
            data-bubble-key={item.key}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems,
              gap: 2,
              marginTop: showLabel && i > 0 ? 10 : 0,
            }}
          >
            {showLabel && <BubbleLabel speaker={item.speaker} alignSelf={item.alignSelf} />}
            <Bubble b={item.bubble} alignSelf={item.alignSelf} tone={peerTone(item.speaker)} noAnim={item.noAnim} />
          </div>
        );
      })}
    </div>
  );
}

// Splits bubble text into Inter-prose and JetBrains-Mono agent-name segments.
// Any [bracketed-name] in the text — including a partially-typed `[hyp` — is
// flipped to mono on the fly so the agent-name treatment matches topology
// labels exactly. Robust to partial typing: open-bracket without a close yet
// still flips, so the name types in mono from the moment the `[` appears.
function renderBubbleSegments(text: string) {
  const out: Array<{ key: string; text: string; mono: boolean }> = [];
  const re = /\[[a-z][a-z0-9-]*\]?/g;
  let lastIndex = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index!;
    if (idx > lastIndex) {
      out.push({ key: `p${i++}`, text: text.slice(lastIndex, idx), mono: false });
    }
    out.push({ key: `m${i++}`, text: m[0], mono: true });
    lastIndex = idx + m[0].length;
  }
  if (lastIndex < text.length) {
    out.push({ key: `p${i++}`, text: text.slice(lastIndex), mono: false });
  }
  return out.map((s) =>
    s.mono ? (
      <span key={s.key} style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.9em' }}>
        {s.text}
      </span>
    ) : (
      <span key={s.key}>{s.text}</span>
    )
  );
}

function Bubble({
  b,
  alignSelf,
  tone,
  risen,
  noAnim,
}: {
  b: BubbleState;
  alignSelf: 'flex-start' | 'flex-end';
  tone: PeerTone;
  risen?: boolean;
  noAnim?: boolean;
}) {
  if (b.kind === 'hidden') return null;
  const baseRadius = '18px';
  const sharperCorner = '5px';
  const radius =
    alignSelf === 'flex-end'
      ? `${baseRadius} ${baseRadius} ${sharperCorner} ${baseRadius}`
      : `${baseRadius} ${baseRadius} ${baseRadius} ${sharperCorner}`;
  const cls = noAnim ? '' : risen ? 'cast-hero-bubble-rise' : 'cast-hero-bubble';
  return (
    <div
      className={cls}
      style={{
        alignSelf,
        maxWidth: '70%',
        padding: '11px 16px',
        background: tone.bubbleBg,
        color: tone.bubbleFg,
        border: tone.bubbleBorder,
        borderRadius: radius,
        fontSize: 14,
        lineHeight: 1.45,
        fontFamily: 'Inter, sans-serif',
        minHeight: 20,
        // Honour \n in bubble text so DM can use bulleted lines without
        // needing per-line bubbles. Multiple spaces still collapse.
        whiteSpace: 'pre-line',
      }}
    >
      {b.kind === 'dots' && <Dots />}
      {b.kind === 'text' && (
        <span>
          {renderBubbleSegments(b.text.slice(0, b.typed))}
          {b.typed < b.text.length && <span className="cast-hero-caret" style={{ opacity: 0.6 }}>▎</span>}
        </span>
      )}
      {b.kind === 'emoji' && <TwImg name={b.name} size={22} />}
    </div>
  );
}

// Secondary chat panel. Renders the entire history of LA's peer
// consultations (flushed prior Q+R blocks + the active laBubble / peerBubble)
// in a fixed-height clipping container. When history grows (a Q+R block was
// just flushed), the inner content is translated upward so the active LA
// bubble (cur-la — which morphs in place from dots to the next question's
// text) anchors at the top of the visible area. Older content scrolls out of
// view above.
// Primary chat panel — Mark ↔ agent-designer. With the topo removed there's
// room for the whole exchange, so it renders top-anchored with no upward
// scroll: Mark's question, the designer's plan, the synthesis, and the
// thumbs-up all stay in place.
function PrimaryPanel({ state }: { state: State }) {
  const items: ChatItem[] = [
    { key: 'pm', speaker: USER_HDR, bubble: state.pm, alignSelf: 'flex-start' },
    { key: 'laAck', speaker: DM, bubble: state.laAck, alignSelf: 'flex-end' },
    { key: 'agentLeft', speaker: DM, bubble: state.agentLeft, alignSelf: 'flex-end' },
    { key: 'pmReply', speaker: USER_HDR, bubble: state.pmReply, alignSelf: 'flex-start' },
  ];

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ChatPanel items={items} />
    </div>
  );
}

function SecondaryPanel({ state }: { state: State }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scrollY, setScrollY] = useState(0);
  const lastBoundaryRef = useRef<string | null>(null);

  const items: ChatItem[] = [...state.secondaryHistory];
  // cur-la is the LA bubble that morphs in place across consultations (dots
  // ↔ question text). Its key is stable so React preserves the DOM node.
  // cur-la renders independent of `peer` so the final bridge dots stay
  // visible after the peer node has left the topology.
  if (state.laBubble.kind !== 'hidden') {
    items.push({ key: 'cur-la', speaker: DM, bubble: state.laBubble, alignSelf: 'flex-start' });
  }
  if (state.peer && state.peerBubble.kind !== 'hidden') {
    items.push({ key: 'cur-peer', speaker: state.peer, bubble: state.peerBubble, alignSelf: 'flex-end' });
  }

  useEffect(() => {
    // After history grows, scroll the inner content so cur-la (the active LA
    // bubble) sits at the top of the visible area.
    if (state.secondaryHistory.length === 0) {
      lastBoundaryRef.current = null;
      setScrollY(0);
      return;
    }
    const lastKey = state.secondaryHistory[state.secondaryHistory.length - 1]!.key;
    if (lastKey === lastBoundaryRef.current) return;
    lastBoundaryRef.current = lastKey;

    requestAnimationFrame(() => {
      const container = containerRef.current;
      const inner = innerRef.current;
      if (!container || !inner) return;
      const el = inner.querySelector('[data-bubble-key="cur-la"]') as HTMLElement | null;
      if (!el) return;
      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const delta = elRect.top - containerRect.top;
      setScrollY((prev) => prev + delta);
    });
  }, [state.secondaryHistory.length]);

  return (
    <div
      className="cast-hero-panel-in"
      style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}
    >
      <div
        ref={containerRef}
        style={{ flex: 1, overflow: 'hidden', position: 'relative', minHeight: 0 }}
      >
        <div
          ref={innerRef}
          style={{
            transform: `translateY(${-scrollY}px)`,
            transition: 'transform 700ms cubic-bezier(.2,.7,.3,1)',
            willChange: 'transform',
          }}
        >
          <ChatPanel items={items} />
        </div>
      </div>
    </div>
  );
}

// --- Main animated diagram ------------------------------------------------

function AnimatedDiagram({ runKey }: { runKey: number }) {
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

  return (
    <div className={`cast-hero-frame${state.secondaryOpen ? ' has-secondary' : ''}`}>
      {/* Chat surface — full frame. Primary + secondary panels translate
          horizontally inside it. */}
      <div className="cast-hero-chat-area">
        <div className="cast-hero-primary">
          <PrimaryPanel state={state} />
        </div>

        <div className="cast-hero-secondary">
          {/* Always render — the watcher Q+A persists in the shrunk-back
              right panel after secondaryOpen flips false, mirroring how
              Mark's primary conversation persists during consultation. */}
          <SecondaryPanel state={state} />
        </div>
      </div>
    </div>
  );
}

export function HeroDiagram() {
  const [runKey, setRunKey] = useState(0);

  useEffect(() => {
    const t = window.setTimeout(() => setRunKey((k) => k + 1), TOTAL_MS);
    return () => window.clearTimeout(t);
  }, [runKey]);

  return (
    <>
      <style>{STYLES}</style>
      <AnimatedDiagram key={runKey} runKey={runKey} />
    </>
  );
}
