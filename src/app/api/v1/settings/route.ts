import { withHandler } from "@/server/lib/handler";
import { settingsController } from "@/server/modules/settings/settings.controller";
export const GET = withHandler(settingsController.read);
