import { useLocation } from 'preact-iso';
import { useState } from 'preact/hooks';
import { CastLockup } from '../brand/CastLockup';
import { Github } from '../brand/Icon';

const TABS: ReadonlyArray<readonly [path: string, label: string, external?: boolean]> = [
  ['/how-it-works', 'How it works'],
  ['/examples', 'Examples'],
  ['/docs', 'Docs'],
  ['https://blog.getcast.dev', 'Blog', true],
];

export function NavBar() {
  const { url, route } = useLocation();
  // Mobile: tabs collapse into a dropdown under the bar.
  const [menuOpen, setMenuOpen] = useState(false);
  const go = (path: string) => {
    route(path);
    setMenuOpen(false);
  };

  return (
    <nav
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 50,
        background: 'color-mix(in oklab, var(--bg) 85%, transparent)',
        backdropFilter: 'blur(10px)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div
        class="container nav-row"
        style={{ display: 'flex', alignItems: 'center', height: 60 }}
      >
        <button
          onClick={() => route('/')}
          style={{ display: 'flex', alignItems: 'center' }}
        >
          <CastLockup size={22} />
          <span class="badge" style={{ marginLeft: 12, fontSize: 10 }}>
            alpha
          </span>
        </button>
        <div class="nav-tabs">
          {TABS.map(([path, label, external]) => {
            const active = !external && (url === path || url.startsWith(path + '/'));
            const style = {
              borderRadius: 6,
              color: active ? 'var(--fg)' : 'var(--fg-muted)',
              fontWeight: active ? 500 : 400,
              textDecoration: 'none', // the Blog tab is an <a>; keep it un-underlined like the buttons
            };
            return external ? (
              <a key={path} class="nav-tab" href={path} style={style}>
                {label}
              </a>
            ) : (
              <button key={path} class="nav-tab" onClick={() => route(path)} style={style}>
                {label}
              </button>
            );
          })}
        </div>
        <div class="nav-right" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <a
            href="https://github.com/yaodub/cast"
            class="btn btn-secondary"
            style={{ padding: '7px 12px', fontSize: 13 }}
          >
            <Github s={14} /> <span class="nav-gh-label">GitHub</span>
          </a>
          <button
            class="nav-menu-btn"
            aria-label="Toggle navigation menu"
            onClick={() => setMenuOpen((o) => !o)}
          >
            ☰
          </button>
        </div>
      </div>
      {menuOpen && (
        <div class="nav-dropdown">
          {TABS.map(([path, label, external]) => {
            const active = !external && (url === path || url.startsWith(path + '/'));
            const style = {
              color: active ? 'var(--fg)' : 'var(--fg-muted)',
              fontWeight: active ? 500 : 400,
              textDecoration: 'none', // Blog is an <a> in the dropdown; match the buttons
            };
            return external ? (
              <a key={path} href={path} style={style} onClick={() => setMenuOpen(false)}>
                {label}
              </a>
            ) : (
              <button key={path} onClick={() => go(path)} style={style}>
                {label}
              </button>
            );
          })}
        </div>
      )}
    </nav>
  );
}
