"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { paymentsApi } from "@/client/api/payments.api";
import { qk } from "./query-keys";
export function useRecordPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: paymentsApi.record,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.invoices.all });
    },
  });
}
