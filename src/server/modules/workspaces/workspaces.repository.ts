import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { workspaces, workspaceMembers } from "@/server/db/schema";
export const workspaceRepository = {
  async listForUser(userId: string) {
    return db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        role: workspaceMembers.role,
        canManageLifecycle: sql<boolean>`${workspaces.ownerId}=${userId} and ${workspaceMembers.role}='owner'`,
      })
      .from(workspaces)
      .innerJoin(
        workspaceMembers,
        eq(workspaces.id, workspaceMembers.workspaceId),
      )
      .where(eq(workspaceMembers.userId, userId))
      .orderBy(workspaces.name);
  },
};
