import { Fragment } from 'preact';
import { useLocation, useRoute } from 'preact-iso';
import { Chevron } from '../../components/brand/Icon';
import { proseH2 } from '../../components/docs/DocsLayout';
import { hiwPillars, hiwDeep } from './data';
import { HIWIndex } from './Index';

export function HIWDeep() {
  const { route } = useLocation();
  const { params } = useRoute();
  const slug = params.slug ?? '';
  const data = hiwDeep[slug];
  if (!data) return <HIWIndex />;
  const i = hiwPillars.findIndex((p) => p.slug === slug);
  const prev = i > 0 ? hiwPillars[i - 1]! : null;
  const next = i < hiwPillars.length - 1 ? hiwPillars[i + 1]! : null;

  return (
    <div class="container" style={{ padding: '40px 0 80px', maxWidth: 880 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 12,
          color: 'var(--fg-muted)',
          marginBottom: 22,
          fontFamily: 'JetBrains Mono, monospace',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        <a
          href="/how-it-works"
          onClick={(e) => {
            e.preventDefault();
            route('/how-it-works');
          }}
          style={{ color: 'var(--fg-muted)' }}
        >
          how it works
        </a>
        <Chevron s={11} />
        <span style={{ color: 'var(--fg)' }}>{slug}</span>
      </div>

      <h1
        style={{ margin: '0 0 14px', fontSize: 44, letterSpacing: '-0.025em', lineHeight: 1.05 }}
      >
        {data.title}
      </h1>
      <p
        style={{
          fontSize: 19,
          color: 'var(--fg-muted)',
          lineHeight: 1.5,
          margin: '0 0 36px',
        }}
      >
        {data.lede}
      </p>

      {data.sections.map((s, idx) => (
        <Fragment key={idx}>
          <h2 style={proseH2}>{s.h2}</h2>
          {s.body}
        </Fragment>
      ))}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 16,
          marginTop: 56,
        }}
      >
        {prev ? (
          <button
            onClick={() => route(`/how-it-works/${prev.slug}`)}
            style={{
              padding: 18,
              border: '1px solid var(--border)',
              borderRadius: 6,
              display: 'block',
              textAlign: 'left',
              background: 'var(--bg)',
              cursor: 'pointer',
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: 'var(--fg-subtle)',
                fontFamily: 'JetBrains Mono, monospace',
                marginBottom: 4,
              }}
            >
              ← PREVIOUS
            </div>
            <div style={{ fontSize: 15, fontWeight: 500 }}>{prev.pillar}</div>
          </button>
        ) : (
          <span />
        )}
        {next ? (
          <button
            onClick={() => route(`/how-it-works/${next.slug}`)}
            style={{
              padding: 18,
              border: '1px solid var(--border)',
              borderRadius: 6,
              display: 'block',
              textAlign: 'right',
              background: 'var(--bg)',
              cursor: 'pointer',
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: 'var(--fg-subtle)',
                fontFamily: 'JetBrains Mono, monospace',
                marginBottom: 4,
              }}
            >
              NEXT →
            </div>
            <div style={{ fontSize: 15, fontWeight: 500 }}>{next.pillar}</div>
          </button>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}
