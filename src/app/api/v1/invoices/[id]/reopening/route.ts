import { withHandler } from "@/server/lib/handler";
import { reopeningController } from "@/server/modules/invoices/reopening.controller";
export const POST = withHandler(reopeningController.act);
