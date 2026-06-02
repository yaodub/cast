import type { ComponentChildren } from 'preact';

type Kind = 'tip' | 'warn' | 'jargon' | 'security';

interface Props {
  kind?: Kind;
  label?: string;
  children: ComponentChildren;
}

const defaults: Record<Kind, string> = {
  tip: '💡 TIP',
  warn: '⚠ HEADS UP',
  jargon: '📖 JARGON',
  security: '🔒 SECURITY',
};

export function Callout({ kind = 'tip', label, children }: Props) {
  return (
    <div class={`callout callout-${kind}`}>
      <span class="callout-label">{label ?? defaults[kind]}</span>
      <div>{children}</div>
    </div>
  );
}
