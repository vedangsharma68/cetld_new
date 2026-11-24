import { withHandler } from "@/server/lib/handler";
import { prepareGoogleSignup } from "@/server/modules/auth/google-signup.controller";
export const POST = withHandler(prepareGoogleSignup);
