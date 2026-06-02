import type { ComponentChildren } from 'preact';
import { proseH3 } from './DocsLayout';

/**
 * FileSpec — standardized "this file: what format, what role" block.
 *
 * Renders the filename as a plain h3 (no code styling), a small uppercase
 * mono meta line ("MARKDOWN · RAW", "JSON · CHANNEL CONFIGURATION") right
 * under it, then arbitrary body content. Used across the build pages so
 * the per-file rhythm is consistent.
 */
export function FileSpec({
  name,
  meta,
  children,
}: {
  name: string;
  meta: string;
  children: ComponentChildren;
}) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h3 style={{ ...proseH3, marginBottom: 4 }}>{name}</h3>
      <div
        style={{
          fontSize: 11,
          fontFamily: 'JetBrains Mono, monospace',
          color: 'var(--fg-subtle)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          marginBottom: 12,
        }}
      >
        {meta}
      </div>
      {children}
    </div>
  );
}
