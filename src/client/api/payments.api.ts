import { http } from "./http";
import type { RecordPaymentInput } from "@/shared/schemas/payments.schema";
export const paymentsApi = {
  record: ({ id, input }: { id: string; input: RecordPaymentInput }) =>
    http<{ id: string; amount: string }>(`/invoices/${id}/payments`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
