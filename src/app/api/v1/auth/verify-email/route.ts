import { withHandler } from "@/server/lib/handler";
import { verifySignup } from "@/server/modules/auth/signup.controller";
export const POST = withHandler(verifySignup);
