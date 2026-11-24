"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { invoicesApi } from "@/client/api/invoices.api";
import { qk } from "./query-keys";
import type { InvoiceFilters } from "@/shared/schemas/invoices.schema";
export const useInvoices = (filters: InvoiceFilters) =>
  useQuery({
    queryKey: qk.invoices.list(filters),
    queryFn: () => invoicesApi.list(filters),
    enabled: Boolean(filters.workspaceId),
  });
export function useCreateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: invoicesApi.create,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.invoices.all });
    },
  });
}
export function useRemoveInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: invoicesApi.remove,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.invoices.all });
    },
  });
}
export function useUploadInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) =>
      invoicesApi.upload(id, file),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.invoices.all });
    },
  });
}
export const useDownloadInvoice = () =>
  useMutation({ mutationFn: invoicesApi.download });
