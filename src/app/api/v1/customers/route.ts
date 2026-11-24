import { withHandler } from "@/server/lib/handler";
import { customerController } from "@/server/modules/customers/customers.controller";
export const GET = withHandler(customerController.list);
export const POST = withHandler(customerController.create);
