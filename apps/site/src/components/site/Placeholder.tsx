interface Props {
  label: string;
  ratio?: string;
  height?: number;
}

export function Placeholder({ label, ratio, height }: Props) {
  return (
    <div
      style={{
        aspectRatio: ratio,
        height: height ?? (ratio ? undefined : 200),
        background:
          'repeating-linear-gradient(45deg, var(--bg-elev) 0 6px, var(--bg-sunken) 6px 12px)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--fg-subtle)',
        fontFamily: 'JetBrains Mono, monospace',
        fontSize: 12,
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        padding: 16,
        textAlign: 'center',
        margin: '8px 0 22px',
      }}
    >
      {label}
    </div>
  );
}
