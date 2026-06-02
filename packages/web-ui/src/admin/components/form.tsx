/**
 * Form primitives paired with `useAdminForm`. Keeps page files free of
 * repeated tailwind class strings and ad-hoc status rendering.
 *
 * Wave 2 will pull the rest of `pages/extensions/shared.tsx` in here.
 */
import type { ComponentChildren } from 'preact';
import type { AdminFormStatus } from '../hooks/use-admin-form';

export const inputClass = 'w-full px-3 py-2 bg-gray-950 border border-gray-700 rounded text-white text-sm focus:outline-none focus:border-teal-500';

export function FormStatus({ message }: { message: AdminFormStatus | null }) {
  if (!message) return null;
  return (
    <p class={`text-sm ${message.type === 'ok' ? 'text-green-400' : 'text-red-400'}`}>
      {message.text}
    </p>
  );
}

export function SubmitButton({
  submitProps,
  children,
}: {
  submitProps: { type: 'submit'; disabled: boolean };
  children: ComponentChildren;
}) {
  return (
    <button
      {...submitProps}
      class="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm rounded font-medium transition-colors"
    >
      {children}
    </button>
  );
}
