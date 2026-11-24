import "server-only";
import { and, eq, isNull, gt } from "drizzle-orm";
import { db } from "@/server/db/client";
import { workspaces, businessRecords } from "@/server/db/schema";
export const businessRecordsRepository = {
  async listOwned(
    userId: string,
    workspaceId: string,
    includeDeleted: boolean,
    after: string | undefined,
    limit: number,
  ) {
    return db.transaction(
      async (tx) => {
        const [business] = await tx
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(
            and(eq(workspaces.id, workspaceId), eq(workspaces.ownerId, userId)),
          )
          .for("share");
        if (!business) return null;
        return tx
          .select({
            id: businessRecords.id,
            recordType: businessRecords.recordType,
            name: businessRecords.name,
            customFields: businessRecords.customFields,
            createdAt: businessRecords.createdAt,
            updatedAt: businessRecords.updatedAt,
            deletedAt: businessRecords.deletedAt,
          })
          .from(businessRecords)
          .where(
            and(
              eq(businessRecords.workspaceId, workspaceId),
              includeDeleted ? undefined : isNull(businessRecords.deletedAt),
              after ? gt(businessRecords.id, after) : undefined,
            ),
          )
          .orderBy(businessRecords.id)
          .limit(limit + 1);
      },
      { isolationLevel: "repeatable read" },
    );
  },
};
