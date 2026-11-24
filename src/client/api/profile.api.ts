import { http } from "./http";
import type { UpdateProfileInput } from "@/shared/schemas/profile.schema";
export type Profile = { fullName: string | null; updatedAt: string | null };
export const profileApi = {
  read: () => http<Profile>("/profile"),
  update: (input: UpdateProfileInput) =>
    http<Profile>("/profile", { method: "PATCH", body: JSON.stringify(input) }),
};
