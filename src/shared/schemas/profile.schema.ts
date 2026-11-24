import { z } from "zod";
export const updateProfileSchema = z
  .object({ fullName: z.string().trim().min(1).max(160).nullable() })
  .strict();
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type ProfileView = { fullName: string | null; updatedAt: Date | null };
