import { useLocation } from 'preact-iso';
import { Arrow } from '../../components/brand/Icon';
import { ChatMockup } from '../../components/site/ChatMockup';
import { examples } from './data';
import { exampleScripts } from './scripts';

export function ExamplesIndex() {
  const { route } = useLocation();
  return (
    <div class="container" style={{ padding: '60px 0 80px', maxWidth: 1080 }}>
      <div style={{ marginBottom: 36 }}>
        <div class="badge coral" style={{ marginBottom: 14 }}>
          Examples
        </div>
        <h1
          style={{
            margin: '0 0 14px',
            fontSize: 44,
            letterSpacing: '-0.025em',
            lineHeight: 1.05,
          }}
        >
          Four worked examples.
        </h1>
        <p
          style={{
            fontSize: 17,
            color: 'var(--fg-muted)',
            maxWidth: 640,
            lineHeight: 1.55,
            margin: 0,
          }}
        >
          Cast ships empty. You bring the description; the Design agent builds the agent. These
          four are patterns the Design agent knows how to build — walked through end-to-end so you can see
          how the moving parts fit.
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 20,
        }}
      >
        {examples.map((ex) => (
          <a
            key={ex.slug}
            class="card-link"
            href={`/examples/${ex.slug}`}
            onClick={(e) => {
              e.preventDefault();
              route(`/examples/${ex.slug}`);
            }}
            style={{
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              overflow: 'hidden',
              cursor: 'pointer',
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--bg)',
            }}
          >
            <div
              style={{
                position: 'relative',
                aspectRatio: '16 / 9',
                overflow: 'hidden',
                borderBottom: '1px solid var(--border)',
                background: 'var(--y2k-amber-bg)',
              }}
            >
              <div
                style={{
                  position: 'absolute',
                  top: 22,
                  left: 22,
                  right: 22,
                  bottom: 0,
                  borderRadius: '10px 10px 0 0',
                  overflow: 'hidden',
                  background: 'var(--bg-elev)',
                  borderTop: '1px solid var(--border)',
                  borderLeft: '1px solid var(--border)',
                  borderRight: '1px solid var(--border)',
                  boxShadow:
                    '0 -8px 32px -10px color-mix(in oklab, var(--y2k-ink) 22%, transparent), 0 4px 14px -4px color-mix(in oklab, var(--y2k-ink) 14%, transparent)',
                }}
              >
                {exampleScripts[ex.slug] ? (
                  <ChatMockup
                    agentName={ex.slug}
                    script={exampleScripts[ex.slug]!}
                    compact
                  />
                ) : (
                  <div
                    style={{
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: 12,
                      color: 'var(--fg-subtle)',
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                    }}
                  >
                    [ {ex.name.toLowerCase()} · preview ]
                  </div>
                )}
              </div>
            </div>
            <div style={{ padding: '22px 24px 24px' }}>
              <div
                style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--accent)',
                  marginBottom: 10,
                }}
              >
                {ex.audience}
              </div>
              <h3
                style={{
                  margin: '0 0 10px',
                  fontSize: 22,
                  fontWeight: 700,
                  letterSpacing: '-0.015em',
                }}
              >
                {ex.name}
              </h3>
              <p
                style={{
                  margin: '0 0 14px',
                  fontSize: 14.5,
                  color: 'var(--fg-muted)',
                  lineHeight: 1.6,
                }}
              >
                {ex.pitch}
              </p>
              <span style={{ fontSize: 13, color: 'var(--accent)', fontWeight: 500 }}>
                Read the walkthrough →
              </span>
            </div>
          </a>
        ))}
      </div>

      <div
        style={{
          marginTop: 60,
          padding: '28px 32px',
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--bg-elev)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 16,
        }}
      >
        <div>
          <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>
            Want to build your own?
          </div>
          <div style={{ fontSize: 14, color: 'var(--fg-muted)' }}>
            Five-minute install, then describe what you want and the Design agent writes the
            blueprint.
          </div>
        </div>
        <button
          onClick={() => route('/docs/quickstart')}
          class="btn btn-primary"
        >
          Get started <Arrow s={12} />
        </button>
      </div>
    </div>
  );
}
