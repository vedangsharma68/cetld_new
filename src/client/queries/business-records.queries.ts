"use client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { businessRecordsApi } from "@/client/api/business-records.api";
import { qk } from "./query-keys";
export function useBusinessRecords(
  workspaceId: string,
  includeDeleted: boolean,
) {
  return useInfiniteQuery({
    queryKey: qk.businessRecords.list(workspaceId, includeDeleted),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      businessRecordsApi.list(workspaceId, includeDeleted, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: !!workspaceId,
  });
}
