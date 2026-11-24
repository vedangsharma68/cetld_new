"use client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { invoiceCorrectionHistoryApi } from "@/client/api/invoice-correction-history.api";
import { qk } from "./query-keys";
export function useInvoiceCorrectionHistory(
  workspaceId: string,
  invoiceId: string,
  enabled: boolean,
) {
  return useInfiniteQuery({
    queryKey: qk.correctionHistory.list(workspaceId, invoiceId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      invoiceCorrectionHistoryApi.list(workspaceId, invoiceId, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
  });
}
