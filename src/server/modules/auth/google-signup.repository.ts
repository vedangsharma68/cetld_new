import "server-only";
import { randomUUID } from "node:crypto";
import { planBusinessCreation } from "../workspaces/business-create-plan";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import {
  users,
  profiles,
  providerAccounts,
  workspaces,
  workspaceMembers,
  workspaceSettings,
} from "@/server/db/schema";
export const googleSignupRepository = {
  async open(input: { email: string; subject: string; name: string }) {
    return db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.email},5))`,
      );
      const [linked] = await tx
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          image: users.image,
          deletedAt: users.deletedAt,
          bannedUntil: users.bannedUntil,
          emailVerifiedAt: users.emailVerifiedAt,
          active: sql<boolean>`${users.deletedAt} is null and (${users.bannedUntil} is null or ${users.bannedUntil}<=clock_timestamp())`,
        })
        .from(providerAccounts)
        .innerJoin(users, eq(users.id, providerAccounts.userId))
        .where(
          and(
            eq(providerAccounts.provider, "google"),
            eq(providerAccounts.providerAccountId, input.subject),
          ),
        );
      if (linked)
        return linked.email === input.email &&
          linked.emailVerifiedAt &&
          linked.active
          ? {
              id: linked.id,
              email: linked.email,
              name: linked.name,
              image: linked.image,
            }
          : null;
      if (
        (
          await tx
            .select({ id: users.id })
            .from(users)
            .where(eq(users.email, input.email))
        ).length
      )
        return null;
      const [user] = await tx
        .insert(users)
        .values({
          email: input.email,
          name: input.name,
          emailVerifiedAt: sql`clock_timestamp()`,
        })
        .returning({
          id: users.id,
          email: users.email,
          name: users.name,
          image: users.image,
        });
      if (!user) throw Error("Account creation failed");
      await tx
        .insert(profiles)
        .values({ userId: user.id, fullName: input.name });
      await tx.insert(providerAccounts).values({
        provider: "google",
        providerAccountId: input.subject,
        userId: user.id,
      });
      const [business] = await tx
        .insert(workspaces)
        .values({
          ownerId: user.id,
          ...planBusinessCreation("My business", randomUUID()),
        })
        .returning({ id: workspaces.id });
      if (!business) throw Error("Business creation failed");
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId: business.id, userId: user.id, role: "owner" });
      await tx
        .insert(workspaceSettings)
        .values({ workspaceId: business.id, businessName: "My business" });
      return user;
    });
  },
};
