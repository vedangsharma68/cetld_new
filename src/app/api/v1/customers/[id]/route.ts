import { withHandler } from "@/server/lib/handler";
import { customerController } from "@/server/modules/customers/customers.controller";
export const GET = withHandler(customerController.detail);
export const PATCH = withHandler(customerController.update);
export const DELETE = withHandler(customerController.remove);
