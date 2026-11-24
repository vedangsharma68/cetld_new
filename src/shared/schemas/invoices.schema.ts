import { z } from "zod";
import { exactMoneySchema } from "./exact-money";
export const invoiceIdSchema = z.uuid();
export const createInvoiceSchema = z
  .object({
    workspaceId: z.uuid(),
    customerId: z.uuid().nullable().optional(),
    invoiceNumber: z.string().trim().min(1).max(100),
    amount: exactMoneySchema,
    currency: z.enum(["INR", "USD", "EUR", "GBP", "AED"]),
  })
  .strict();
export const invoiceFiltersSchema = z.object({
  workspaceId: z.uuid(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export const invoiceUploadSchema = z
  .object({
    fileName: z.string().trim().min(1).max(254),
    mimeType: z.string(),
    size: z.number().int().positive(),
  })
  .strict();
export const finalizeInvoiceSchema = z
  .object({ status: z.literal("uploaded") })
  .strict();
export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type InvoiceFilters = z.infer<typeof invoiceFiltersSchema>;
export type InvoiceUploadInput = z.infer<typeof invoiceUploadSchema>;
export const invoiceSchema = createInvoiceSchema.extend({
  id: z.uuid(),
  ownerId: z.uuid(),
  customerId: z.uuid().nullable(),
  status: z.enum(["pending_upload", "uploaded"]),
  amountPaid: z.string(),
  financialStatus: z.enum([
    "draft",
    "open",
    "partially_paid",
    "sent",
    "overdue",
    "paid",
    "void",
    "cancelled",
  ]),
  filePath: z.string().nullable(),
  fileSize: z.number().nullable(),
  mimeType: z.string().nullable(),
  uploadedAt: z.string().nullable(),
  createdAt: z.string(),
  issueDate: z.string().nullable(),
  dueDate: z.string().nullable(),
  notes: z.string().nullable(),
  customFields: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()]),
  ),
});
export type Invoice = z.infer<typeof invoiceSchema>;
