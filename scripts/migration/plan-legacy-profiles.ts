import { z } from "zod";
export function planLegacyProfiles(snapshot: unknown, userIds: Set<string>) {
  const rows = z
    .object({
      profiles: z.array(
        z
          .object({
            user_id: z.uuid(),
            full_name: z
              .string()
              .refine((v) => v.trim().length >= 1 && v.trim().length <= 160)
              .nullable(),
            avatar_url: z.string().nullable(),
            created_at: z.string().datetime({ offset: true }),
            updated_at: z.string().datetime({ offset: true }),
          })
          .strict(),
      ),
    })
    .parse(snapshot).profiles;
  const seen = new Set<string>();
  return rows.map((r) => {
    if (!userIds.has(r.user_id) || seen.has(r.user_id))
      throw Error("Duplicate or orphan profile");
    seen.add(r.user_id);
    return {
      userId: r.user_id,
      fullName: r.full_name,
      avatarUrl: r.avatar_url,
      createdAt: new Date(r.created_at),
      updatedAt: new Date(r.updated_at),
    };
  });
}
