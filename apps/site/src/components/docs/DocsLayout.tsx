import type { ComponentChildren } from 'preact';
import { Fragment } from 'preact';
import { Sidebar } from './Sidebar';
import { TOC, type TOCItem, slugify } from './TOC';
import { PrevNext } from './PrevNext';
import { Chevron } from '../brand/Icon';
import { neighbors } from '../../routes/docs/sidebar';

interface Props {
  url: string;
  crumbs: string[];
  title: string;
  lede: ComponentChildren;
  toc: TOCItem[];
  children: ComponentChildren;
}

export function DocsLayout({ url, crumbs, title, lede, toc, children }: Props) {
  const { prev, next } = neighbors(url);

  return (
    <div
      class="container"
      style={{ display: 'flex', gap: 36, minHeight: 'calc(100vh - 60px)' }}
    >
      <Sidebar />

      <main style={{ flex: 1, padding: '40px 0', minWidth: 0, maxWidth: 760 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
            color: 'var(--fg-muted)',
            marginBottom: 20,
            fontFamily: 'JetBrains Mono, monospace',
          }}
        >
          {crumbs.map((c, i) => (
            <Fragment key={i}>
              {i > 0 && <Chevron s={12} />}
              <span style={i === crumbs.length - 1 ? { color: 'var(--fg)' } : undefined}>{c}</span>
            </Fragment>
          ))}
        </div>

        <h1
          style={{
            fontSize: 42,
            letterSpacing: '-0.03em',
            fontWeight: 600,
            margin: '0 0 12px',
            lineHeight: 1.1,
          }}
        >
          {title}
        </h1>
        <p
          style={{
            fontSize: 17,
            color: 'var(--fg-muted)',
            margin: '0 0 36px',
            lineHeight: 1.55,
          }}
        >
          {lede}
        </p>

        <div class="docs-prose">{children}</div>

        <PrevNext prev={prev} next={next} />
      </main>

      <TOC items={toc} />
    </div>
  );
}

/* Shared prose-style helpers used by the docs MDX-equivalent .tsx files. */

export const proseP: import('preact').JSX.CSSProperties = {
  color: 'var(--fg)',
  lineHeight: 1.7,
  fontSize: 15.5,
  margin: '0 0 18px',
};

export const proseH2: import('preact').JSX.CSSProperties = {
  fontSize: 24,
  letterSpacing: '-0.02em',
  fontWeight: 600,
  margin: '36px 0 14px',
  scrollMarginTop: 80,
};

export const proseH3: import('preact').JSX.CSSProperties = {
  fontSize: 17,
  letterSpacing: '-0.01em',
  fontWeight: 600,
  margin: '26px 0 10px',
};

export const proseUl: import('preact').JSX.CSSProperties = {
  color: 'var(--fg)',
  lineHeight: 1.75,
  paddingLeft: 22,
  margin: '0 0 18px',
  fontSize: 15,
};

export const proseTable: import('preact').JSX.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  margin: '4px 0 22px',
  fontSize: 14,
};

export const proseTh: import('preact').JSX.CSSProperties = {
  fontWeight: 600,
  fontSize: 13,
  background: 'var(--bg-elev)',
  textAlign: 'left',
  padding: '7px 12px',
  borderBottom: '1px solid var(--border-strong)',
};

export const proseTd: import('preact').JSX.CSSProperties = {
  padding: '7px 12px',
  borderBottom: '1px solid var(--border)',
};

/* Mono cell styles for tables whose cell value *is* an identifier, type, or
 * signature — render the cell itself in mono rather than wrapping the value in
 * a superfluous <code>. (Reserve inline <code> for code embedded inside a
 * sentence.) Plain cell wrapping applies, so long signatures break naturally
 * instead of forcing the column wide. */
export const monoTd: import('preact').JSX.CSSProperties = {
  ...proseTd,
  fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
};

export const monoTdMuted: import('preact').JSX.CSSProperties = {
  ...monoTd,
  color: 'var(--fg-muted)',
};

/* Heading components that auto-derive an id from their string children, so TOC
 * anchor links (which slugify their label the same way) actually resolve to a
 * scroll target. Pass `id` to override the derived slug. */

export function H2({ children, id }: { children: string; id?: string }) {
  return (
    <h2 id={id ?? slugify(children)} style={proseH2}>
      {children}
    </h2>
  );
}

export function H3({ children, id }: { children: string; id?: string }) {
  return (
    <h3 id={id ?? slugify(children)} style={proseH3}>
      {children}
    </h3>
  );
}
