"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { reopeningApi } from "@/client/api/reopening.api";
import type { ReopeningInput } from "@/shared/schemas/invoice-reopening.schema";
import { qk } from "./query-keys";
export function useReopeningMutation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: ReopeningInput) => reopeningApi.act(id, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.invoices.all });
    },
  });
}
