import { useState } from 'preact/hooks';
import { Copy, Check } from '../brand/Icon';

interface Props {
  text: string;
}

export function CopyButton({ text }: Props) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 11,
        color: 'var(--fg-muted)',
        padding: '4px 8px',
        borderRadius: 6,
      }}
    >
      {copied ? <Check s={12} /> : <Copy s={12} />}
      <span
        style={{
          fontFamily: 'JetBrains Mono, monospace',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
        }}
      >
        {copied ? 'copied' : 'copy'}
      </span>
    </button>
  );
}
