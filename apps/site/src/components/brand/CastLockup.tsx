import { CastLogo } from './CastLogo';

interface Props {
  size?: number;
}

export function CastLockup({ size = 22 }: Props) {
  const markSize = Math.round(size * 1.5);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--fg)' }}>
      <CastLogo size={markSize} />
      <span
        style={{
          fontWeight: 600,
          fontSize: size * 0.95,
          letterSpacing: '-0.025em',
          lineHeight: 1,
        }}
      >
        cast
      </span>
    </div>
  );
}
