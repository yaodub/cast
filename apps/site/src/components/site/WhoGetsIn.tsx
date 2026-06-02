import type { ComponentType } from 'preact';
import { Lock, Arrow } from '../brand/Icon';

/* ------------------------------------------------------------------ *
 * Full-color brand marks for the connection cards. These intentionally
 * break the monochrome `currentColor` convention of the brand Icon set —
 * the whole point of this section is the pop of color, so each logo keeps
 * its native brand colors. Kept local to the section that uses them.
 * ------------------------------------------------------------------ */

// Telegram's paper plane, shared between the round card logo and the chat
// header avatar (where it's drawn in cyan on a white disc instead).
const TG_PLANE =
  'M180.6 73.4l-22.6 106.6c-1.7 7.5-6.2 9.4-12.5 5.8l-34.5-25.4-16.6 16c-1.8 1.8-3.4 3.4-7 3.4l2.5-35.4 64.5-58.3c2.8-2.5-.6-3.9-4.3-1.4l-79.7 50.2-34.3-10.7c-7.5-2.3-7.6-7.5 1.6-11.1l134-51.6c6.2-2.3 11.6 1.4 9.4 11z';

function TelegramLogo({ s = 30 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 240 240" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <defs>
        <linearGradient id="cast-tg" x1="120" y1="0" x2="120" y2="240" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#2AABEE" />
          <stop offset="1" stop-color="#229ED9" />
        </linearGradient>
      </defs>
      <circle cx="120" cy="120" r="120" fill="url(#cast-tg)" />
      <path fill="#fff" d={TG_PLANE} />
    </svg>
  );
}

function SlackLogo({ s = 28 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 122.8 122.8" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zM32.3 77.6c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z" fill="#E01E5A" />
      <path d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zM45.2 32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z" fill="#36C5F0" />
      <path d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zM90.5 45.2c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z" fill="#2EB67D" />
      <path d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zM77.6 90.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z" fill="#ECB22E" />
    </svg>
  );
}

function WebChatLogo({ s = 28 }: { s?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true" style={{ display: 'block', flexShrink: 0 }}>
      <path
        fill="var(--accent)"
        d="M5 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"
      />
      <circle cx="9" cy="10" r="1.25" fill="#fff" />
      <circle cx="12" cy="10" r="1.25" fill="#fff" />
      <circle cx="15" cy="10" r="1.25" fill="#fff" />
    </svg>
  );
}

interface Transport {
  key: string;
  name: string;
  blurb: string;
  border: string;
  shadow: string;
  Logo: ComponentType<{ s?: number }>;
  native?: boolean;
}

const TRANSPORTS: Transport[] = [
  {
    key: 'telegram',
    name: 'Telegram',
    blurb: 'Message it one-to-one.',
    border: '#229ED9',
    shadow: 'var(--y2k-pink)',
    Logo: TelegramLogo,
  },
  {
    key: 'slack',
    name: 'Slack',
    blurb: 'DM it where your team already lives.',
    border: '#4A154B',
    shadow: 'var(--y2k-pink)',
    Logo: SlackLogo,
  },
  {
    key: 'web',
    name: 'Web chat',
    blurb: 'Built into Cast. Nothing to install.',
    border: 'var(--accent)',
    shadow: 'var(--y2k-pink)',
    Logo: WebChatLogo,
    native: true,
  },
];

function TransportCard({ t }: { t: Transport }) {
  const Logo = t.Logo;
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        background: '#fff',
        border: `2px solid ${t.border}`,
        boxShadow: `4px 4px 0 ${t.shadow}`,
        padding: '13px 16px',
      }}
    >
      <Logo s={30} />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16, fontWeight: 800, color: 'var(--fg)', letterSpacing: '-0.01em' }}>
            {t.name}
          </span>
          {t.native && (
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                color: 'var(--accent)',
                border: '1px solid var(--accent)',
                borderRadius: 3,
                padding: '1px 5px',
                fontFamily: 'JetBrains Mono, monospace',
              }}
            >
              native
            </span>
          )}
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.45, color: 'var(--fg-muted)', marginTop: 2 }}>
          {t.blurb}
        </div>
      </div>
    </div>
  );
}

function MachineCard() {
  return (
    <div
      style={{
        background: '#fff',
        border: '2px solid var(--accent)',
        boxShadow: '4px 4px 0 var(--y2k-pink)',
        padding: '16px 18px',
        minWidth: 210,
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--fg-subtle)',
          fontFamily: 'JetBrains Mono, monospace',
          marginBottom: 10,
        }}
      >
        your machine
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          background: 'var(--bg-sunken)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '9px 12px',
        }}
      >
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#22c55e', flexShrink: 0 }} />
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--fg)' }}>your agent</span>
        <span
          style={{
            fontSize: 11,
            color: 'var(--fg-subtle)',
            fontFamily: 'JetBrains Mono, monospace',
            marginLeft: 'auto',
          }}
        >
          contained
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 10, color: 'var(--accent)' }}>
        <Lock s={14} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--fg-muted)' }}>
          paired in only · you hold the codes
        </span>
      </div>
    </div>
  );
}

function Gate() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--accent)' }}>
        <span style={{ display: 'inline-flex', transform: 'scaleX(-1)' }}>
          <Arrow s={16} />
        </span>
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: '50%',
            border: '2px solid var(--accent)',
            background: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '3px 3px 0 var(--y2k-pink)',
          }}
        >
          <Lock s={18} />
        </div>
        <Arrow s={16} />
      </div>
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--accent)',
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        pairing
      </span>
    </div>
  );
}

interface PairMsg {
  from: 'them' | 'agent';
  text: string;
  mono?: boolean;
}

const PAIR_SCRIPT: PairMsg[] = [
  { from: 'them', text: '/pair', mono: true },
  { from: 'agent', text: "New here. I've flagged you for my operator. Ask them for your code." },
  { from: 'them', text: '/pair 482917', mono: true },
  { from: 'agent', text: 'Paired. Welcome, Sam.' },
];

function PairBubble({ m }: { m: PairMsg }) {
  const out = m.from === 'them';
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
      <div
        style={{
          maxWidth: '82%',
          background: out ? '#EEFFDE' : '#fff',
          border: `1px solid ${out ? '#d4f0bc' : 'var(--border)'}`,
          color: '#1f2937',
          padding: '8px 12px',
          borderRadius: '12px 12px 12px 4px',
          fontSize: m.mono ? 13 : 13.5,
          lineHeight: 1.5,
          fontFamily: m.mono ? 'JetBrains Mono, monospace' : 'inherit',
          fontWeight: m.mono ? 600 : 400,
        }}
      >
        {m.text}
      </div>
    </div>
  );
}

function PairingChat() {
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid var(--border)',
        boxShadow: '4px 4px 0 rgba(34, 158, 217, 0.28)',
        overflow: 'hidden',
        maxWidth: 440,
        width: '100%',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px',
          background: 'linear-gradient(180deg, #2AABEE, #229ED9)',
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: '#fff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <svg width="15" height="15" viewBox="0 0 240 240" aria-hidden="true">
            <path fill="#229ED9" d={TG_PLANE} />
          </svg>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: '#fff' }}>your agent</span>
          <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.85)', fontFamily: 'JetBrains Mono, monospace' }}>
            via Telegram
          </span>
        </div>
      </div>
      <div
        style={{
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: 9,
          background: '#E8F1F8',
        }}
      >
        {PAIR_SCRIPT.map((m, i) => (
          <PairBubble key={i} m={m} />
        ))}
      </div>
    </div>
  );
}

export function WhoGetsIn() {
  return (
    <section class="y2k-band-yellow" style={{ padding: '80px 0' }}>
      <div class="container" style={{ maxWidth: 980 }}>
        <div style={{ marginBottom: 40, maxWidth: 720 }}>
          <div class="badge" style={{ marginBottom: 14 }}>
            Who gets in
          </div>
          <h2 style={{ margin: '0 0 16px', fontSize: 36, letterSpacing: '-0.02em', lineHeight: 1.1 }}>
            Talk to it on Telegram. You pick who else gets in.
          </h2>
          <p style={{ fontSize: 16, lineHeight: 1.7, color: 'var(--fg-muted)', margin: 0 }}>
            Your agent shows up where you already are: a Telegram chat, a Slack DM, or Cast's own
            web chat. It runs contained on your machine, and only the people you pair in get
            through.
          </p>
        </div>

        {/* Doors + the lock that gates them */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 22,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {TRANSPORTS.map((t) => (
              <TransportCard key={t.key} t={t} />
            ))}
          </div>
          <Gate />
          <MachineCard />
        </div>

        {/* The lock, in action */}
        <p
          style={{
            margin: '48px 0 18px',
            textAlign: 'center',
            fontSize: 16,
            lineHeight: 1.6,
            color: 'var(--fg)',
            fontWeight: 600,
          }}
        >
          Pairing is the lock. A short handshake on every transport.
        </p>
        <div style={{ display: 'flex', justifyContent: 'center' }}>
          <PairingChat />
        </div>
        <p
          style={{
            margin: '18px auto 0',
            maxWidth: 460,
            textAlign: 'center',
            fontSize: 14,
            lineHeight: 1.6,
            color: 'var(--fg-muted)',
            fontStyle: 'italic',
          }}
        >
          A stranger without a code never gets in.
        </p>

        <div style={{ marginTop: 44, textAlign: 'center' }}>
          <a href="/docs/use/pairing" style={{ fontSize: 15, fontWeight: 600, color: 'var(--accent)' }}>
            How pairing works →
          </a>
        </div>
      </div>
    </section>
  );
}
