import "server-only";
import { randomUUID } from "node:crypto";
import { planBusinessCreation } from "../workspaces/business-create-plan";
import { eq, and, isNull, sql } from "drizzle-orm";
import { compare } from "bcryptjs";
import { db } from "@/server/db/client";
import {
  users,
  profiles,
  emailSignups,
  workspaces,
  workspaceMembers,
  workspaceSettings,
} from "@/server/db/schema";
export const signupRepository = {
  async prepare(input: {
    email: string;
    tokenHash: string;
    passwordHash: string;
    name: string;
    businessName: string;
  }) {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.email},5))`,
      );
      const existing = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, input.email));
      if (existing.length) return false;
      await tx.insert(emailSignups).values({
        ...input,
        expiresAt: sql`clock_timestamp()+interval '30 minutes'`,
      });
      return true;
    });
  },
  async verify(tokenHash: string, password: string) {
    return db.transaction(async (tx) => {
      const [pending] = await tx
        .select()
        .from(emailSignups)
        .where(
          and(
            eq(emailSignups.tokenHash, tokenHash),
            isNull(emailSignups.consumedAt),
          ),
        )
        .for("update");
      if (!pending || !(await compare(password, pending.passwordHash)))
        return null;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${pending.email},5))`,
      );
      const [clock] = await tx.execute<{ valid: boolean }>(
        sql`select ${pending.expiresAt.toISOString()}::timestamptz>clock_timestamp() as valid`,
      );
      if (!clock?.valid) return null;
      const [user] = await tx
        .insert(users)
        .values({
          email: pending.email,
          name: pending.name,
          passwordHash: pending.passwordHash,
          emailVerifiedAt: sql`clock_timestamp()`,
        })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id });
      await tx
        .update(emailSignups)
        .set({ consumedAt: sql`clock_timestamp()` })
        .where(eq(emailSignups.id, pending.id));
      if (!user) return null;
      await tx
        .insert(profiles)
        .values({ userId: user.id, fullName: pending.name });
      const [business] = await tx
        .insert(workspaces)
        .values({
          ownerId: user.id,
          ...planBusinessCreation(pending.businessName, randomUUID()),
        })
        .returning({ id: workspaces.id });
      if (!business) throw Error("Business creation failed");
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId: business.id, userId: user.id, role: "owner" });
      await tx.insert(workspaceSettings).values({
        workspaceId: business.id,
        businessName: pending.businessName,
      });
      return { verified: true };
    });
  },
};
