import { withHandler } from "@/server/lib/handler";
import { signup } from "@/server/modules/auth/signup.controller";
export const POST = withHandler(signup);
