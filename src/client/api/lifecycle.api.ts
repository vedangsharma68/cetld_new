import { http } from "./http";
import type {
  LifecycleInput,
  LifecycleResult,
} from "@/shared/schemas/invoice-lifecycle.schema";
export type LifecycleState = {
  deleted: { id: string; invoiceNumber: string; deletedAt: string }[];
  pending: LifecycleResult | null;
};
export const lifecycleApi = {
  act: (id: string, input: LifecycleInput) =>
    http<LifecycleResult>(`/invoices/${id}/lifecycle`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  state: (workspaceId: string) =>
    http<LifecycleState>(`/invoice-lifecycle?workspaceId=${workspaceId}`),
};
