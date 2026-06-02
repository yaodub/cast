import { createTRPCReact } from '@trpc/react-query';
import { httpBatchLink } from '@trpc/client';
import type { AppRouter } from '@getcast/server/admin';

/** Base URL for the Cast server API. Defaults to same origin, override for cross-origin dev. */
export const API_BASE = import.meta.env.VITE_API_BASE ?? '';

export const trpc = createTRPCReact<AppRouter>();

export const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: `${API_BASE}/api/trpc`,
      headers: () => {
        const token = localStorage.getItem('cast_admin_token');
        return token ? { Authorization: `Bearer ${token}` } : {};
      },
    }),
  ],
});
