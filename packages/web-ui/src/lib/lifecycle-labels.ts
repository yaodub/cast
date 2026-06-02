/**
 * Display labels for `lifecycle` events emitted by the cast server.
 *
 * Shared between regular-chat (`worker/chat/ingest.ts`) and admin-chat
 * (`admin/hooks/use-admin-chat.ts`, `admin/hooks/use-server-scope-chat.ts`)
 * so both surfaces render the same operator-facing string when the runtime
 * surfaces transient state like queue waits, bootstrap, or compaction.
 */
export const LIFECYCLE_LABELS: Record<string, string> = {
  queued: 'Waiting for a free slot…',
  bootstrap: 'Waking up…',
  compacting: 'Compressing conversation history…',
  auth_refresh: 'Refreshing authentication…',
};
