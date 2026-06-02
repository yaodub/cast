import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';

interface TabItem {
  id: string;
  label: ComponentChildren;
  content: ComponentChildren;
}

/**
 * Docs tab switcher. Both panels render into the DOM (inactive ones carry
 * the `hidden` attribute) so all content lives in the prerendered HTML —
 * searchable and present without JS; the tab bar just toggles visibility
 * once hydrated.
 */
export function Tabs({ tabs }: { tabs: TabItem[] }) {
  const [active, setActive] = useState(0);
  return (
    <div style={{ margin: '8px 0 24px' }}>
      <div
        role="tablist"
        style={{
          display: 'flex',
          gap: 4,
          borderBottom: '1px solid var(--border)',
          marginBottom: 20,
        }}
      >
        {tabs.map((t, i) => {
          const on = i === active;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={on}
              onClick={() => setActive(i)}
              style={{
                appearance: 'none',
                border: 'none',
                background: 'none',
                cursor: 'pointer',
                padding: '8px 14px',
                fontSize: 14,
                fontWeight: 600,
                fontFamily: 'inherit',
                color: on ? 'var(--fg)' : 'var(--fg-subtle)',
                borderBottom: on ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -1,
                transition: 'color 0.12s',
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {tabs.map((t, i) => (
        <div key={t.id} role="tabpanel" hidden={i !== active}>
          {t.content}
        </div>
      ))}
    </div>
  );
}
