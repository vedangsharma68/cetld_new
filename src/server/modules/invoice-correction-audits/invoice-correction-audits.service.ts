import "server-only";
import { NotFoundError } from "@/server/lib/errors";
import { invoiceCorrectionAuditsRepository } from "./invoice-correction-audits.repository";
export function createInvoiceCorrectionAuditsService(
  repo = invoiceCorrectionAuditsRepository,
) {
  return {
    async list(
      userId: string,
      workspaceId: string,
      invoiceId: string,
      after?: string,
      limit = 25,
    ) {
      const rows = await repo.listOwned(
        userId,
        workspaceId,
        invoiceId,
        after,
        limit,
      );
      if (!rows) throw new NotFoundError("Invoice history");
      const records = rows.slice(0, limit);
      return {
        records,
        nextCursor:
          rows.length > limit
            ? `${records.at(-1)!.cursorAt}|${records.at(-1)!.id}`
            : null,
      };
    },
  };
}
export const invoiceCorrectionAuditsService =
  createInvoiceCorrectionAuditsService();
