import { Github } from '../brand/Icon';

export interface TOCItem {
  label: string;
  href?: string;
}

interface Props {
  items: TOCItem[];
  editUrl?: string;
}

export function TOC({ items, editUrl }: Props) {
  return (
    <aside
      style={{
        width: 200,
        flexShrink: 0,
        position: 'sticky',
        top: 60,
        alignSelf: 'flex-start',
        padding: '32px 0 32px 24px',
        maxHeight: 'calc(100vh - 60px)',
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontFamily: 'JetBrains Mono, monospace',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--fg-subtle)',
          marginBottom: 12,
        }}
      >
        On this page
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {items.map((item, i) => (
          <a
            key={i}
            href={item.href ?? `#${slugify(item.label)}`}
            style={{
              fontSize: 13,
              color: i === 0 ? 'var(--accent)' : 'var(--fg-muted)',
            }}
          >
            {item.label}
          </a>
        ))}
      </div>
      {editUrl && (
        <>
          <hr class="rule" style={{ margin: '20px 0' }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 12 }}>
            <a
              href={editUrl}
              style={{
                color: 'var(--fg-muted)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <Github s={12} /> Edit on GitHub
            </a>
          </div>
        </>
      )}
    </aside>
  );
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

export { slugify };
