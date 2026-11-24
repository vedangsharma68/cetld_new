import { withHandler } from "@/server/lib/handler";
import { invoiceController } from "@/server/modules/invoices/invoices.controller";
export const GET = withHandler(invoiceController.detail);
export const PATCH = withHandler(invoiceController.finalize);
export const DELETE = withHandler(invoiceController.remove);
