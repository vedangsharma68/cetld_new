import { http } from "./http";
export type InvoiceCorrection = {
  id: string;
  sourceKind: string;
  sourceEventId: string;
  values: unknown;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
  createdAt: string;
};
export const invoiceCorrectionHistoryApi = {
  list: (workspaceId: string, invoiceId: string, after?: string) =>
    http<{ records: InvoiceCorrection[]; nextCursor: string | null }>(
      `/invoices/${invoiceId}/correction-history?${new URLSearchParams({ workspaceId, ...(after ? { after } : {}) })}`,
    ),
};
