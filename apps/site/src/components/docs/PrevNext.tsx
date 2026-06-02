import { useLocation } from 'preact-iso';
import type { DocPage } from '../../routes/docs/sidebar';

interface Props {
  prev: DocPage | null;
  next: DocPage | null;
}

export function PrevNext({ prev, next }: Props) {
  const { route } = useLocation();
  return (
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
          onClick={() => route(prev.url)}
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
          <div style={{ fontSize: 15, fontWeight: 500 }}>{prev.label}</div>
        </button>
      ) : (
        <span />
      )}
      {next ? (
        <button
          onClick={() => route(next.url)}
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
          <div style={{ fontSize: 15, fontWeight: 500 }}>{next.label}</div>
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}
