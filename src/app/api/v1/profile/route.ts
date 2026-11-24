import { withHandler } from "@/server/lib/handler";
import { profileController } from "@/server/modules/profiles/profiles.controller";
export const GET = withHandler(profileController.read);
export const PATCH = withHandler(profileController.update);
