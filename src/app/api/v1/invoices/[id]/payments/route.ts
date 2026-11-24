import { withHandler } from "@/server/lib/handler";
import { paymentController } from "@/server/modules/invoices/payments.controller";
export const POST = withHandler(paymentController.record);
