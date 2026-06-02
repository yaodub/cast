/**
 * AuthSetupModal — dialog wrapper around CredentialsForm.
 *
 * Triggered from every admin chat console (Design Manager, Configure Manager,
 * per-agent channels) when `auth=null`. On save the form verifies the
 * credentials against Claude and hot-reloads the server; closing the modal
 * after success unblocks the chat input.
 */
import { useEffect, useRef } from 'preact/hooks';

import { trpc } from '../trpc';
import { CredentialsForm } from './credentials-form';

export function AuthSetupModal({ onClose, onSaved }: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const authStatus = trpc.auth.getStatus.useQuery();
  const dialogRef = useRef<HTMLDivElement>(null);

  // Esc to dismiss — modal is dismissible per discussion (operator may
  // want to explore the dashboard first; chat input still routes them
  // back here when they try to send).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-setup-title"
      class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div class="bg-gray-900 border border-gray-800 rounded-md p-6 w-full max-w-md space-y-4">
        <div class="flex items-start justify-between gap-4">
          <div>
            <h2 id="auth-setup-title" class="text-white font-semibold">Set up Claude</h2>
            <p class="text-xs text-gray-500 mt-1">
              Saved credentials are verified with a single API call before they take effect — no restart needed.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            class="text-gray-500 hover:text-gray-300 text-lg leading-none px-1"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {authStatus.data && (
          <CredentialsForm
            data={authStatus.data}
            onSaved={() => {
              authStatus.refetch();
              onSaved();
            }}
          />
        )}
      </div>
    </div>
  );
}
