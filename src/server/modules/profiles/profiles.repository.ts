import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { profiles } from "@/server/db/schema";
export const profileRepository = {
  async find(userId: string) {
    const [r] = await db
      .select({ fullName: profiles.fullName, updatedAt: profiles.updatedAt })
      .from(profiles)
      .where(eq(profiles.userId, userId));
    return r ?? null;
  },
  async save(userId: string, fullName: string | null) {
    const [r] = await db
      .insert(profiles)
      .values({ userId, fullName })
      .onConflictDoUpdate({
        target: profiles.userId,
        set: { fullName, updatedAt: sql`clock_timestamp()` },
      })
      .returning({
        fullName: profiles.fullName,
        updatedAt: profiles.updatedAt,
      });
    return r ?? null;
  },
};
