import { useQueryClient } from '@tanstack/react-query';

import { API_BASE } from '../trpc';
import { useAdminSse } from './use-admin-sse';

/**
 * Subscribe to GET /api/changes and blanket-invalidate all tRPC queries
 * whenever the server reports a file-system change. Delegates the SSE +
 * Bearer-refresh plumbing to `useAdminSse`.
 */
export function useChangesStream(enabled: boolean): void {
  const queryClient = useQueryClient();

  useAdminSse(
    `${API_BASE}/api/changes`,
    () => {
      // Fires for both `ready` and `change` events.
      void queryClient.invalidateQueries();
    },
    enabled,
  );
}
