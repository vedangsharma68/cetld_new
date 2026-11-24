import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lifecycleApi } from "@/client/api/lifecycle.api";
import { qk } from "./query-keys";
import type { LifecycleInput } from "@/shared/schemas/invoice-lifecycle.schema";
export function useLifecycleMutation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LifecycleInput) => lifecycleApi.act(id, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.invoices.all });
      void qc.invalidateQueries({ queryKey: qk.lifecycle.all });
    },
  });
}
export function useLifecycleState(workspaceId: string) {
  return useQuery({
    queryKey: qk.lifecycle.state(workspaceId),
    queryFn: () => lifecycleApi.state(workspaceId),
    enabled: !!workspaceId,
  });
}
