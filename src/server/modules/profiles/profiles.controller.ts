import "server-only";
import { getSessionUser } from "@/server/lib/auth";
import { ok } from "@/server/lib/response";
import { readJson } from "@/server/lib/validation";
import { updateProfileSchema } from "@/shared/schemas/profile.schema";
import { profileService } from "./profiles.service";
export const profileController = {
  async read() {
    const user = await getSessionUser();
    return ok(await profileService.read(user.id));
  },
  async update(request: Request) {
    const user = await getSessionUser();
    return ok(
      await profileService.update(
        user.id,
        updateProfileSchema.parse(await readJson(request)),
      ),
    );
  },
};
