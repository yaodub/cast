import * as store from '../lib/store';
import type { Toast } from '../lib/store';

export function ToastStack() {
  const items = store.toasts.value;
  if (items.length === 0) return null;

  return (
    <div class="fixed bottom-4 left-4 z-50 flex flex-col gap-2 max-w-sm">
      {items.map((toast: Toast) => (
        <button
          key={toast.id}
          onClick={() => {
            store.navigateTo(toast.agent, toast.channel);
            store.dismissToast(toast.id);
          }}
          class="w-full text-left bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 shadow-xl hover:bg-gray-750 hover:border-gray-600 transition-colors"
        >
          <div class="flex items-center gap-2 mb-1">
            <span class="text-xs font-medium text-teal-400 truncate">{toast.agent}</span>
            {toast.channel !== 'default' && (
              <span class="text-xs text-gray-500">/ {toast.channel}</span>
            )}
          </div>
          <p class="text-sm text-gray-300 truncate">{toast.preview}</p>
        </button>
      ))}
    </div>
  );
}
