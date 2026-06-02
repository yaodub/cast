import { useLocation } from 'preact-iso';
import {
  hiwPillars,
  type HIWThumb,
  ThumbFolderSvg,
  ThumbReachSvg,
  ThumbChannelsSvg,
  ThumbPeersSvg,
} from './data';

export function HIWIndex() {
  const { route } = useLocation();
  return (
    <div class="container" style={{ padding: '60px 0 80px', maxWidth: 1000 }}>
      <div style={{ marginBottom: 36, maxWidth: 720 }}>
        <div class="badge" style={{ marginBottom: 14 }}>
          How it works
        </div>
        <h1
          style={{
            margin: '0 0 14px',
            fontSize: 44,
            letterSpacing: '-0.025em',
            lineHeight: 1.05,
          }}
        >
          The four claims, made concrete.
        </h1>
        <p
          style={{
            fontSize: 17,
            color: 'var(--fg-muted)',
            maxWidth: 640,
            lineHeight: 1.55,
            margin: 0,
            fontStyle: 'italic',
          }}
        >
          You draw the lines. The harness holds them. The agent has no path around them. Here's
          how that works, on four axes.
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        {hiwPillars.map((p, i) => (
          <a
            key={p.slug}
            class="card-link"
            href={`/how-it-works/${p.slug}`}
            onClick={(e) => {
              e.preventDefault();
              route(`/how-it-works/${p.slug}`);
            }}
            style={{
              padding: '28px 32px',
              display: 'grid',
              gridTemplateColumns: '1.5fr 1fr',
              gap: 32,
              alignItems: 'stretch',
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--bg)',
              transition: 'border-color 120ms ease',
            }}
          >
            <div>
              <div
                style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 11,
                  color: 'var(--accent)',
                  letterSpacing: '0.08em',
                  textTransform: 'uppercase',
                  marginBottom: 10,
                }}
              >
                Pillar {String(i + 1).padStart(2, '0')}
              </div>
              <h2
                style={{
                  margin: '0 0 14px',
                  fontSize: 26,
                  letterSpacing: '-0.015em',
                  fontWeight: 700,
                  lineHeight: 1.15,
                }}
              >
                {p.pillar}
              </h2>
              {p.blurb.map((para, idx) => (
                <p
                  key={idx}
                  style={{
                    margin: idx === p.blurb.length - 1 ? '0 0 14px' : '0 0 12px',
                    fontSize: 15,
                    color: 'var(--fg-muted)',
                    lineHeight: 1.6,
                  }}
                >
                  {para}
                </p>
              ))}
              <span style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 500 }}>
                Read more →
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                height: '100%',
                width: '100%',
              }}
            >
              <ThumbBody kind={p.thumb} />
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

function ThumbBody({ kind }: { kind: HIWThumb }) {
  if (kind === 'folder') return <ThumbFolderSvg />;
  if (kind === 'reach') return <ThumbReachSvg />;
  if (kind === 'channels') return <ThumbChannelsSvg />;
  return <ThumbPeersSvg />;
}
