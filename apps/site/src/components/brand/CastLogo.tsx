import { useId } from 'preact/hooks';
import type { JSX } from 'preact';

interface Props {
  size?: number;
  class?: string;
  weight?: number;
  gradient?: boolean;
  style?: JSX.CSSProperties;
}

export function CastLogo({
  size = 24,
  class: cls = '',
  weight = 21,
  gradient = false,
  style,
}: Props) {
  const uid = useId();
  const fill = gradient ? `url(#castg-${uid})` : 'currentColor';
  return (
    <svg
      viewBox="0 0 400 400"
      width={size}
      height={size}
      class={cls}
      aria-hidden="true"
      style={{ display: 'block', ...style }}
    >
      {gradient && (
        <defs>
          <linearGradient
            id={`castg-${uid}`}
            x1="0%"
            y1="0%"
            x2="100%"
            y2="100%"
            gradientUnits="objectBoundingBox"
          >
            <stop offset="0%" stop-color="oklch(72% 0.13 calc(var(--accent-hue) - 35))" />
            <stop offset="50%" stop-color="oklch(62% 0.15 var(--accent-hue))" />
            <stop offset="100%" stop-color="oklch(52% 0.14 calc(var(--accent-hue) + 40))" />
          </linearGradient>
        </defs>
      )}
      <g transform="rotate(-23, 200, 200)">
        <circle cx="200" cy="200" r="50.11" fill={fill} />
        <path
          d="M 271.83 149.70 A 87.69 87.69 0 1 0 271.83 250.30"
          fill="none"
          stroke={fill}
          stroke-width={weight}
          stroke-linecap="round"
        />
        <path
          d="M 309.46 123.36 A 133.63 133.63 0 1 0 309.46 276.64"
          fill="none"
          stroke={fill}
          stroke-width={weight}
          stroke-linecap="round"
        />
        <path
          d="M 347.09 97.01 A 179.56 179.56 0 1 0 347.09 302.99"
          fill="none"
          stroke={fill}
          stroke-width={weight}
          stroke-linecap="round"
        />
        <line
          x1="271.83"
          y1="149.70"
          x2="347.09"
          y2="97.01"
          stroke={fill}
          stroke-width={weight}
          stroke-linecap="round"
        />
        <line
          x1="271.83"
          y1="250.30"
          x2="347.09"
          y2="302.99"
          stroke={fill}
          stroke-width={weight}
          stroke-linecap="round"
        />
      </g>
    </svg>
  );
}
