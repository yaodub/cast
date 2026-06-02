import { useLocation } from 'preact-iso';
import { useEffect, useRef, useState } from 'preact/hooks';
import { docsSections, type DocPage } from '../../routes/docs/sidebar';

// Height of the fade applied at whichever edge has more content scrolled past it.
const FADE = 52;

export function Sidebar() {
  const { url, route } = useLocation();
  const ref = useRef<HTMLElement>(null);
  const [fadeTop, setFadeTop] = useState(false);
  const [fadeBottom, setFadeBottom] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      setFadeTop(scrollTop > 1);
      setFadeBottom(scrollTop + clientHeight < scrollHeight - 1);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, []);

  const topStop = fadeTop ? `${FADE}px` : '0';
  const bottomStop = fadeBottom ? `calc(100% - ${FADE}px)` : '100%';
  const maskImage = `linear-gradient(to bottom, ${fadeTop ? 'transparent' : 'black'} 0, black ${topStop}, black ${bottomStop}, ${fadeBottom ? 'transparent' : 'black'} 100%)`;

  return (
    <aside
      ref={ref}
      class="no-scrollbar"
      style={{
        width: 240,
        flexShrink: 0,
        position: 'sticky',
        top: 60,
        alignSelf: 'flex-start',
        maxHeight: 'calc(100vh - 60px)',
        overflowY: 'auto',
        padding: '32px 8px 32px 0',
        borderRight: '1px solid var(--border)',
        maskImage,
        WebkitMaskImage: maskImage,
      }}
    >
      {docsSections.map((section) => (
        <div key={section.title} style={{ marginBottom: 22 }}>
          <div
            style={{
              fontSize: 11,
              fontFamily: 'JetBrains Mono, monospace',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              color: 'var(--fg-subtle)',
              padding: '0 12px 8px',
            }}
          >
            {section.title}
          </div>
          {section.items.map((item) => (
            <SidebarItem key={item.url} item={item} currentUrl={url} route={route} />
          ))}
        </div>
      ))}
    </aside>
  );
}

function SidebarItem({
  item,
  currentUrl,
  route,
  indent = 0,
}: {
  item: DocPage;
  currentUrl: string;
  route: (url: string) => void;
  indent?: number;
}) {
  const active = currentUrl === item.url;
  const inSection =
    !!item.children && (currentUrl === item.url || currentUrl.startsWith(item.url + '/'));

  return (
    <>
      <button
        onClick={() => route(item.url)}
        style={{
          display: 'block',
          width: '100%',
          textAlign: 'left',
          padding: '6px 12px',
          paddingLeft: 12 + indent,
          borderRadius: 6,
          fontSize: 13.5,
          color: active ? 'var(--fg)' : 'var(--fg-muted)',
          fontWeight: active ? 500 : 400,
          background: active ? 'var(--accent-soft)' : 'transparent',
          borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
          marginLeft: active ? 0 : 2,
        }}
      >
        {item.label}
      </button>
      {inSection &&
        item.children?.map((child) => (
          <SidebarItem
            key={child.url}
            item={child}
            currentUrl={currentUrl}
            route={route}
            indent={indent + 16}
          />
        ))}
    </>
  );
}
