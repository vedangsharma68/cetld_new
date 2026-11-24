import { withHandler } from "@/server/lib/handler";
import { lifecycleController } from "@/server/modules/invoices/lifecycle.controller";
export const POST = withHandler(lifecycleController.act);
