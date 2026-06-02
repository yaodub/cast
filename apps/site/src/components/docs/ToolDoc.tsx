import type { ComponentChildren } from 'preact';

export interface ToolParam {
  name: string;
  type: string;
  required?: boolean;
  default?: string;
  desc: ComponentChildren;
}

export interface ToolReturn {
  /** Literal return text — pre-formatted, can be multi-line. Rendered in a code box. */
  value: string;
  /** Optional condition — when this case is returned. */
  when?: ComponentChildren;
}

export interface ToolDocProps {
  name: string;
  summary: ComponentChildren;
  /** Override the auto-derived signature (used for wire tags). */
  signature?: string;
  /** 'tool' = MCP tool (coral border), 'tag' = wire/stdio tag (amber border). */
  kind?: 'tool' | 'tag';
  params?: ToolParam[];
  returns?: ToolReturn[];
  notes?: ComponentChildren;
}

const mono = "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace";

const TOOL_BORDER = '#E63946';
const TAG_BORDER = '#F4C430';

function buildInlineSignature(name: string, params?: ToolParam[]): string {
  if (!params || params.length === 0) return `${name}()`;
  const parts = params.map((p) => `${p.name}${p.required ? '' : '?'}`);
  return `${name}(${parts.join(', ')})`;
}

function typeInfo(p: ToolParam): string {
  if (p.default !== undefined) return `${p.type}, default ${p.default}`;
  return p.type;
}

const paramPill: import('preact').JSX.CSSProperties = {
  fontFamily: mono,
  background: 'color-mix(in srgb, var(--fg) 5%, transparent)',
  padding: '1px 6px',
  borderRadius: 3,
  color: 'var(--fg)',
};

const codeBox: import('preact').JSX.CSSProperties = {
  fontFamily: mono,
  fontSize: 13,
  lineHeight: 1.55,
  background: 'color-mix(in srgb, var(--fg) 4%, transparent)',
  border: '1px solid color-mix(in srgb, var(--fg) 10%, transparent)',
  padding: '8px 12px',
  margin: 0,
  whiteSpace: 'pre',
  overflowX: 'auto',
  color: 'var(--fg)',
  display: 'block',
};

const subheading: import('preact').JSX.CSSProperties = {
  margin: '24px 0 12px',
  fontSize: 16,
  fontWeight: 600,
  color: 'var(--fg)',
};

const monoInline: import('preact').JSX.CSSProperties = {
  fontFamily: mono,
  fontSize: 13.5,
};

export function ToolDoc(props: ToolDocProps) {
  const sig = props.signature ?? buildInlineSignature(props.name, props.params);
  const hasParams = (props.params?.length ?? 0) > 0;
  const hasReturns = (props.returns?.length ?? 0) > 0;
  const borderColor = props.kind === 'tag' ? TAG_BORDER : TOOL_BORDER;

  return (
    <div style={{ margin: '40px 0 0', paddingTop: 32, borderTop: '1px solid var(--border)' }}>
      <h3
        id={props.name}
        class="mono"
        style={{
          margin: '0 0 16px',
          fontFamily: mono,
          fontSize: 20,
          fontWeight: 500,
          lineHeight: 1.45,
          letterSpacing: '-0.01em',
          color: 'var(--fg)',
          background: 'color-mix(in srgb, var(--fg) 4%, transparent)',
          borderLeft: `3px solid ${borderColor}`,
          padding: '12px 16px',
          borderRadius: 0,
          scrollMarginTop: 80,
          whiteSpace: 'pre',
          overflowX: 'auto',
        }}
      >
        {sig}
      </h3>

      <p style={{ fontSize: 15, lineHeight: 1.65, color: 'var(--fg)', margin: '0 0 8px' }}>
        {props.summary}
      </p>

      {hasParams && (
        <>
          <h4 style={subheading}>Parameters</h4>
          <ul style={{ margin: '0 0 8px', padding: '0 0 0 22px', listStyle: 'disc' }}>
            {props.params!.map((p) => (
              <li key={p.name} style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--fg)', margin: '0 0 6px' }}>
                {!p.required && <span style={{ color: 'var(--fg-subtle)', fontWeight: 500 }}>optional </span>}
                <code style={{ ...paramPill, fontSize: 13.5 }}>{p.name}</code>
                <span style={{ color: 'var(--fg-muted)', fontSize: 14, margin: '0 8px' }}>[{typeInfo(p)}]</span>
                {p.desc}
              </li>
            ))}
          </ul>
        </>
      )}

      {hasReturns && (
        <>
          <h4 style={subheading}>Returns</h4>
          <div style={{ margin: '0 0 8px' }}>
            {props.returns!.map((r, i) => (
              <div key={i} style={{ margin: '0 0 14px' }}>
                <pre class="mono" style={codeBox}>{r.value}</pre>
                {r.when && (
                  <div style={{ color: 'var(--fg-muted)', fontSize: 14, marginTop: 4, paddingLeft: 12 }}>
                    when {r.when}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {props.notes && (
        <>
          <h4 style={subheading}>Caveats</h4>
          <p style={{ fontSize: 15, lineHeight: 1.65, color: 'var(--fg)', margin: 0 }}>
            {props.notes}
          </p>
        </>
      )}
    </div>
  );
}

/** Inline mono span — use for cast:* tag references embedded in prose. */
export function M({ children }: { children: ComponentChildren }) {
  return <span style={monoInline}>{children}</span>;
}
