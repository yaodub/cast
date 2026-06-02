import { useState } from 'preact/hooks';
import * as store from '../lib/store';

export function Registration() {
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      await store.register(trimmed);
      // Worker handled the WS lifecycle; navigation is in `register()`.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
      setSubmitting(false);
    }
  }

  return (
    <div class="flex-1 flex flex-col items-center justify-center">
      <div class="w-[380px] bg-gray-900 border border-gray-800 rounded-xl p-8">
        <form onSubmit={handleSubmit} class="space-y-5">
          <div>
            <h1 class="text-xl font-semibold text-white">Welcome to Cast</h1>
            <p class="text-sm text-gray-400 mt-1">Enter your name to get started.</p>
          </div>
          <input
            type="text"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            placeholder="Your name"
            maxLength={255}
            class="w-full px-4 py-2.5 bg-gray-950 border border-gray-700 rounded-lg text-white placeholder-gray-500 focus:border-teal-500 focus:outline-none"
            autoFocus
          />
          {error && (
            <div class="px-4 py-2.5 bg-red-900/20 border border-red-800/30 rounded-lg flex items-center gap-2">
              <svg class="w-4 h-4 text-red-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
              <span class="text-sm text-red-300">{error}</span>
            </div>
          )}
          <button
            type="submit"
            disabled={!name.trim() || submitting}
            class="w-full px-4 py-2.5 bg-teal-600 hover:bg-teal-500 text-white font-medium rounded-lg disabled:opacity-50 transition-colors"
          >
            {submitting ? 'Connecting...' : 'Continue'}
          </button>
        </form>
      </div>
      <a href="/admin/" class="mt-6 text-sm text-gray-500 hover:text-gray-300 transition-colors">Server Dashboard</a>
    </div>
  );
}
