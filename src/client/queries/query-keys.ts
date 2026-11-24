import type { InvoiceFilters } from "@/shared/schemas/invoices.schema";
import type { CustomerFilters } from "@/shared/schemas/customers.schema";
export const qk = {
  lifecycle: {
    all: ["invoice-lifecycle"] as const,
    state: (workspaceId: string) => ["invoice-lifecycle", workspaceId] as const,
  },
  workspaces: { all: ["workspaces"] as const },
  customers: {
    all: ["customers"] as const,
    list: (filters: CustomerFilters) => ["customers", "list", filters] as const,
    detail: (id: string) => ["customers", "detail", id] as const,
  },
  invoices: {
    all: ["invoices"] as const,
    list: (filters: InvoiceFilters) => ["invoices", "list", filters] as const,
    detail: (id: string) => ["invoices", "detail", id] as const,
  },
};
