import { http, httpPaginated } from "./http";
import { ApiClientError } from "@/client/lib/errors";
import type {
  Invoice,
  InvoiceFilters,
  CreateInvoiceInput,
} from "@/shared/schemas/invoices.schema";
export const invoicesApi = {
  list: (f: InvoiceFilters) =>
    httpPaginated<Invoice>(
      `/invoices?${new URLSearchParams(Object.entries(f).map(([k, v]) => [k, String(v)]))}`,
    ),
  create: (input: CreateInvoiceInput) =>
    http<Invoice>("/invoices", { method: "POST", body: JSON.stringify(input) }),
  remove: (id: string) => http<void>(`/invoices/${id}`, { method: "DELETE" }),
  download: (id: string) =>
    http<{ url: string; expiresIn: number }>(`/invoices/${id}/download-url`),
  async upload(id: string, file: File) {
    const signed = await http<{
      signedUrl: string;
      token: string;
      path: string;
    }>(`/invoices/${id}/upload-url`, {
      method: "POST",
      body: JSON.stringify({
        fileName: file.name,
        mimeType: file.type,
        size: file.size,
      }),
    });
    let response: Response;
    try {
      response = await fetch(signed.signedUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/pdf", "x-upsert": "false" },
        body: file,
      });
    } catch {
      throw new ApiClientError(0, "NETWORK_ERROR", "Upload connection failed");
    }
    if (!response.ok)
      throw new ApiClientError(502, "STORAGE_UNAVAILABLE", "PDF upload failed");
    return http<Invoice>(`/invoices/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "uploaded" }),
    });
  },
};
