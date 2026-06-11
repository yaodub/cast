import { CopyButton } from '../ui/CopyButton';
import { CAST_VERSION } from '../../version';

export function TurboPascalBlock() {
  const kw = { color: 'var(--tp-keyword)', fontWeight: 700 };
  const body = { color: 'var(--tp-body)' };
  const str = { color: 'var(--tp-string)' };
  return (
    <div class="tp-block" style={{ maxWidth: 620, margin: '0 auto 24px' }}>
      <div
        style={{
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 14,
          lineHeight: 1.5,
          textAlign: 'left',
          background: 'var(--tp-bg)',
          color: 'var(--tp-body)',
          border: '1px solid var(--tp-outer)',
          boxShadow: '3px 3px 0 0 var(--tp-shadow)',
          padding: '6px 8px 4px',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            whiteSpace: 'nowrap',
            color: 'var(--tp-border)',
            userSelect: 'none',
            overflow: 'hidden',
          }}
        >
          <span>{'╔════['}</span>
          <span style={{ padding: '0 6px', color: 'var(--tp-title)' }}>{'■'}</span>
          <span style={{ padding: '0 4px' }}>]</span>
          <span style={{ flex: 1, overflow: 'hidden' }}>{'═'.repeat(80)}</span>
          <span style={{ padding: '0 8px', color: 'var(--tp-title)', fontWeight: 700 }}>QUICKSTART</span>
          <span style={{ flex: 1, overflow: 'hidden' }}>{'═'.repeat(80)}</span>
          <span>{'[↑][↓]══╗'}</span>
        </div>
        {/* minmax(0,1fr) lets the code track shrink below its min-content on
            phones; overflow-wrap on the code div then breaks the long URL.
            At the block's 620px max width nothing wraps. */}
        <div style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', gap: '0 14px', padding: '10px 14px 8px' }}>
          <div
            style={{
              color: 'var(--tp-gutter)',
              textAlign: 'right',
              userSelect: 'none',
              whiteSpace: 'pre',
            }}
          >
            {Array.from({ length: 8 }, (_, i) => String(i + 1).padStart(2, '0')).join('\n')}
          </div>
          <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            <div>
              <span style={kw}>program</span>
              <span style={body}> Cast;</span>
            </div>
            <div style={{ color: 'var(--tp-comment)', fontStyle: 'italic' }}>
              {`{ ${CAST_VERSION} · alpha · MIT · self-hosted }`}
            </div>
            <div>
              <span style={kw}>begin</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1 }}>
                <span style={body}>{'  Clone('}</span>
                <span style={str}>{"'git clone https://github.com/yaodub/cast'"}</span>
                <span style={body}>{');'}</span>
              </span>
              <CopyButton text="git clone https://github.com/yaodub/cast.git" />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ flex: 1 }}>
                <span style={body}>{'  Boot('}</span>
                <span style={str}>{"'cd cast && npm i -g pnpm && pnpm start'"}</span>
                <span style={body}>{');'}</span>
              </span>
              <CopyButton text="cd cast && npm i -g pnpm && pnpm start" />
            </div>
            <div>
              <span style={body}>{'  Source('}</span>
              <a
                href="https://github.com/yaodub/cast"
                style={{ color: 'var(--tp-link)', textDecoration: 'underline' }}
              >
                {"'github.com/yaodub/cast'"}
              </a>
              <span style={body}>{');'}</span>
            </div>
            <div>
              <span style={kw}>end</span>
              <span style={body}>.</span>
            </div>
            <div>{' '}</div>
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            whiteSpace: 'nowrap',
            color: 'var(--tp-border)',
            userSelect: 'none',
            overflow: 'hidden',
          }}
        >
          <span>{'╚══════'}</span>
          <span style={{ flex: 1, overflow: 'hidden' }}>{'═'.repeat(80)}</span>
          <span style={{ padding: '0 8px', color: 'var(--tp-title)' }}>8:04</span>
          <span style={{ flex: 1, overflow: 'hidden' }}>{'═'.repeat(80)}</span>
          <span>{'══╝'}</span>
        </div>
      </div>
    </div>
  );
}
