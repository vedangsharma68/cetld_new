import { http } from "./http";
import type { ReopeningInput } from "@/shared/schemas/invoice-reopening.schema";
export type ReopeningResult = {
  id: string;
  invoiceId: string;
  state: string;
  reversedAmount: string;
  expiresAt: string;
  cashRefund: false;
  paymentHistoryPreserved: true;
};
export const reopeningApi = {
  act: (id: string, input: ReopeningInput) =>
    http<ReopeningResult>(`/invoices/${id}/reopening`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
};
