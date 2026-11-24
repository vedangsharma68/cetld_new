import { withHandler } from "@/server/lib/handler";
import { invoiceController } from "@/server/modules/invoices/invoices.controller";
export const GET = withHandler(invoiceController.download);
