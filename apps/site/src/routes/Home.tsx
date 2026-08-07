// Front page. Structure: hero → sticky verb nav → one chapter per job
// (monitor / triage / remember / act / coordinate, plus the Compose catch-all),
// each flowing blueprint line → the message it produces → what the agent can
// reach → footer (build paths, receipts, FAQ, CTA). The mental model lives as
// a compact aside inside the Act chapter.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { CopyButton } from '../components/ui/CopyButton';
import { CastLogo } from '../components/brand/CastLogo';
import { Github } from '../components/brand/Icon';
import { ChatMockup, type ChatMessage } from '../components/site/ChatMockup';

/* ================================================================
   Job data
   ================================================================ */

interface Job {
  id: string;
  word: string;
  hue: string;
  /** Text color that reads on a solid hue fill. */
  onHue: string;
  /** Direct description of what the agent does. */
  what: string;
  /** The agent starring in this chapter's artifact. */
  agentName: string;
  jobs: string[];
  script: ChatMessage[];
  /** Plain-language reach rows for this agent. "nothing else" is appended. */
  /** Collapsed "How Cast does this" expander: the mechanism idea, qualitative. */
  how?: string;
}

const JOBS: Job[] = [
  {
    id: 'monitor',
    word: 'Monitor',
    hue: 'var(--y2k-cyan)',
    onHue: '#FFFFFF',
    what: 'An agent checks listings, feeds, prices, or repos and pings you when something changes.',
    agentName: 'scout',
    jobs: [
      'Monitor apartment listings under my filters. Ping me within the hour, good ones go fast.',
    ],
    script: [
      {
        from: 'agent',
        via: 'telegram',
        time: '12:41',
        text: 'New listing: 2BR in Alfama, under budget, posted 20 minutes ago. These go in hours.',
      },
    ],
    how: 'Cast agents wake on programmatic triggers: cron schedules, new mail, inbound messages. The model is only called to judge what turned up. A monitor runs exactly when its trigger fires and costs nothing in between. You create a watch by asking for it, and revoke it the same way.',
  },
  {
    id: 'triage',
    word: 'Triage',
    hue: 'var(--y2k-amber)',
    onHue: 'var(--y2k-ink)',
    what: 'An agent reads your inbox and hands you the few that matter, with drafts for the rest.',
    agentName: 'mailhand',
    jobs: ['Read my inbox at 7. Flag what needs me, draft the routine replies.'],
    script: [
      {
        from: 'agent',
        via: 'telegram',
        time: '07:04',
        text: 'Morning. 3 of 14 need you: the lease renewal, Dana\u2019s contract question, the school form. Replies to the other 11 are drafted and waiting for your OK.',
      },
    ],
    how: 'Cast fetches the mail on the host. The agent only holds the messages: it never sees the login and never touches the mailbox.',
  },
  {
    id: 'remember',
    word: 'Remember',
    hue: 'var(--y2k-purple)',
    onHue: '#FFFFFF',
    what: 'An agent keeps notes across every conversation and answers from them later.',
    agentName: 'assistant',
    jobs: ['Keep track of the people and plans I mention. When I ask where we left off, tell me.'],
    script: [
      { from: 'user', via: 'web', text: 'what did we decide about the lisbon dates?' },
      {
        from: 'agent',
        text: 'Oct 12 to 19. Decided May 3, after Priya\u2019s schedule changed. You wanted the extra weekend for Sintra.',
      },
    ],
    how: 'Cast agents can rewrite their memory but not their instructions. Memory grows with every conversation. The instructions stay exactly what you wrote.',
  },
  {
    id: 'act',
    word: 'Act',
    hue: 'var(--y2k-pink)',
    onHue: '#FFFFFF',
    what: 'An agent runs errands: booking, replying, sending. Anything that reaches other people waits for your approval.',
    agentName: 'booker',
    jobs: ['Schedule my meetings. Find times that work, book only after I confirm.'],
    script: [
      {
        from: 'agent',
        via: 'telegram',
        time: '11:20',
        text: 'Dana asked for 45 minutes this week. You are both free Tuesday 10:00 or Thursday 14:30. Send the Thursday invite?',
      },
      { from: 'user', text: 'yes' },
      { from: 'agent', text: 'Invite sent. Dana accepted, Thursday 14:30.' },
    ],
    how: 'Cast agents act only through the tools you granted. Cast runs those tools on the host and keeps the credentials there. Anything with consequences, like sending or booking, asks you first.',
  },
  {
    id: 'coordinate',
    word: 'Coordinate',
    hue: 'var(--y2k-blue)',
    onHue: '#FFFFFF',
    what: 'One agent works with several people, each in their own private thread.',
    agentName: 'trip-desk',
    jobs: [
      'Plan the Portugal trip with the three of us. Keep our research separate and the itinerary shared.',
    ],
    script: [
      { from: 'user', via: 'sam · telegram', text: 'found flights under $400 on the 12th' },
      { from: 'user', via: 'priya · slack', text: 'one museum day max, please' },
      {
        from: 'agent',
        via: 'to everyone',
        text: 'Itinerary v3 is up: fly the 12th, one museum, two hikes. Friday evening is held for Sam\u2019s plan.',
      },
    ],
    how: 'Cast supports many people and many agents. Every message arrives with a verified identity. Each person is assigned to a channel with its own permissions: what they can ask, what they can see, whether they reach the agent at all.',
  },
];

/** Catch-all chapter: not a pattern, the invitation to write your own. */
const COMBINE = { id: 'compose', word: 'Compose', hue: 'var(--y2k-lime)' } as const;

/* ================================================================
   Scroll-spy for the sticky strip
   ================================================================ */

function useActiveChapter(ids: string[]): { active: string | null; before: boolean } {
  const [state, setState] = useState<{ active: string | null; before: boolean }>({
    active: null,
    before: true,
  });
  useEffect(() => {
    const onScroll = () => {
      // A chapter takes over once its top crosses the middle of the viewport.
      const threshold = window.innerHeight * 0.5;
      let current: string | null = null;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= threshold) current = id;
      }
      // Past the end of the last chapter: nothing is active and the bar rests.
      const last = document.getElementById(ids[ids.length - 1]!);
      if (last && last.getBoundingClientRect().bottom <= threshold) current = null;
      // Before the first chapter: the bar is docked at the viewport bottom.
      const first = document.getElementById(ids[0]!);
      const before = !!first && first.getBoundingClientRect().top > threshold;
      setState({ active: current, before });
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return state;
}

function VerbStrip() {
  const { active, before } = useActiveChapter([...JOBS.map((v) => v.id), COMBINE.id]);
  const inZone = active !== null;
  return (
    <div
      style={{
        position: 'sticky',
        top: 60,
        bottom: 0,
        zIndex: 40,
        background: 'var(--bg)',
        borderTop: '1px solid var(--border-strong)',
        borderBottom: '1px solid var(--border-strong)',
        boxShadow: before
          ? '0 -6px 16px -10px rgba(0, 0, 0, 0.3)'
          : inZone
            ? '0 8px 20px -12px rgba(0, 0, 0, 0.3)'
            : '0 4px 12px -10px rgba(0, 0, 0, 0.2)',
        transition: 'box-shadow 180ms ease',
      }}
    >
      <style>{`
        .verb-bar-inner { padding: var(--vb-pad, 18px) 32px; }
        @media (max-width: 640px) {
          .verb-bar-inner { padding: calc(var(--vb-pad, 18px) * 0.55) 14px; }
        }
      `}</style>
      <div
        class="container no-scrollbar verb-bar-inner"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexWrap: 'wrap',
          gap: 8,
          '--vb-pad': '13px',
        }}
      >
        {[...JOBS, COMBINE].map((v) => {
          const on = active === v.id;
          return (
            <a
              key={v.id}
              href={`#${v.id}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                whiteSpace: 'nowrap',
                padding: '7px 14px',
                borderRadius: 999,
                fontFamily: 'Inter, sans-serif',
                fontSize: 14,
                fontWeight: on ? 700 : 550,
                color: on ? 'var(--fg)' : 'var(--fg-muted)',
                background: on ? `color-mix(in oklab, ${v.hue} 20%, var(--bg))` : 'var(--bg-elev)',
                border: `1px solid ${on ? v.hue : 'var(--border)'}`,
                textDecoration: 'none',
                transition: 'background 140ms ease, border-color 140ms ease',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: v.hue,
                  display: 'inline-block',
                  flexShrink: 0,
                }}
              />
              {v.word}
            </a>
          );
        })}
      </div>
    </div>
  );
}

/* ================================================================
   Chapter pieces
   ================================================================ */

/** The mental model, folded into the Act chapter as a compact aside. */
function OneRule() {
  return (
    <div
      style={{
        marginTop: 14,
        background: 'color-mix(in oklab, var(--bg-sunken) 60%, var(--bg))',
        borderRadius: 14,
        padding: '18px 22px',
      }}
    >
      <div
        style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--fg-subtle)',
          marginBottom: 8,
        }}
      >
        why this holds
      </div>
      <p style={{ margin: '0 0 10px', fontSize: 14, lineHeight: 1.65, color: 'var(--fg-muted)' }}>
        The agent lives in a container, and everything in or out crosses Cast. Most stacks
        sandbox an agent&rsquo;s risky tools. Cast sandboxes the agent itself.
      </p>
      <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--fg)' }}>
        Allowed and possible are the same list.
      </p>
    </div>
  );
}

function Chapter({ v, index }: { v: Job; index: number }) {
  return (
    <section
      id={v.id}
      style={{
        padding: '64px 0 60px',
        scrollMarginTop: 112,
        borderLeft: `8px solid ${v.hue}`,
        borderRight: `8px solid ${v.hue}`,
        borderTop: index === 0 ? 'none' : '1px dashed var(--border-strong)',
      }}
    >
      <div class="container" style={{ maxWidth: 760 }}>
        <h2
          style={{
            margin: '0 0 12px',
            fontFamily: 'Inter, sans-serif',
            fontWeight: 800,
            fontSize: 'clamp(45px, 9vw, 60px)',
            letterSpacing: '-0.02em',
            lineHeight: 1.05,
            color: 'var(--fg)',
            textAlign: 'center',
          }}
        >
          {v.word}
        </h2>
        <p
          style={{
            margin: '0 auto 24px',
            maxWidth: 560,
            fontSize: 16.5,
            lineHeight: 1.55,
            color: 'var(--fg-muted)',
            textAlign: 'center',
          }}
        >
          {v.what}
        </p>

        {v.jobs.map((job, i) => (
          <blockquote
            key={i}
            style={{
              margin: i === 0 ? '0 auto' : '12px auto 0',
              maxWidth: 580,
              padding: '14px 20px',
              borderRadius: 12,
              background: `color-mix(in oklab, ${v.hue} 12%, var(--bg))`,
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 15.5,
              lineHeight: 1.6,
              color: 'var(--fg)',
              textAlign: 'center',
            }}
          >
            &ldquo;{job}&rdquo;
          </blockquote>
        ))}

        <div aria-hidden="true" style={{ textAlign: 'center', margin: '12px 0' }}>
          <svg width="34" height="38" viewBox="0 0 30 34" style={{ display: 'inline-block' }}>
            <path d="M 11 0 L 19 0 L 19 18 L 29 18 L 15 33 L 1 18 L 11 18 Z" fill="#AEB8C4" />
          </svg>
        </div>

        <ChatMockup agentName={v.agentName} script={v.script} />

        {v.how && (
          <div
            style={{
              margin: '16px auto 0',
              maxWidth: 680,
              padding: '36px 44px',
              textAlign: 'center',
              background: 'radial-gradient(ellipse 85% 95% at 50% 50%, color-mix(in oklab, var(--fg) 7%, transparent), transparent 74%)',
            }}
          >
            <span style={{ display: 'inline-block', color: '#AEB8C4', marginBottom: 14 }}>
              <CastLogo size={42} />
            </span>
            <p
              style={{
                margin: 0,
                fontSize: 20,
                fontWeight: 400,
                lineHeight: 1.65,
                color: 'var(--fg)',
              }}
            >
              {v.how}
            </p>
          </div>
        )}

        {v.id === 'act' && <OneRule />}
      </div>
    </section>
  );
}

/** The catch-all: primitives, and concrete shapes people actually build. */
function CombineChapter() {
  const shapes = [
    'Three agents watch polls, odds, and the news. A fourth compares them and pings you only when they disagree.',
    'A standup agent asks each teammate separately what they shipped and where they are stuck, then posts one summary to the channel.',
    'At tax time, one agent reads guidance and forms on the open web. A second one holds your income documents and works out the numbers. The agent on the internet never sees your finances.',
  ];
  return (
    <section
      id={COMBINE.id}
      style={{
        padding: '64px 0 60px',
        scrollMarginTop: 112,
        borderLeft: `8px solid ${COMBINE.hue}`,
        borderRight: `8px solid ${COMBINE.hue}`,
        borderTop: '1px dashed var(--border-strong)',
      }}
    >
      <div class="container" style={{ maxWidth: 760 }}>
        <h2
          style={{
            margin: '0 0 12px',
            fontFamily: 'Inter, sans-serif',
            fontWeight: 800,
            fontSize: 'clamp(45px, 9vw, 60px)',
            letterSpacing: '-0.02em',
            lineHeight: 1.05,
            color: 'var(--fg)',
            textAlign: 'center',
          }}
        >
          {COMBINE.word}
        </h2>
        <p
          style={{
            margin: '0 auto 24px',
            maxWidth: 580,
            fontSize: 16.5,
            lineHeight: 1.55,
            color: 'var(--fg-muted)',
            textAlign: 'center',
          }}
        >
          Cast doesn&rsquo;t define what an agent can do. It gives you the primitives to
          build whatever you need done.
        </p>
        <div
          style={{
            background: `color-mix(in oklab, ${COMBINE.hue} 7%, var(--bg))`,
            borderRadius: 14,
            padding: '18px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {shapes.map((line) => (
            <div key={line} style={{ display: 'flex', gap: 10, fontSize: 14.5, lineHeight: 1.6, color: 'var(--fg-muted)' }}>
              <span style={{ color: COMBINE.hue, fontWeight: 700 }}>✓</span>
              <span>{line}</span>
            </div>
          ))}
        </div>
        <div style={{ textAlign: 'center', marginTop: 20 }}>
          <a href="/examples" style={{ fontSize: 15, fontWeight: 600, color: 'var(--accent)' }}>
            See worked examples →
          </a>
        </div>
      </div>
    </section>
  );
}

/* ================================================================
   Hero
   ================================================================ */

const FOLDER_ROWS: Array<{ name: string; quote: string }> = [
  {
    name: 'scout',
    quote: 'Monitor apartment listings under my filters. Ping me within the hour.',
  },
  {
    name: 'mailhand',
    quote: 'Read my inbox at 7. Flag what needs me, draft the rest.',
  },
  {
    name: 'household',
    quote: 'Run the family calendar and the school emails. Anyone in the house can message you.',
  },
];

function MacFolderIcon() {
  return (
    <svg width="16" height="13" viewBox="0 0 16 13" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path
        d="M1 2.5C1 1.7 1.7 1 2.5 1h3.6c.4 0 .9.2 1.1.5L8.4 3h5.1c.8 0 1.5.7 1.5 1.5v6c0 .8-.7 1.5-1.5 1.5h-11C1.7 12 1 11.3 1 10.5z"
        fill="#4DA3FF"
      />
    </svg>
  );
}

function FolderOfJobs() {
  return (
    <div
      style={{
        maxWidth: 620,
        margin: '0 auto',
        textAlign: 'left',
        borderRadius: 12,
        border: '1px solid var(--border-strong)',
        background: 'var(--bg-elev)',
        boxShadow: '0 16px 40px -18px rgba(0, 0, 0, 0.35)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--bg-sunken)',
        }}
      >
        <span aria-hidden="true" style={{ display: 'inline-flex', gap: 7, width: 62 }}>
          <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#FF5F57' }} />
          <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#FEBC2E' }} />
          <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#28C840' }} />
        </span>
        <span
          style={{
            flex: 1,
            textAlign: 'center',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12.5,
            color: 'var(--fg-muted)',
          }}
        >
          ~/.cast/agents
        </span>
        <span aria-hidden="true" style={{ width: 62 }} />
      </div>
      {FOLDER_ROWS.map((r, i) => (
        <div
          key={r.name}
          style={{
            padding: `${i === 0 ? 13 : 6}px 18px ${i === FOLDER_ROWS.length - 1 ? 13 : 6}px`,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <MacFolderIcon />
            <span
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 13.5,
                fontWeight: 600,
                color: 'var(--fg)',
              }}
            >
              {r.name}
            </span>
          </div>
          <div
            style={{
              marginLeft: 25,
              marginTop: 3,
              fontFamily: 'Inter, sans-serif',
              fontSize: 13,
              fontStyle: 'italic',
              lineHeight: 1.5,
              color: 'var(--fg-muted)',
            }}
          >
            &ldquo;{r.quote}&rdquo;
          </div>
        </div>
      ))}
      <div
        style={{
          padding: '7px 18px',
          borderTop: '1px solid var(--border)',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11.5,
          color: 'var(--fg-subtle)',
        }}
      >
        3 agents · running · idle costs nothing
      </div>
    </div>
  );
}

function CloneBlock({ showRequirements = true }: { showRequirements?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'flex-start',
          gap: 14,
          background: 'var(--code-bg)',
          color: 'var(--code-fg)',
          border: '1px solid var(--border-strong)',
          boxShadow: 'var(--shadow-sm)',
          padding: '12px 16px',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 13.5,
          lineHeight: 1.8,
          maxWidth: '100%',
          overflowX: 'auto',
          textAlign: 'left',
        }}
      >
        <div>
          <div style={{ whiteSpace: 'nowrap' }}>
            <span style={{ color: 'var(--y2k-lime)' }}>$ </span>
            git clone https://github.com/yaodub/cast.git
          </div>
          <div style={{ whiteSpace: 'nowrap' }}>
            <span style={{ color: 'var(--y2k-lime)' }}>$ </span>
            cd cast && pnpm start
          </div>
        </div>
        <CopyButton
          text={'git clone https://github.com/yaodub/cast.git && cd cast && npm i -g pnpm && pnpm start'}
        />
      </div>
      {showRequirements && (
        <div
          style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12,
            letterSpacing: '0.04em',
            color: 'var(--fg-subtle)',
            textAlign: 'center',
            padding: '0 12px',
          }}
        >
          apple container or docker · node 20+ · an anthropic api key or claude.ai token
        </div>
      )}
    </div>
  );
}

function Hero() {
  return (
    <section style={{ padding: '56px 0 56px', position: 'relative', overflow: 'hidden' }}>
      <div
        aria-hidden="true"
        class="hero-watermark"
        style={{
          position: 'absolute',
          top: '-90px',
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
        <a href="https://github.com/yaodub/cast" class="chip" style={{ marginBottom: 34 }}>
          developer alpha · MIT · source on github →
        </a>
        <h1
          style={{
            margin: 0,
            fontFamily: 'Inter, sans-serif',
            fontWeight: 800,
            fontSize: 'clamp(38px, 9vw, 64px)',
            letterSpacing: '-0.03em',
            lineHeight: 1.05,
            color: 'var(--fg)',
            textShadow: '3px 3px 0 color-mix(in oklab, var(--y2k-pink) 28%, var(--bg))',
          }}
        >
          Agents that <span style={{ fontStyle: 'italic', color: 'var(--y2k-pink)' }}>work</span>{' '}
          for you.
        </h1>
        <p
          style={{
            fontSize: 17.5,
            lineHeight: 1.6,
            color: 'var(--fg-muted)',
            maxWidth: 620,
            margin: '30px auto 40px',
          }}
        >
          Cast runs a team of AI agents on your own machine, around the clock. Each agent runs
          in its own container and can <strong style={{ color: 'var(--fg)' }}>only access what you allow</strong>.
        </p>
        <div style={{ marginBottom: 36 }}>
          <FolderOfJobs />
        </div>
        <CloneBlock />
        <div
          style={{
            display: 'flex',
            gap: 12,
            justifyContent: 'center',
            flexWrap: 'wrap',
            marginTop: 26,
          }}
        >
          <a href="/docs/quickstart" class="btn btn-primary">
            Read the quickstart
          </a>
          <a href="https://github.com/yaodub/cast" class="btn btn-secondary">
            <Github s={14} /> View source
          </a>
        </div>
      </div>
    </section>
  );
}

/* ================================================================
   Footer furniture
   ================================================================ */

function BuildPaths() {
  return (
    <section style={{ padding: '72px 0', borderTop: '2px solid var(--border-strong)' }}>
      <div class="container" style={{ maxWidth: 1000 }}>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--fg-subtle)', marginBottom: 12 }}>
          authoring
        </div>
        <h2 class="section-h2" style={{ margin: '0 0 10px' }}>
          Two ways to write an agent.
        </h2>
        <p
          style={{
            margin: '0 0 30px',
            fontSize: 16,
            lineHeight: 1.6,
            color: 'var(--fg-muted)',
            maxWidth: 680,
          }}
        >
          Both produce the same folder under <code>~/.cast/agents/</code>. Start in one, finish
          in the other.
        </p>
        <div class="cols-2" style={{ gap: 24 }}>
          <div
            style={{
              position: 'relative',
              border: '1px solid var(--border-strong)',
              background: 'var(--bg-elev)',
              borderTop: '3px solid var(--y2k-cyan)',
              boxShadow: 'var(--shadow-sm)',
              padding: '20px 22px',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: -11,
                right: 14,
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                padding: '2px 8px',
                background: 'var(--bg)',
                border: '1px solid var(--border-strong)',
                color: 'var(--fg-muted)',
              }}
            >
              preview
            </span>
            <h3 style={{ margin: '0 0 8px', fontSize: 19, fontWeight: 700 }}>In the browser</h3>
            <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.65, color: 'var(--fg-muted)' }}>
              Design is a chat in the dashboard. Describe the agent you want and it writes the
              folder. The build consoles run contained: the one that designs never sees your
              secrets, the one that holds secrets never reaches the internet. When one stalls,
              the files are right there to edit.
            </p>
          </div>
          <div
            style={{
              border: '1px solid var(--border-strong)',
              background: 'var(--bg-elev)',
              boxShadow: 'var(--shadow-sm)',
              padding: '20px 22px',
            }}
          >
            <h3 style={{ margin: '0 0 8px', fontSize: 19, fontWeight: 700 }}>In Claude Code</h3>
            <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.65, color: 'var(--fg-muted)' }}>
              Three skills load Cast&rsquo;s file formats and workflows into a session: <code>/cast-build</code> to author,{' '}
              <code>/cast-refine</code> to grow a running agent, <code>/cast-debug</code> when
              something is off. Full access to your machine, every change through your review.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Receipts() {
  const rows: Array<[string, ComponentChildren]> = [
    ['license', 'MIT, no contributor agreement, no relicensing'],
    ['runs on', 'your Mac or Linux box, Apple Container or Docker'],
    ['model', 'Claude'],
    [
      'source',
      <>
        <a href="https://github.com/yaodub/cast">github.com/yaodub/cast</a>
      </>,
    ],
  ];
  return (
    <section class="y2k-band-ice" style={{ padding: '72px 0' }}>
      <div class="container" style={{ maxWidth: 880 }}>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--fg-subtle)', marginBottom: 12 }}>
          open source
        </div>
        <h2 class="section-h2" style={{ margin: '0 0 14px' }}>
          What you keep.
        </h2>
        <p
          style={{
            fontSize: 16,
            lineHeight: 1.65,
            color: 'var(--fg)',
            margin: '0 0 26px',
            maxWidth: 640,
          }}
        >
          The program, the source, and the folder your agents live in all sit on your disk. If
          this project vanished tomorrow, you would keep all three.
        </p>
        <div style={{ border: '1px solid var(--border-strong)', background: 'var(--bg-elev)' }}>
          {rows.map(([k, val], i) => (
            <div
              key={k}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '4px 18px',
                padding: '12px 16px',
                borderTop: i === 0 ? 'none' : '1px solid var(--border)',
              }}
            >
              <span
                style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 12,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--fg-muted)',
                  minWidth: 90,
                }}
              >
                {k}
              </span>
              <span style={{ fontSize: 14.5, color: 'var(--fg)' }}>{val}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

interface FaqItem {
  q: string;
  a: ComponentChildren;
}

const FAQS: FaqItem[] = [
  {
    q: 'What does it cost?',
    a: 'Cast is free and MIT. You bring an Anthropic API key or a Claude.ai token and pay for what your agents actually use. Agents are event driven, so an idle agent costs nothing.',
  },
  {
    q: 'Who sees my data?',
    a: 'Your machine holds everything: the agents, their memory, their files. When an agent works, what it reads goes into a model call, and that is the only place anything goes. Logins for mail and other doors stay on the host, where the agent cannot read them.',
  },
  {
    q: 'What if an agent gets tricked?',
    a: 'The damage is limited to the access you granted. A hostile email adds text to a conversation and nothing more. It cannot read credentials, cannot message anyone you have not approved, and consequential actions still stop at their approvals.',
  },
  {
    q: 'Is this a coding agent?',
    a: 'It holds the standing jobs around code: point one at your repos and it reads CI, triages issues, and keeps a changelog. For sit-down feature work you would still open Claude Code. The two compose: Claude Code writes your agents, your agents keep watch.',
  },
  {
    q: 'How is this different from the other self-hosted agents?',
    a: 'The walls sit in a different place. Cast puts the agent itself in the container and keeps your logins, tokens, and internet doors outside on the host, so everything the agent touches crosses a door. The trade is real: fewer integrations out of the box, and each one deliberate.',
  },
  {
    q: 'Can other people use my agents?',
    a: 'Yes. Anyone you let in gets their own private conversation with the agent, from Telegram, Slack, or the web. A stranger\u2019s first message waits for your approval, and what each person tells the agent stays in their own thread.',
  },
  {
    q: 'How well does it work, honestly?',
    a: 'The part underneath (containment, identity, routing, scheduling) behaves as documented. The agent layer depends on the model and on your blueprint, and improves with iteration. The browser consoles are the newest surface, and agents are plain files you can edit directly.',
  },
];

function Faq() {
  return (
    <section style={{ padding: '72px 0' }}>
      <div class="container" style={{ maxWidth: 780 }}>
        <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12, fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--fg-subtle)', marginBottom: 12 }}>
          questions
        </div>
        <h2 class="section-h2" style={{ margin: '0 0 28px' }}>
          Common questions.
        </h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {FAQS.map((f, i) => (
            <div
              key={i}
              style={{
                paddingBottom: 22,
                borderBottom: i === FAQS.length - 1 ? 'none' : '1px solid var(--border)',
              }}
            >
              <h3 style={{ fontSize: 17, margin: '0 0 6px', fontWeight: 700 }}>{f.q}</h3>
              <div style={{ fontSize: 15, lineHeight: 1.65, color: 'var(--fg-muted)' }}>{f.a}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section class="y2k-band-yellow" style={{ padding: '84px 0 72px' }}>
      <div class="container-narrow" style={{ textAlign: 'center' }}>
        <h2
          class="section-h2"
          style={{
            margin: '0 0 14px',
            fontSize: 'clamp(32px, 9vw, 46px)',
            letterSpacing: '-0.025em',
            lineHeight: 1.05,
          }}
        >
          Hand one job over.
        </h2>
        <p
          style={{
            fontSize: 16,
            lineHeight: 1.6,
            color: 'var(--fg)',
            maxWidth: 520,
            margin: '0 auto 28px',
          }}
        >
          Clone it, boot it, describe one job in plain English. Let it run for a week, then
          decide what else to give it.
        </p>
        <div style={{ marginBottom: 26 }}>
          <CloneBlock showRequirements={false} />
        </div>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
          <a href="/docs/quickstart" class="btn btn-primary">
            Read the quickstart
          </a>
          <a href="https://github.com/yaodub/cast" class="btn btn-secondary">
            <Github s={14} /> GitHub
          </a>
        </div>
      </div>
    </section>
  );
}

/* ================================================================
   Page
   ================================================================ */

export function Home() {
  return (
    <div>
      <Hero />
      <VerbStrip />
      {JOBS.map((v, i) => (
        <Chapter key={v.id} v={v} index={i} />
      ))}
      <CombineChapter />
      <BuildPaths />
      <Receipts />
      <Faq />
      <FinalCta />
    </div>
  );
}
