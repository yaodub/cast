import { useLocation } from 'preact-iso';
import { CastLockup } from '../brand/CastLockup';
import { Github } from '../brand/Icon';

const TABS: ReadonlyArray<readonly [path: string, label: string]> = [
  ['/how-it-works', 'How it works'],
  ['/examples', 'Examples'],
  ['/docs', 'Docs'],
];

export function NavBar() {
  const { url, route } = useLocation();

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
        class="container"
        style={{ display: 'flex', alignItems: 'center', height: 60, gap: 32 }}
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
        <div style={{ display: 'flex', gap: 4, flex: 1 }}>
          {TABS.map(([path, label]) => {
            const active = url === path || url.startsWith(path + '/');
            return (
              <button
                key={path}
                onClick={() => route(path)}
                style={{
                  padding: '8px 12px',
                  borderRadius: 6,
                  fontSize: 14,
                  color: active ? 'var(--fg)' : 'var(--fg-muted)',
                  fontWeight: active ? 500 : 400,
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <a
            href="https://github.com/yaodub/cast"
            class="btn btn-secondary"
            style={{ padding: '7px 12px', fontSize: 13 }}
          >
            <Github s={14} /> GitHub
          </a>
        </div>
      </div>
    </nav>
  );
}
