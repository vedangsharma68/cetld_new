import "server-only";
import { eq, and, isNull, or, sql } from "drizzle-orm";
import { auth } from "@/server/auth.config";
import { db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { ForbiddenError, UnauthorizedError } from "./errors";
export type SessionUser = {
  id: string;
  email: string;
  role: "admin" | "member";
};
export async function getSessionUser(): Promise<SessionUser> {
  const session = await auth();
  if (!session?.user?.id) throw new UnauthorizedError();
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      role: users.role,
      emailVerifiedAt: users.emailVerifiedAt,
      sessionVersion: users.sessionVersion,
    })
    .from(users)
    .where(
      and(
        eq(users.id, session.user.id),
        isNull(users.deletedAt),
        or(
          isNull(users.bannedUntil),
          sql`${users.bannedUntil}<=clock_timestamp()`,
        ),
      ),
    )
    .limit(1);
  if (
    !user ||
    !user.emailVerifiedAt ||
    user.sessionVersion !== session.sessionVersion
  )
    throw new UnauthorizedError();
  return user;
}
export function requireRole(
  user: SessionUser,
  roles: SessionUser["role"][],
): void {
  if (!roles.includes(user.role)) throw new ForbiddenError();
}
