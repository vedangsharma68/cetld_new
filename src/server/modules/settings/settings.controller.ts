import "server-only";
import { getSessionUser } from "@/server/lib/auth";
import { BadRequestError } from "@/server/lib/errors";
import { ok } from "@/server/lib/response";
import { businessSettingsQuerySchema } from "@/shared/schemas/settings.schema";
import { settingsService } from "./settings.service";
export const settingsController = {
  async read(request: Request) {
    const user = await getSessionUser(),
      parsed = businessSettingsQuerySchema.safeParse(
        Object.fromEntries(new URL(request.url).searchParams),
      );
    if (!parsed.success)
      throw new BadRequestError("Invalid business settings query");
    return ok(await settingsService.read(user.id, parsed.data.workspaceId));
  },
};
