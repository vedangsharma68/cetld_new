import "server-only";
import { profileRepository } from "./profiles.repository";
import type { UpdateProfileInput } from "@/shared/schemas/profile.schema";
export function createProfileService(repository = profileRepository) {
  return {
    async read(userId: string) {
      const row = await repository.find(userId);
      return {
        fullName: row?.fullName ?? null,
        updatedAt: row?.updatedAt ?? null,
      };
    },
    async update(userId: string, input: UpdateProfileInput) {
      const row = await repository.save(userId, input.fullName);
      if (!row) throw Error("Profile save failed");
      return { fullName: row.fullName, updatedAt: row.updatedAt };
    },
  };
}
export const profileService = createProfileService();
