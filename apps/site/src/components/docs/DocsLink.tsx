import type { ComponentChildren } from 'preact';
import { useLocation } from 'preact-iso';

interface Props {
  href: string;
  children: ComponentChildren;
}

export function DocsLink({ href, children }: Props) {
  const { route } = useLocation();
  return (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault();
        route(href);
      }}
      style={{ color: 'var(--accent)', textDecoration: 'underline' }}
    >
      {children}
    </a>
  );
}
