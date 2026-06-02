/**
 * Cast brand assets — shared between the admin shell and the user chat
 * shell. Both products show the same logo + wordmark at the top of
 * their sidebars; only the wrapping `Link` href differs (each surface
 * routes back to its own root via wouter's `base`).
 */
import { Link } from 'wouter';

/** Solid disc with three broadcast arcs sweeping to the right at -23°.
 *  Fill + stroke driven by `currentColor`. ViewBox is 400 (not 24)
 *  because the artwork is hand-drawn at that scale. */
export function CastLogo({ class: cls = 'w-5 h-5' }: { class?: string }) {
  return (
    <svg class={cls} viewBox="0 0 400 400" fill="none" aria-hidden>
      <g transform="rotate(-23, 200, 200)">
        <circle cx="200" cy="200" r="50.11" fill="currentColor" />
        <path
          d="M 271.83 149.70 A 87.69230769230771 87.69230769230771 0 1 0 271.83 250.30"
          stroke="currentColor"
          stroke-width="20.87912087912088"
          stroke-linecap="round"
        />
        <path
          d="M 309.46 123.36 A 133.62637362637366 133.62637362637366 0 1 0 309.46 276.64"
          stroke="currentColor"
          stroke-width="20.87912087912088"
          stroke-linecap="round"
        />
        <path
          d="M 347.09 97.01 A 179.5604395604396 179.5604395604396 0 1 0 347.09 302.99"
          stroke="currentColor"
          stroke-width="20.87912087912088"
          stroke-linecap="round"
        />
        <line
          x1="271.83"
          y1="149.70"
          x2="347.09"
          y2="97.01"
          stroke="currentColor"
          stroke-width="20.87912087912088"
          stroke-linecap="round"
        />
        <line
          x1="271.83"
          y1="250.30"
          x2="347.09"
          y2="302.99"
          stroke="currentColor"
          stroke-width="20.87912087912088"
          stroke-linecap="round"
        />
      </g>
    </svg>
  );
}

/** Top-of-sidebar brand block. `href` is relative to the wouter
 *  `base` of the surface — admin passes "/" to land on /admin/, chat
 *  passes "/" to land on /chat/. Same code, different bases. */
export function BrandStrip({ href = '/', title = 'Cast' }: { href?: string; title?: string }) {
  return (
    <Link
      href={href}
      class="px-4 pt-4 pb-3 flex items-center justify-center gap-2 shrink-0 border-b border-gray-800/60"
      title={title}
    >
      <CastLogo class="w-7 h-7 text-gray-300" />
      <span class="text-xl font-semibold text-white">cast</span>
      <span class="px-1.5 py-0.5 text-[10px] font-medium text-gray-400 border border-gray-700 rounded leading-none">
        alpha
      </span>
    </Link>
  );
}
