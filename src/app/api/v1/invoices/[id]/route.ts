import { withHandler } from "@/server/lib/handler";
import { invoiceController } from "@/server/modules/invoices/invoices.controller";
export const GET = withHandler(invoiceController.detail);
export const PATCH = withHandler(invoiceController.finalize);
import { ConflictError } from "@/server/lib/errors";
export const DELETE = withHandler(async () => {
  throw new ConflictError(
    "LIFECYCLE_CONFIRMATION_REQUIRED",
    "Use the owner deletion proposal and confirmation flow",
  );
});
