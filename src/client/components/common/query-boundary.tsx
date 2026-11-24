import type { UseQueryResult } from "@tanstack/react-query";
import { LoadingSkeleton } from "./loading-skeleton";
import { EmptyState } from "./empty-state";
import { ErrorState } from "./error-state";
export function QueryBoundary<T>({
  query,
  isEmpty,
  children,
}: {
  query: UseQueryResult<T, Error>;
  isEmpty?: (data: T) => boolean;
  children: (data: T) => React.ReactNode;
}) {
  if (query.isPending) return <LoadingSkeleton />;
  if (query.isError)
    return (
      <ErrorState
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  if (isEmpty?.(query.data)) return <EmptyState />;
  return children(query.data);
}
