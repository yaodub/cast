import { useLocation, useRoute } from 'preact-iso';
import { Chevron, Arrow } from '../../components/brand/Icon';
import { Placeholder } from '../../components/site/Placeholder';
import { ChatMockup } from '../../components/site/ChatMockup';
import {
  proseP,
  proseH2,
  proseTable,
  proseTd,
} from '../../components/docs/DocsLayout';
import { findExample, exampleNeighbors } from './data';
import { exampleScripts, buildSections } from './scripts';
import { ExamplesIndex } from './Index';

export function ExamplesStory() {
  const { route } = useLocation();
  const { params } = useRoute();
  const slug = params.slug ?? '';
  const ex = findExample(slug);
  if (!ex) return <ExamplesIndex />;
  const { prev, next } = exampleNeighbors(slug);

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
          href="/examples"
          onClick={(e) => {
            e.preventDefault();
            route('/examples');
          }}
          style={{ color: 'var(--fg-muted)' }}
        >
          examples
        </a>
        <Chevron s={11} />
        <span style={{ color: 'var(--fg)' }}>{slug}</span>
      </div>

      <div style={{ marginBottom: 32 }}>
        <div
          style={{
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: 'var(--accent)',
            marginBottom: 12,
          }}
        >
          {ex.audience}
        </div>
        <h1
          style={{
            margin: '0 0 14px',
            fontSize: 44,
            letterSpacing: '-0.025em',
            lineHeight: 1.05,
          }}
        >
          {ex.name}
        </h1>
        <p
          style={{
            fontSize: 19,
            color: 'var(--fg-muted)',
            lineHeight: 1.5,
            margin: 0,
          }}
        >
          {ex.pitch}
        </p>
      </div>

      {exampleScripts[slug] ? (
        <ChatMockup agentName={slug} script={exampleScripts[slug]!} />
      ) : (
        <Placeholder label={`${ex.name.toLowerCase()} · hero conversation`} ratio="16 / 9" />
      )}

      <h2 style={proseH2}>The situation</h2>
      <p style={proseP}>{ex.situation}</p>

      <h2 style={proseH2}>How it behaves</h2>
      {ex.shape.lead && <p style={proseP}>{ex.shape.lead}</p>}
      <ul style={{ ...proseP, paddingLeft: 22, marginTop: 8 }}>
        {ex.shape.parts.map((p, i) => (
          <li key={i} style={{ marginBottom: 8 }}>
            <strong>{p.name}</strong> — {p.desc}
          </li>
        ))}
      </ul>
      {ex.shape.closing && <p style={proseP}>{ex.shape.closing}</p>}

      {buildSections[slug] && (
        <>
          <h2 style={proseH2}>How you'd build it</h2>
          {buildSections[slug]!.map((section, i) => (
            <div key={i} style={{ marginBottom: 28 }}>
              <h3
                style={{
                  margin: '32px 0 14px',
                  fontSize: 20,
                  fontWeight: 600,
                  letterSpacing: '-0.012em',
                  lineHeight: 1.3,
                }}
              >
                {section.heading}
              </h3>
              <ChatMockup agentName={slug} script={section.pair} />
              <p style={proseP}>{section.prose}</p>
            </div>
          ))}
        </>
      )}

      <h2 style={proseH2}>What stays separate</h2>
      <p style={proseP}>{ex.denial}</p>

      <h2 style={proseH2}>What's in the box</h2>
      <table style={proseTable}>
        <tbody>
          <tr>
            <td style={{ ...proseTd, width: '30%' }}>Extensions</td>
            <td style={proseTd}>{ex.extensions.join(', ')}</td>
          </tr>
          <tr>
            <td style={proseTd}>Transports</td>
            <td style={proseTd}>{ex.transports.join(', ')}</td>
          </tr>
          <tr>
            <td style={proseTd}>Scheduled jobs</td>
            <td style={proseTd}>{ex.cron}</td>
          </tr>
          <tr>
            <td style={proseTd}>Blueprint highlight</td>
            <td style={proseTd}>{ex.blueprintHighlight}</td>
          </tr>
        </tbody>
      </table>

      <div
        style={{
          marginTop: 40,
          padding: '28px 32px',
          border: '1px solid var(--border)',
          borderRadius: 8,
          background: 'var(--bg-elev)',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 6 }}>Build it yourself</div>
        <p
          style={{
            fontSize: 14,
            color: 'var(--fg-muted)',
            margin: '0 0 16px',
          }}
        >
          Install Cast, then describe this in the admin chat. The Design agent writes the agents,
          conversations, and ACL for you. The extensions you'd need are listed above.
        </p>
        <button
          onClick={() => route('/docs/quickstart')}
          class="btn btn-primary"
        >
          Install Cast <Arrow s={12} />
        </button>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 16,
          marginTop: 40,
        }}
      >
        {prev ? (
          <button
            onClick={() => route(`/examples/${prev.slug}`)}
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
            <div style={{ fontSize: 15, fontWeight: 500 }}>{prev.name}</div>
          </button>
        ) : (
          <span />
        )}
        {next ? (
          <button
            onClick={() => route(`/examples/${next.slug}`)}
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
            <div style={{ fontSize: 15, fontWeight: 500 }}>{next.name}</div>
          </button>
        ) : (
          <span />
        )}
      </div>
    </div>
  );
}
