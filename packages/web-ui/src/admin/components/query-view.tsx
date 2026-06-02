/**
 * QueryView — render a tRPC/react-query result with the standard
 * loading / error / empty triple. Removes the 4× copies of:
 *
 *   if (q.isLoading) return <p ...>Loading...</p>;
 *   if (q.error)     return <p ...>Error: {q.error.message}</p>;
 *   if (!q.data)     return null;
 *   return <Body data={q.data} />;
 *
 * Loading stays as bare text (transient, doesn't deserve a container).
 * Error gets a red-tinted bordered alert box so a network/server failure
 * stands out instead of reading as a leftover form label.
 */
import type { JSX } from 'preact';

interface QueryLike<T> {
  isLoading: boolean;
  error: { message: string } | null;
  data: T | undefined;
}

export function QueryView<T>({
  query,
  children,
}: {
  query: QueryLike<T>;
  children: (data: T) => JSX.Element;
}): JSX.Element | null {
  if (query.isLoading) return <p class="text-gray-500 text-sm">Loading...</p>;
  if (query.error) {
    return (
      <div class="px-4 py-2.5 bg-red-900/20 border border-red-800/40 rounded-md text-sm text-red-300">
        <span class="font-medium">Error:</span> {query.error.message}
      </div>
    );
  }
  if (!query.data) return null;
  return children(query.data);
}
