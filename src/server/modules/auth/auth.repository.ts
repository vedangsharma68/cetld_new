import "server-only";
import { and, eq, sql, isNull, or } from "drizzle-orm";
import { db } from "@/server/db/client";
import { users, providerAccounts, authRateLimits } from "@/server/db/schema";
const activeUser = () =>
  and(
    isNull(users.deletedAt),
    or(isNull(users.bannedUntil), sql`${users.bannedUntil}<=clock_timestamp()`),
  );
export const authRepository = {
  async byId(id: string) {
    const [row] = await db
      .select()
      .from(users)
      .where(and(eq(users.id, id), activeUser()))
      .limit(1);
    return row ?? null;
  },
  async resetAttempts(key: string) {
    await db.delete(authRateLimits).where(eq(authRateLimits.key, key));
  },
  async byEmail(email: string) {
    const [row] = await db
      .select()
      .from(users)
      .where(and(eq(users.email, email), activeUser()))
      .limit(1);
    return row ?? null;
  },
  async byProvider(provider: string, subject: string) {
    const [row] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        image: users.image,
      })
      .from(providerAccounts)
      .innerJoin(users, eq(users.id, providerAccounts.userId))
      .where(
        and(
          eq(providerAccounts.provider, provider),
          eq(providerAccounts.providerAccountId, subject),
          activeUser(),
          sql`${users.emailVerifiedAt} is not null`,
        ),
      )
      .limit(1);
    return row ?? null;
  },
  async takeAttempt(key: string) {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`delete from auth_rate_limits where key in (select key from auth_rate_limits where window_start<clock_timestamp()-interval '1 day' limit 100)`,
      );
      await tx.execute(
        sql`delete from email_signup_verifications where id in (select id from email_signup_verifications where expires_at<clock_timestamp()-interval '1 day' limit 100)`,
      );
      await tx.execute(
        sql`delete from oauth_signup_challenges where id in (select id from oauth_signup_challenges where expires_at<clock_timestamp()-interval '1 day' limit 100)`,
      );
    });
    const now = new Date();
    const [row] = await db
      .insert(authRateLimits)
      .values({ key, count: 1, windowStart: now })
      .onConflictDoUpdate({
        target: authRateLimits.key,
        set: {
          count: sql`case when ${authRateLimits.windowStart}<now()-interval '15 minutes' then 1 else ${authRateLimits.count}+1 end`,
          windowStart: sql`case when ${authRateLimits.windowStart}<now()-interval '15 minutes' then now() else ${authRateLimits.windowStart} end`,
        },
      })
      .returning({ count: authRateLimits.count });
    return (row?.count ?? Number.POSITIVE_INFINITY) <= 10;
  },
};
