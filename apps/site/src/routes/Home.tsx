import type { ComponentChildren } from 'preact';
import { CastLogo } from '../components/brand/CastLogo';
import { Github } from '../components/brand/Icon';
import { CopyButton } from '../components/ui/CopyButton';
import { AgentFolder } from '../components/site/AgentFolder';
import { VisioDiagram } from '../components/site/VisioDiagram';
import { TurboPascalBlock } from '../components/site/TurboPascalBlock';
import { HeroTabs } from '../components/site/HeroTabs';
import { WhoGetsIn } from '../components/site/WhoGetsIn';
import { ConsoleAvatar } from '../components/docs/consoleTheme';

interface FaqItem {
  q: string;
  a: ComponentChildren;
}

const faqs: FaqItem[] = [
  {
    q: 'Why this and not ChatGPT or Claude.ai?',
    a: (
      <>
        Different category. ChatGPT is one chat with one assistant. Cast is a fleet of agents that
        live on your machine, run on schedules, talk to your stuff, and ship with multi-user
        identity built in. Not better or worse, just a different shape.
      </>
    ),
  },
  {
    q: 'Do I have to use the dashboard to build agents?',
    a: (
      <>
        No. The dashboard is one way. The agent is plain files in a folder. Write them with any
        editor, generate them with Claude Code, fork a template, or use any tool that produces a
        folder. Cast runs the folder. How it gets built is your choice.
      </>
    ),
  },
  {
    q: 'How is this different from Hermes?',
    a: (
      <>
        You can replicate the core Hermes pattern on Cast: single agent on your server, persistent
        memory, agent-authored skills, multi-transport gateway (Telegram, Discord, Slack, WhatsApp,
        etc.). Cast adds the layers Hermes doesn't ship: multi-user identity from the routing layer
        up, multi-agent coordination with declared ACL between agents, runtime-enforced scope.
        Hermes's self-improving skill loop ships as a default. On Cast you wire that pattern
        yourself. Different theses: Hermes is the personal agent that grows. Cast is the harness
        underneath that lets you start there and scale into a system multiple people use.
      </>
    ),
  },
  {
    q: 'How is this different from Anthropic Managed Agents?',
    a: (
      <>
        <p style={{ margin: '0 0 12px' }}>
          Both are built on the Claude Agent SDK, the same engine underneath. The difference is the
          harness wrapped around it, and where it runs.
        </p>
        <p style={{ margin: '0 0 12px' }}>
          Managed Agents is Anthropic's harness on Anthropic's infrastructure: $0.08/session-hour
          on top of API costs, Claude-only, single-cloud, no end-user identity routing, no
          Telegram/Discord/Slack transports. You can't move it off Anthropic's stack.
        </p>
        <p style={{ margin: '0 0 12px' }}>
          Cast is a different harness running on your machine: multi-user from the routing layer,
          conversation lifecycle, channels with per-channel tool surfaces, scheduling, multiple
          transports, MIT licensed, no platform fee on top of API costs.
        </p>
        <p style={{ margin: 0 }}>Same engine. Different opinion about what the harness should do, and who runs it.</p>
      </>
    ),
  },
  {
    q: 'Where does my data go?',
    a: (
      <>
        On your own hard drive, or wherever you choose to host. The agent is files you can copy
        and take with you, no proprietary format. Anthropic sees whatever your agent sends to
        Claude, and nothing else.
      </>
    ),
  },
  {
    q: 'Is this safe? Can the agent do something weird?',
    a: (
      <>
        Each agent runs in a sandbox with explicit, declared boundaries. It can only read the
        files you mounted, reach the network addresses you allowed, and write to the directories
        you opened. If you didn't declare it, the agent has no path to it. This isn't a permission
        dialog. It's the boundary the harness enforces. You decide what's allowed. The agent has
        nothing to argue with.
      </>
    ),
  },
  {
    q: 'How well does this actually work?',
    a: (
      <>
        Pretty well in our tests, and it gets better the more you learn the harness. The harness
        itself is solid: containment, routing, identity, and ACL all behave the way they say. The
        variability lives in the agent layer, in how the model handles your specific task and what
        shape of prompt works best. We're still iterating on the agent-builder instructions to make
        "good" easier to reach. The in-browser build consoles are an early preview in that same
        spirit, and when one stumbles, every agent is plain files you can edit by hand or hand to
        Claude Code, so you're never stuck. Floor is decent. Like everyone in this category right
        now, we're still learning what works.
      </>
    ),
  },
  {
    q: 'How much does it cost?',
    a: (
      <>
        Cast itself is free (MIT license). You bring your own Anthropic API key. Claude is the
        only model Cast supports today, charged per use. On June 15, 2026 Anthropic is splitting
        subscription limits for programmatic agent use: interactive tools keep their flat-rate
        pool, headless agent use gets separate credits at API rates. Cast's self-hosted
        architecture means no session-hour platform fee on top of your API spend.
      </>
    ),
  },
  {
    q: "What if Anthropic changes pricing or the API I'm using?",
    a: (
      <>
        Honest answer: in the current version Cast only supports Anthropic's Claude. If Anthropic
        changes pricing significantly, you're exposed in the short term. The architecture doesn't
        tie you to one provider long-term. The model is a configurable endpoint, and support for
        other providers and on-device LLMs is on the roadmap. Until those ship, you're betting on
        Claude.
      </>
    ),
  },
];

function Faq() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {faqs.map((item, i) => (
        <div
          key={i}
          style={{
            paddingBottom: 24,
            borderBottom: i === faqs.length - 1 ? 'none' : '1px solid var(--border)',
          }}
        >
          <h3 style={{ fontSize: 18, margin: '0 0 8px', fontWeight: 600, color: 'var(--fg)' }}>
            {item.q}
          </h3>
          <div style={{ fontSize: 15, lineHeight: 1.65, color: 'var(--fg-muted)' }}>{item.a}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * Always-dark palette for the two "screenshot of the tool" mocks in
 * DualTracksDiagram. Mirrors dashboardMocks.tsx DARK so both surfaces read
 * as "screenshot" regardless of site theme.
 */
const TRACK_DARK = {
  shellBg: '#0a1028',
  panelBg: '#111827',
  panelBorder: '#1f2937',
  inputBg: '#030712',
  inputBorder: '#374151',
  textPrimary: '#f9fafb',
  textSecondary: '#d1d5db',
  textMuted: '#6b7280',
  textDim: '#4b5563',
  termGreen: '#22c55e',
  termPink: '#ec4899',
  termAmber: '#f59e0b',
  termSlate: '#9ca3af',
} as const;

function TrafficLight({ lit }: { lit: 'amber' | 'green' }) {
  // Pixel-art traffic light. 10×24 sub-pixel grid rendered at 4× → 40×96 px.
  // Three bulbs (4×4 each) stacked with chunky 1-px black outlines, white
  // highlight pixel inside the lit one, pink y2k offset shadow on the whole
  // thing to echo the on-disk block below.
  const litIdx = lit === 'amber' ? 1 : 2;
  const bulbY = [3, 10, 17];
  const onColors = ['#ef4444', '#fbbf24', '#22c55e'];
  const dimColors = ['#5a1010', '#5a3a10', '#0e3a1c'];
  return (
    <svg
      width="40"
      height="96"
      viewBox="0 0 10 24"
      aria-hidden="true"
      shape-rendering="crispEdges"
      style={{
        flexShrink: 0,
        display: 'block',
        filter: 'drop-shadow(3px 3px 0 var(--y2k-pink))',
      }}
    >
      <rect x="0" y="0" width="10" height="24" fill="#000" />
      <rect x="1" y="1" width="8" height="22" fill="#1a1a1a" />
      {bulbY.map((y, i) => {
        const isLit = i === litIdx;
        return (
          <g key={i}>
            <rect x="2" y={y - 1} width="6" height="6" fill="#000" />
            <rect
              x="3"
              y={y}
              width="4"
              height="4"
              fill={isLit ? onColors[i] : dimColors[i]}
            />
            {isLit && (
              <rect x="3" y={y} width="2" height="2" fill="#ffffff" opacity="0.55" />
            )}
          </g>
        );
      })}
    </svg>
  );
}

function PanelShell({ children }: { children: ComponentChildren }) {
  return (
    <div
      style={{
        border: `1px solid ${TRACK_DARK.panelBorder}`,
        borderRadius: 8,
        overflow: 'hidden',
        background: '#000',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {children}
    </div>
  );
}

function ConsolePromptBubble({ kind, text }: { kind: 'design' | 'configure'; text: string }) {
  // Console side of the exchange: the ConsoleAvatar glyph + the console name
  // (no pill), above a white message bubble outlined in the console's hue.
  // Sky/amber are the dark-surface variants of the console hues.
  const accent = kind === 'design' ? '#38BDF8' : '#FBBF24';
  const name = kind === 'design' ? 'Design' : 'Configure';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <ConsoleAvatar kind={kind} size={34} />
        <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: '-0.01em', color: accent }}>
          {name}
        </span>
      </div>
      <div
        style={{
          maxWidth: '88%',
          background: `${accent}14`,
          border: `1px solid ${accent}`,
          color: TRACK_DARK.textPrimary,
          padding: '11px 15px',
          borderRadius: '14px 14px 14px 4px',
          fontSize: 16,
          lineHeight: 1.5,
        }}
      >
        {text}
      </div>
    </div>
  );
}

function UserReplyBubble({ text }: { text: string }) {
  // The operator's reply to the console prompt — right-aligned teal bubble,
  // matching ChatMockup's UserBubble.
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
      <div
        style={{
          maxWidth: '84%',
          background: '#115E59',
          color: '#F3F4F6',
          padding: '10px 14px',
          borderRadius: '14px 14px 4px 14px',
          fontSize: 14,
          lineHeight: 1.5,
        }}
      >
        {text}
      </div>
    </div>
  );
}

function ChatConsoleMock() {
  return (
    <PanelShell>
      <div
        style={{
          background: TRACK_DARK.panelBg,
          flex: 1,
          padding: '22px 22px',
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ConsolePromptBubble kind="design" text="What would you like to build today?" />
          <UserReplyBubble text="Build me a team that tracks whether the AI boom is real or just hype." />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <ConsolePromptBubble kind="configure" text="What do you need configured?" />
          <UserReplyBubble text="Whitelist techcrunch.com and sec.gov, run it on Sonnet, and use Opus for the deep analysis." />
        </div>
      </div>
      <a
        href="/docs/quickstart"
        style={{
          padding: '12px 18px',
          borderTop: `1px solid ${TRACK_DARK.panelBorder}`,
          fontSize: 13,
          fontWeight: 600,
          color: '#7DD3FC',
          background: '#000',
          textDecoration: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span>Read the quickstart</span>
        <span>→</span>
      </a>
    </PanelShell>
  );
}

function ClaudeMark({ pixel = 6, color }: { pixel?: number; color: string }) {
  // Faithful silhouette of the Claude Code CLI banner:
  //   ▐▛███▜▌
  //   ▝▜█████▛▘
  //     ▘▘ ▝▝
  // Each Unicode block char encodes two vertical quadrants, so the cell
  // aspect is 1:2 (width:height). viewBox is 18 × 10 grid units; the
  // body silhouette + two eye holes + four bottom pixels are a single
  // path with evenodd fill — no inter-rect seams, no font drift.
  const d = [
    // body outline (the widest row bulges out at y=4..6)
    'M3 0H15V4H17V6H15V8H3V6H1V4H3Z',
    // eye holes (subtracted via evenodd)
    'M5 2H6V4H5Z',
    'M12 2H13V4H12Z',
    // four bottom pixels
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

function ClaudeCodeMock() {
  const headerMeta = [
    <>
      Claude Code <span style={{ color: TRACK_DARK.textPrimary }}>v2.1.150</span>
    </>,
    <>
      <span style={{ color: TRACK_DARK.textPrimary }}>Opus 4.8</span> (1M context) · Claude Max
    </>,
    <span style={{ color: TRACK_DARK.textPrimary }}>~/.cast/</span>,
  ];
  return (
    <PanelShell>
      <div
        style={{
          flex: 1,
          background: '#000',
          padding: '18px 20px',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 14,
          lineHeight: 1.55,
          color: TRACK_DARK.textPrimary,
        }}
      >
        <div style={{ display: 'flex', gap: 14, marginBottom: 22 }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <ClaudeMark color={TRACK_DARK.termPink} />
          </div>
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.45,
              color: TRACK_DARK.textSecondary,
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

        <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
          <span style={{ color: TRACK_DARK.textMuted }}>&gt;</span>
          <span style={{ fontSize: 13.5, lineHeight: 1.55 }}>
            <span style={{ color: '#7DD3FC', fontWeight: 600 }}>/cast-build</span> I want to
            track the AI hype and know when the bubble's about to pop.
          </span>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', fontSize: 13.5, marginBottom: 16 }}>
          <span style={{ color: TRACK_DARK.termGreen, flexShrink: 0 }}>⏺</span>
          <span style={{ color: '#7DD3FC', fontWeight: 600 }}>Read</span>
          <span style={{ color: TRACK_DARK.textDim }}>(agent-schema/SPEC.md)</span>
        </div>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            fontSize: 13,
            lineHeight: 1.55,
            color: TRACK_DARK.textSecondary,
          }}
        >
          <div>I propose three agents:</div>
          <div>
            <span style={{ color: '#7DD3FC', fontWeight: 700 }}>hype-meter</span> — funding
            rounds, headlines, froth
          </div>
          <div>
            <span style={{ color: '#7DD3FC', fontWeight: 700 }}>reality-check</span> — revenue,
            adoption, layoffs
          </div>
          <div>
            <span style={{ color: '#7DD3FC', fontWeight: 700 }}>briefer</span> — reads both,
            calls who's winning
          </div>
          <div style={{ marginTop: 8, fontWeight: 700, color: TRACK_DARK.termPink }}>
            Build all three?
          </div>
        </div>
      </div>
      <a
        href="/docs/build/claude-code"
        style={{
          padding: '12px 18px',
          borderTop: `1px solid ${TRACK_DARK.panelBorder}`,
          fontSize: 13,
          fontWeight: 600,
          color: '#7DD3FC',
          background: '#000',
          textDecoration: 'none',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span>Read working with Claude Code</span>
        <span>→</span>
      </a>
    </PanelShell>
  );
}

function DualTracksDiagram() {
  return (
    <div>
      {/* Subsection 1 — prose + folder diagram (wide) */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1.1fr',
          gap: 44,
          alignItems: 'center',
        }}
      >
        <div>
          <p
            style={{
              fontSize: 16,
              lineHeight: 1.65,
              color: 'var(--fg-muted)',
              marginTop: 0,
              marginBottom: 14,
            }}
          >
            The instructions, the memory, the skills are all plain files in a folder. No cloud
            account, no database we own, no proprietary format. How the folder gets built is up to
            you. Cast just runs it.
          </p>
          <p
            style={{
              fontSize: 16,
              lineHeight: 1.65,
              color: 'var(--fg-muted)',
              marginBottom: 14,
            }}
          >
            When you want to audit, you can. When you want to fork, copy, or version-control, you
            can. But the default interface is conversation, not file editing.
          </p>
          <p
            style={{
              fontSize: 16,
              lineHeight: 1.65,
              color: 'var(--fg-muted)',
              marginBottom: 0,
            }}
          >
            That's why you can describe the agents in plain English. The folder is the substrate.
            The interface is whatever fits: chat in the browser, or Claude Code in your terminal.
          </p>
        </div>
        <AgentFolder />
      </div>

      {/* Subsection 2 — authoring panels (narrow) */}
      <div style={{ maxWidth: 980, margin: '80px auto 0' }}>
        <h3
          style={{
            margin: '0 0 10px',
            fontSize: 26,
            letterSpacing: '-0.015em',
            lineHeight: 1.2,
            fontWeight: 700,
            color: 'var(--fg)',
          }}
        >
          Two ways to write it.
        </h3>
        <p style={{ margin: '0 0 36px', fontSize: 16, lineHeight: 1.6, color: 'var(--fg-muted)' }}>
          Two paths for authoring an agent. Both write the same files and run on the same
          harness. The agent you ship is identical either way. The seatbelts difference is only
          about what's contained while you're writing. They sit at different maturity, too: the
          in-browser consoles are an early preview we're still sharpening. Claude Code is mature
          terminal tooling.
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 24,
            marginBottom: 20,
          }}
        >
          <div
            style={{
              position: 'relative',
              background: '#f0fdf4',
              border: '2px solid #16a34a',
              boxShadow: '4px 4px 0 #14532d',
              padding: '20px 22px',
              display: 'flex',
              gap: 18,
              alignItems: 'flex-start',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 0,
                right: 0,
                padding: '5px 13px',
                fontSize: 14,
                fontFamily: 'JetBrains Mono, monospace',
                fontWeight: 800,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                color: '#f0fdf4',
                background: '#16a34a',
              }}
            >
              Preview
            </span>
            <TrafficLight lit="green" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <h4
                style={{
                  margin: '0 0 10px',
                  fontSize: 24,
                  fontWeight: 800,
                  letterSpacing: '0.02em',
                  lineHeight: 1.1,
                  color: '#15803d',
                  textTransform: 'uppercase',
                }}
              >
                Seatbelts on.
              </h4>
              <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6, color: 'var(--fg-muted)' }}>
                Two chats live in the Cast dashboard: one designs your agents, the other holds
                your secrets. The design agent can't see your secrets, and the configure agent can't
                reach the internet, so whatever breaks while you build, breaks small. The
                no-terminal on-ramp. If it stalls, the files are right there to edit by hand.
              </p>
            </div>
          </div>
          <div
            style={{
              background: '#fff7ed',
              border: '2px solid #f97316',
              boxShadow: '4px 4px 0 #7c2d12',
              padding: '20px 22px',
              display: 'flex',
              gap: 18,
              alignItems: 'flex-start',
            }}
          >
            <TrafficLight lit="amber" />
            <div style={{ flex: 1, minWidth: 0 }}>
              <h4
                style={{
                  margin: '0 0 10px',
                  fontSize: 24,
                  fontWeight: 800,
                  letterSpacing: '0.02em',
                  lineHeight: 1.1,
                  color: '#c2410c',
                  textTransform: 'uppercase',
                }}
              >
                Seatbelts off.
              </h4>
            <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.6, color: 'var(--fg-muted)' }}>
              Claude Code in your terminal handles the full cycle: build agents{' '}
              <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.92em' }}>
                /cast-build
              </code>
              , refine them as they run{' '}
              <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.92em' }}>
                /cast-refine
              </code>
              , debug them when they break{' '}
              <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '0.92em' }}>
                /cast-debug
              </code>
              . Mature, proven tooling. The dependable path if you're comfortable in a
              terminal. Full system access, so it does anything you can and the buck stops with
              you.
            </p>
          </div>
        </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'stretch' }}>
          <ChatConsoleMock />
          <ClaudeCodeMock />
        </div>

        <div
          aria-hidden="true"
          style={{
            position: 'relative',
            height: 56,
            display: 'flex',
            justifyContent: 'center',
          }}
        >
          <svg viewBox="0 0 600 56" width="100%" preserveAspectRatio="none" style={{ maxWidth: 720 }}>
            <path
              d="M 120 0 C 120 40, 300 16, 300 50"
              stroke="var(--accent)"
              stroke-width="2"
              fill="none"
            />
            <path
              d="M 480 0 C 480 40, 300 16, 300 50"
              stroke="var(--accent)"
              stroke-width="2"
              fill="none"
            />
          </svg>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 12,
              padding: '14px 22px',
              border: '2px solid var(--accent)',
              background: 'var(--bg-sunken)',
              boxShadow: '4px 4px 0 var(--y2k-pink)',
            }}
          >
            <span
              style={{
                fontSize: 11,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                fontWeight: 600,
                color: 'var(--accent)',
              }}
            >
              on disk
            </span>
            <code
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 16,
                fontWeight: 700,
                color: 'var(--fg)',
                letterSpacing: '-0.01em',
              }}
            >
              ~/.cast/agents/&lt;name&gt;/
            </code>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Home() {
  return (
    <div>
      {/* HERO */}
      <section style={{ padding: '60px 0 70px', position: 'relative', overflow: 'hidden' }}>
        <div
          aria-hidden="true"
          class="hero-watermark"
          style={{
            position: 'absolute',
            top: '-60px',
            left: '50%',
            transform: 'translateX(-50%)',
            width: 620,
            height: 620,
            pointerEvents: 'none',
            opacity: 0.06,
            maskImage: 'radial-gradient(circle at center, black 20%, transparent 70%)',
            WebkitMaskImage: 'radial-gradient(circle at center, black 20%, transparent 70%)',
          }}
        >
          <CastLogo size={620} gradient />
        </div>

        <div class="container-narrow" style={{ position: 'relative', textAlign: 'center' }}>
          <a href="https://github.com/yaodub/cast" class="chip" style={{ marginBottom: 40 }}>
            developer alpha · MIT · github →
          </a>
          <h1 class="hero-h1" style={{ margin: 0 }}>
            Your agent team,<br />
            on <span class="hero-italic">your machine</span>.
          </h1>
          <p
            style={{
              fontSize: 18,
              lineHeight: 1.55,
              color: 'var(--fg-muted)',
              maxWidth: 640,
              margin: '40px auto 60px',
              fontStyle: 'italic',
            }}
          >
            Describe and launch an agent team in minutes.<br />Multi-user, multi-agent with security enforced at the boundaries.
          </p>

          <div style={{ margin: '0 auto 36px', textAlign: 'left' }}>
            <HeroTabs />
          </div>

          <TurboPascalBlock />

          <div
            style={{
              maxWidth: 700,
              margin: '4px auto 28px',
              fontFamily: 'VT323, monospace',
              fontSize: 19,
              color: 'var(--fg-subtle)',
              letterSpacing: '0.03em',
              textAlign: 'center',
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'center',
              columnGap: '0.55em',
              rowGap: '0.1em',
            }}
          >
            <span style={{ whiteSpace: 'nowrap' }}>requires apple container or docker</span>
            <span aria-hidden="true">·</span>
            <span style={{ whiteSpace: 'nowrap' }}>anthropic account</span>
          </div>

          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <a href="/docs/quickstart" class="btn btn-primary">
              Clone and run
            </a>
            <a href="https://github.com/yaodub/cast" class="btn btn-secondary">
              <Github s={14} /> View source
            </a>
          </div>
        </div>
      </section>

      {/* THE GAP */}
      <section class="y2k-band-yellow" style={{ padding: '80px 0' }}>
        <div class="container" style={{ maxWidth: 1000 }}>
          <div style={{ marginBottom: 40, maxWidth: 680 }}>
            <div class="badge" style={{ marginBottom: 14 }}>
              Why Cast exists
            </div>
            <h2 style={{ margin: 0, fontSize: 40, letterSpacing: '-0.02em' }}>
              Sound familiar?
            </h2>
          </div>

          {[
            {
              label: 'Approval loops',
              vent: [
                "Every agent framework gives me the same false choice: approve every command manually, or auto-approve everything and pray. Been praying for weeks.",
                "I've spent more time debugging my agent's infrastructure than using it.",
              ],
              signoff: 'Faith-Based DevOps',
              location: 'Austin',
              reply: "In Cast, every agent runs inside its own container with a mount table it literally can't escape. Edit prompt.md, hit reload. Let the agent do its worst. Faith is a fine thing, but it makes a poor sandbox.",
              tilt: -0.8,
            },
            {
              label: 'Multi-user bleed',
              vent: [
                "My agents work great when it's just me. The second anyone else joins, the context bleeds and everything breaks.",
                "Five of us are using the same agent on the same project. It learns nothing from the overlap.",
              ],
              signoff: 'Five-Headed Hydra',
              location: 'Brooklyn',
              reply: "In Cast, every message is identity-verified at the server before it reaches the agent. Per-user conversations on a shared workspace, and the agent always knows who's asking and what they're allowed to know. Five heads, five contexts, one shared context. No sweat.",
              tilt: 0.6,
            },
            {
              label: 'Multi-agent improv',
              vent: [
                "I tried multi-agent in production. Gave up. Went back to one big agent.",
                "We routed inter-agent coordination through Discord because our framework's A2A primitives were too broken to trust.",
              ],
              signoff: 'Discord Refugee',
              location: 'Berlin',
              reply: "In Cast, every message between agents follows a declared org chart: who can talk to whom, in which direction, on what topics. Multi-agent built in, not improvised at step seven. Time to break it to Discord. You've met someone better.",
              tilt: -1.0,
            },
          ].map((thread, i) => (
            <div
              key={i}
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: 22,
                alignItems: 'center',
                marginBottom: 36,
              }}
            >
              <div
                class="case-letter"
                style={{
                  background: 'linear-gradient(180deg, #FFFBE6 0%, #FFEFAE 100%)',
                  border: 'none',
                  borderRadius: 2,
                  padding: '14px 18px',
                  fontStyle: 'italic',
                  boxShadow:
                    '0 1px 1px rgba(0,0,0,0.10), 0 6px 14px -4px rgba(0,0,0,0.22)',
                  transform: `rotate(${thread.tilt}deg)`,
                  transformOrigin: 'center top',
                }}
              >
                <p style={{ margin: '0 0 10px', fontSize: 15.5, fontWeight: 700, color: 'var(--fg)' }}>
                  Dear Cast,
                </p>
                {thread.vent.map((v, j) => (
                  <div key={j}>
                    {j > 0 && (
                      <div
                        style={{
                          borderTop: '1px dashed rgba(230, 57, 70, 0.55)',
                          margin: '20px 0',
                        }}
                      />
                    )}
                    <p style={{ margin: 0, fontSize: 15.5, lineHeight: 1.65, fontStyle: 'italic', color: 'var(--fg)' }}>
                      "{v}"
                    </p>
                  </div>
                ))}
                <p style={{ margin: '12px 0 0', textAlign: 'right', fontSize: 12, fontWeight: 600, color: 'var(--y2k-blue)', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                  {thread.signoff}, {thread.location}
                </p>
              </div>

              <div
                class="case-reply"
                style={{
                  backgroundImage: [
                    // Top mask — required because repeating-linear-gradient
                    // repeats infinitely in BOTH directions from its position
                    // origin, otherwise a line wraps up into the header area.
                    'linear-gradient(to bottom, #FFFFFF 0, #FFFFFF 38px, transparent 38px)',
                    // Bottom mask — clears the last 18px so ruled lines stay
                    // clear of the signature.
                    'linear-gradient(to top, #FFFFFF 0, #FFFFFF 18px, transparent 18px)',
                    // Ruled paper — lines repeat every 28px starting 38px in
                    // from the top.
                    'repeating-linear-gradient(to bottom, transparent 0, transparent 27px, #DCE7F2 27px, #DCE7F2 28px)',
                  ].join(','),
                  backgroundPosition: '0 0, 0 0, 0 38px',
                  backgroundRepeat: 'no-repeat, no-repeat, repeat',
                  backgroundColor: '#FFFFFF',
                  border: 'none',
                  borderRadius: 4,
                  padding: '14px 18px',
                  boxShadow:
                    '0 1px 2px rgba(0,0,0,0.08), 0 10px 20px -8px rgba(0,0,0,0.20)',
                  height: 240,
                  display: 'flex',
                  flexDirection: 'column',
                }}
              >
                <p style={{ margin: '0 0 4px', fontSize: 15.5, lineHeight: '28px', fontWeight: 700, color: 'var(--fg)' }}>
                  Dear {thread.signoff},
                </p>
                <p style={{ margin: 0, fontSize: 15.5, lineHeight: '28px', color: 'var(--fg)' }}>
                  {thread.reply}
                </p>
                <p style={{ margin: 'auto 0 0', paddingTop: 8, textAlign: 'right', fontSize: 12, fontWeight: 600, color: 'var(--y2k-pink)', fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                  — CAST
                </p>
              </div>
            </div>
          ))}

          <p style={{ margin: '8px 0 0', fontSize: 15, lineHeight: 1.65, fontStyle: 'italic', color: 'var(--fg-muted)' }}>
            Three different pains. One fix: a harness, not a prompt.
          </p>
        </div>
      </section>

      {/* AN AGENT IS A FOLDER YOU CAN BROWSE */}
      <section style={{ padding: '80px 0' }}>
        <div class="container">
          <div style={{ maxWidth: 760, marginBottom: 36 }}>
            <div class="badge" style={{ marginBottom: 14 }}>
              Your files, your agent
            </div>
            <h2
              style={{ margin: 0, fontSize: 36, letterSpacing: '-0.02em', lineHeight: 1.1 }}
            >
              An agent is a folder you can browse.
            </h2>
          </div>

          <DualTracksDiagram />

        </div>
      </section>

      {/* HOW YOU TALK TO IT / WHO GETS IN */}
      <WhoGetsIn />

      {/* WHERE THE BOUNDARIES ARE DRAWN */}
      <section class="y2k-band-ice" style={{ padding: '80px 0' }}>
        <div class="container" style={{ maxWidth: 980 }}>
          <div style={{ marginBottom: 36, maxWidth: 720 }}>
            <div class="badge" style={{ marginBottom: 14 }}>
              Enforce
            </div>
            <h2
              style={{ margin: '0 0 16px', fontSize: 36, letterSpacing: '-0.02em', lineHeight: 1.1 }}
            >
              Where the boundaries are drawn.
            </h2>
            <p
              style={{
                fontSize: 24,
                lineHeight: 1.35,
                color: 'var(--fg)',
                margin: '0 0 28px',
                fontStyle: 'italic',
                fontWeight: 500,
                letterSpacing: '-0.015em',
              }}
            >
              You draw them. The harness holds them. The agent has no path around them.
            </p>
            <p
              style={{
                fontSize: 16,
                lineHeight: 1.7,
                color: 'var(--fg-muted)',
                marginBottom: 12,
              }}
            >
              Agents need continual refining. Iteration speed matters more than getting it right
              the first time. The harness contains what's still in flux while you converge.
            </p>
            <p
              style={{
                fontSize: 16,
                lineHeight: 1.7,
                color: 'var(--fg-muted)',
                margin: 0,
              }}
            >
              A clever model can't argue its way out. A still-converging agent can't accidentally
              exceed its scope.
            </p>
          </div>

          <VisioDiagram />

          <div style={{ marginTop: 44 }}>
            <table style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ width: '38%' }}>What's enforced</th>
                  <th>How</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>The agent can't rewrite its own instructions</td>
                  <td>
                    <code>prompt.md</code> is mounted read-only. The agent literally cannot write
                    to it.
                  </td>
                </tr>
                <tr>
                  <td>The agent can't reach files you didn't declare</td>
                  <td>Explicit mount table. If it's not in the mounts, the agent has no path to it.</td>
                </tr>
                <tr>
                  <td>The agent can't call tools you didn't allow</td>
                  <td>Per-conversation tool sets. Each conversation has its own declared toolset.</td>
                </tr>
                <tr>
                  <td>Agents can't query each other without permission</td>
                  <td>
                    Explicit access control. You declare which agents can talk to which, in which
                    direction.
                  </td>
                </tr>
                <tr>
                  <td>Nobody reaches an agent without being paired in</td>
                  <td>
                    Pairing is mutual. Both sides accept explicitly. No wildcard grant, no default
                    access.
                  </td>
                </tr>
                <tr>
                  <td>Multi-user privacy is what you declared</td>
                  <td>
                    Choose the privacy level per agent. From fully separate agents, to one shared
                    agent with per-user conversations, to declared cross-user sharing.
                  </td>
                </tr>
                <tr>
                  <td>The agent doesn't burn tokens when nothing's happening</td>
                  <td>Event-driven. Wakes on message, schedule, or file change. Idle = zero.</td>
                </tr>
              </tbody>
            </table>
            <p
              style={{
                marginTop: 20,
                marginBottom: 0,
                fontSize: 14,
                lineHeight: 1.6,
                color: 'var(--fg-subtle)',
                fontStyle: 'italic',
                textAlign: 'center',
              }}
            >
              Every constraint above is enforced by the harness at runtime, not requested by the
              prompt.
            </p>
          </div>
        </div>
      </section>

      {/* FOUR PRINCIPLES */}
      <section style={{ padding: '80px 0' }}>
        <div class="container" style={{ maxWidth: 1000 }}>
          <div
            style={{
              textAlign: 'center',
              marginBottom: 40,
              maxWidth: 640,
              marginLeft: 'auto',
              marginRight: 'auto',
            }}
          >
            <div class="badge" style={{ marginBottom: 14 }}>
              The four claims
            </div>
            <h2 style={{ margin: 0, fontSize: 36, letterSpacing: '-0.02em' }}>
              Four things the harness enforces.
            </h2>
            <p style={{ margin: '10px 0 0', fontSize: 18, lineHeight: 1.5, fontStyle: 'italic', color: 'var(--fg-muted)' }}>
              You draw the lines. The harness holds them. The agent has no path around them.
            </p>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 18 }}>
            {[
              {
                title: "An agent that edits itself, but only where you let it.",
                body: "The agent updates its runtime as it works: memory, conversations, working files. Identity, prompt, and skills are mounted read-only, so the agent can't change who it is. That part's your call. Refine the blueprint by hand or through Claude Code anytime, and the agent runs within the lines you drew.",
              },
              {
                title: "The harness draws the agent's reach.",
                body: "Mount tables, tool allowlists, network egress: every constraint is declared and enforced at runtime, not requested in the prompt. A clever model can't argue with the filesystem.",
              },
              {
                title: "The harness verifies who's asking.",
                body: "Cast verifies each person at the server before their message reaches the agent. Everyone shares one workspace but gets their own conversation. The agent always knows who's there.",
              },
              {
                title: 'The harness brokers between agents.',
                body: "Inter-agent traffic goes through a declared permission table: who can ask whom, in which direction, and what's allowed. No ad-hoc message bus, no improvised authority.",
              },
            ].map((p, i) => (
              <div key={i} class="feature" style={{ padding: 22 }}>
                <h3
                  style={{
                    margin: '0 0 10px',
                    fontSize: 19,
                    fontWeight: 700,
                    letterSpacing: '-0.015em',
                  }}
                >
                  {p.title}
                </h3>
                <p
                  style={{
                    margin: 0,
                    fontSize: 14.5,
                    lineHeight: 1.65,
                    color: 'var(--fg-muted)',
                  }}
                >
                  {p.body}
                </p>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 24, textAlign: 'right' }}>
            <a
              href="/how-it-works"
              style={{ fontSize: 15, fontWeight: 600, color: 'var(--accent)' }}
            >
              See how Cast works →
            </a>
          </div>
        </div>
      </section>

      {/* OPEN SOURCE RECEIPTS */}
      <section class="y2k-band-ice" style={{ padding: '80px 0' }}>
        <div class="container" style={{ maxWidth: 900, position: 'relative' }}>
          <div style={{ marginBottom: 28, maxWidth: 640 }}>
            <div class="badge" style={{ marginBottom: 14 }}>
              Open source, for real
            </div>
            <h2 style={{ margin: '0 0 12px', fontSize: 36, letterSpacing: '-0.02em' }}>
              MIT licensed. Full source. No hidden core.
            </h2>
            <p style={{ fontSize: 16, lineHeight: 1.7, color: 'var(--fg)', margin: '0 0 14px' }}>
              It runs on your hardware, and it's one project, not three you wire together
              yourself.
            </p>
            <p style={{ fontSize: 16, lineHeight: 1.65, color: 'var(--fg-muted)', margin: 0 }}>
              If this project gets hit by the Y2K bug, you still have the program, the source, and
              your folder of agents. That's the only arrangement we think is fair.
            </p>
            <p
              style={{
                fontSize: 14,
                lineHeight: 1.5,
                color: 'var(--fg-subtle)',
                margin: '12px 0 0',
                fontStyle: 'italic',
              }}
            >
              Developer alpha in progress. Contributors welcome.
            </p>
          </div>

          <table style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ width: '25%' }}>Item</th>
                <th>What</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>License</td>
                <td>MIT</td>
                <td>no contributor agreement, no relicensing</td>
              </tr>
              <tr>
                <td>Runs on</td>
                <td>Your machine, your server</td>
                <td>not Anthropic's cloud</td>
              </tr>
              <tr>
                <td>Language model</td>
                <td>Claude (default)</td>
                <td>configurable, not locked in</td>
              </tr>
              <tr>
                <td>Onboarding</td>
                <td>
                  <code>git clone</code> + <code>pnpm start</code>
                </td>
                <td>Design docks in the dashboard, ready to help you describe an agent.</td>
              </tr>
              <tr>
                <td>Source</td>
                <td>
                  <a href="https://github.com/yaodub/cast">github.com/yaodub/cast</a>
                </td>
                <td>actively developed</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* FAQ */}
      <section style={{ padding: '80px 0' }}>
        <div class="container" style={{ maxWidth: 780 }}>
          <div style={{ marginBottom: 36 }}>
            <div class="badge" style={{ marginBottom: 14 }}>
              Questions you might have
            </div>
            <h2 style={{ margin: 0, fontSize: 36, letterSpacing: '-0.02em' }}>
              We had them too.
            </h2>
          </div>
          <Faq />
        </div>
      </section>

      {/* FINAL CTA */}
      <section class="y2k-band-yellow" style={{ padding: '90px 0 70px' }}>
        <div class="container-narrow" style={{ textAlign: 'center' }}>
          <h2
            style={{
              margin: '0 0 16px',
              fontSize: 48,
              letterSpacing: '-0.025em',
              lineHeight: 1.05,
            }}
          >
            Clone it.
            <br />
            <span style={{ color: 'var(--accent)' }}>See what it does.</span>
          </h2>
          <p
            style={{
              fontSize: 16,
              color: 'var(--fg-muted)',
              maxWidth: 560,
              margin: '0 auto 28px',
            }}
          >
            Clone the repo. Run <code>pnpm start</code>. Tell Design what you want to build.
            Refine it. Pair the people you trust.
          </p>
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              background: 'var(--code-bg)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '10px 16px',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 14,
              marginBottom: 22,
            }}
          >
            <span style={{ color: 'var(--accent)', marginRight: 10 }}>$</span>
            <span style={{ color: 'var(--code-fg)', marginRight: 14 }}>
              git clone{' '}
              <span style={{ color: 'var(--s-string)' }}>github.com/yaodub/cast</span>
            </span>
            <CopyButton text="git clone https://github.com/yaodub/cast.git" />
          </div>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <a href="/docs/quickstart" class="btn btn-primary">
              Read the Quickstart
            </a>
            <a href="https://github.com/yaodub/cast" class="btn btn-secondary">
              <Github s={14} /> GitHub
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
