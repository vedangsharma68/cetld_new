import "server-only";
import {
  NotFoundError,
  ConflictError,
  PayloadTooLargeError,
  UnsupportedMediaError,
} from "@/server/lib/errors";
import { sweepInvoiceFiles } from "./storage-cleanup.service";
import * as storage from "@/server/lib/storage";
import { invoiceRepository } from "./invoices.repository";
import { canReadInvoice } from "./invoices.policy";
import type {
  CreateInvoiceInput,
  InvoiceFilters,
  InvoiceUploadInput,
} from "@/shared/schemas/invoices.schema";
export function createInvoiceService(
  repository = invoiceRepository,
  files = storage,
) {
  const find = async (userId: string, id: string) => {
    const row = await repository.find(userId, id);
    if (!row) throw new NotFoundError("Invoice");
    canReadInvoice(
      await repository.membership(userId, row.workspaceId),
      row.workspaceId,
    );
    return row;
  };
  return {
    async list(userId: string, filters: InvoiceFilters) {
      canReadInvoice(
        await repository.membership(userId, filters.workspaceId),
        filters.workspaceId,
      );
      if (repository === invoiceRepository) await sweepInvoiceFiles();
      const result = await repository.list(userId, filters);
      return {
        rows: result.rows,
        meta: {
          page: filters.page,
          pageSize: filters.pageSize,
          total: result.total,
        },
      };
    },
    async detail(userId: string, id: string) {
      return find(userId, id);
    },
    async create(userId: string, input: CreateInvoiceInput) {
      canReadInvoice(
        await repository.membership(userId, input.workspaceId),
        input.workspaceId,
      );
      const row = await repository.create(userId, input);
      if (!row) throw new NotFoundError("Invoice");
      return row;
    },
    async upload(userId: string, id: string, input: InvoiceUploadInput) {
      const row = await find(userId, id);
      if (row.status !== "pending_upload")
        throw new ConflictError(
          "ALREADY_UPLOADED",
          "This invoice already has a file",
        );
      if (input.mimeType !== "application/pdf")
        throw new UnsupportedMediaError();
      if (input.size > 10485760) throw new PayloadTooLargeError(10);
      const path = `${row.ownerId}/${row.id}.pdf`;
      if (!(await repository.reserveUpload(userId, id, input, path)))
        throw new ConflictError(
          "UPLOAD_CONFLICT",
          "Invoice changed, refresh and try again",
        );
      return files.createUploadUrl(row.ownerId, row.id);
    },
    async finalize(userId: string, id: string) {
      const row = await find(userId, id);
      if (row.status === "uploaded") return row;
      if (!row.fileSize || row.filePath !== `${row.ownerId}/${row.id}.pdf`)
        throw new ConflictError("UPLOAD_REQUIRED", "Upload a PDF first");
      await files.inspectInvoiceFile(
        `${row.ownerId}/${row.id}.pdf`,
        row.fileSize,
      );
      const updated = await repository.finalize(userId, id);
      if (!updated)
        throw new ConflictError(
          "UPLOAD_CONFLICT",
          "Invoice changed, refresh and try again",
        );
      return updated;
    },
    async download(userId: string, id: string) {
      const row = await find(userId, id);
      if (row.status !== "uploaded")
        throw new ConflictError(
          "UPLOAD_REQUIRED",
          "Invoice has no completed PDF",
        );
      return files.createDownloadUrl(`${row.ownerId}/${row.id}.pdf`);
    },
    async remove(_userId: string, _id: string, _requestId: string) {
      void _userId;
      void _id;
      void _requestId;
      throw new ConflictError(
        "LIFECYCLE_CONFIRMATION_REQUIRED",
        "Use the owner deletion proposal and confirmation flow",
      );
    },
  };
}
export const invoiceService = createInvoiceService();
