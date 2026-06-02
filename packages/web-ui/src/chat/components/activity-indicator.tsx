/**
 * Activity indicator strip — fixed height, sits between message list and input.
 * Always reserves vertical space to prevent layout shift.
 */

interface Props {
  typing: boolean;
  lifecycle: string | null;
  /** True when at least one preview stream is in flight. Suppresses the
   *  redundant "thinking…" pulse so the in-bubble blinking cursor is the
   *  sole "writing now" signal. Lifecycle phases still win (e.g. "Waking
   *  up…" surfaces a state distinct from active streaming). */
  streaming?: boolean;
}

export function ActivityIndicator({ typing, lifecycle, streaming }: Props) {
  const active = lifecycle !== null || (typing && !streaming);

  if (!active) return null;

  return (
    <div class="px-4 py-2 flex items-center">
      <div class="flex items-center gap-3">
        <div class="relative w-4 h-4 flex items-center justify-center">
          <span class="absolute w-2 h-2 bg-teal-400/60 rounded-full" />
          <span class="absolute w-full h-full border border-teal-400/40 rounded-full animate-[ripple_1.8s_ease-out_infinite]" />
          <span class="absolute w-full h-full border border-teal-400/40 rounded-full animate-[ripple_1.8s_ease-out_0.6s_infinite]" />
        </div>
        <span class="text-xs text-gray-500">{lifecycle ?? (typing ? 'thinking…' : '')}</span>
      </div>
    </div>
  );
}
