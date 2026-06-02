import { CastLockup } from '../brand/CastLockup';
import { Github } from '../brand/Icon';

const REPO = 'https://github.com/yaodub/cast';

type FooterLink = { label: string; href: string };
type FooterColumn = readonly [title: string, links: readonly FooterLink[]];

// Parked for later (uncomment + add when these exist): Changelog, Roadmap,
// API reference index, Discord, Discussions, Blog, Showcase, RFC index,
// Governance, Sponsors, Credits.
const columns: readonly FooterColumn[] = [
  [
    'Product',
    [
      { label: 'Docs', href: '/docs/quickstart' },
      { label: 'Examples', href: '/examples' },
      { label: 'How it works', href: '/how-it-works' },
    ],
  ],
  [
    'Community',
    [
      { label: 'GitHub', href: REPO },
      { label: 'Issues', href: `${REPO}/issues` },
      { label: 'Contribute', href: `${REPO}/blob/main/CONTRIBUTING.md` },
    ],
  ],
  [
    'Project',
    [
      { label: 'License', href: `${REPO}/blob/main/LICENSE` },
      { label: 'Security', href: `${REPO}/blob/main/SECURITY.md` },
      { label: 'Code of conduct', href: `${REPO}/blob/main/CODE_OF_CONDUCT.md` },
    ],
  ],
];

export function Footer() {
  return (
    <footer
      style={{
        borderTop: '1px solid var(--border)',
        marginTop: 120,
        padding: '60px 0 48px',
      }}
    >
      <div
        class="container"
        style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr 1fr 1fr',
          gap: 40,
        }}
      >
        <div>
          <CastLockup size={22} />
          <p style={{ color: 'var(--fg-muted)', fontSize: 13, maxWidth: 280, marginTop: 14 }}>
            An open-source runtime for building and owning your own agents. MIT-licensed.
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 16, color: 'var(--fg-muted)' }}>
            <a href={REPO} class="btn-ghost" style={{ padding: 6, borderRadius: 6 }}>
              <Github s={16} />
            </a>
          </div>
        </div>
        {columns.map(([title, links]) => (
          <div key={title}>
            <div
              style={{
                fontSize: 11,
                fontFamily: 'JetBrains Mono, monospace',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                color: 'var(--fg-subtle)',
                marginBottom: 12,
              }}
            >
              {title}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {links.map((link) => (
                <a
                  key={link.label}
                  href={link.href}
                  style={{ fontSize: 13, color: 'var(--fg-muted)' }}
                >
                  {link.label}
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>
      {/* Zine-only: a single typewriter imprint strip */}
      <div
        class="container zine-only"
        style={{
          marginTop: 36,
          display: 'flex',
          gap: 16,
          alignItems: 'baseline',
          flexWrap: 'wrap',
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11,
          color: 'var(--fg-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        <span>ISSUE Nº 08 · APR 2026</span>
        <span>·</span>
        <span>PRINTED ON RECYCLED BITS</span>
        <span>·</span>
        <span>NOT FOR RESALE</span>
      </div>
      <div
        class="container"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 48,
          paddingTop: 20,
          borderTop: '1px solid var(--border)',
          fontSize: 12,
          color: 'var(--fg-subtle)',
          fontFamily: 'JetBrains Mono, monospace',
        }}
      >
        <span>MIT License © 2026 Cast contributors</span>
        <span>v0.1.0 · alpha</span>
      </div>
    </footer>
  );
}
