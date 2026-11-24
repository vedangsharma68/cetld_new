import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import {
  workspaces,
  invoices,
  invoiceCorrectionAudits as audits,
} from "@/server/db/schema";
export const invoiceCorrectionAuditsRepository = {
  async listOwned(
    userId: string,
    workspaceId: string,
    invoiceId: string,
    after: string | undefined,
    limit: number,
  ) {
    return db.transaction(
      async (tx) => {
        const [invoice] = await tx
          .select({ id: invoices.id })
          .from(invoices)
          .innerJoin(workspaces, eq(workspaces.id, invoices.workspaceId))
          .where(
            and(
              eq(workspaces.id, workspaceId),
              eq(workspaces.ownerId, userId),
              eq(invoices.id, invoiceId),
            ),
          )
          .for("share");
        if (!invoice) return null;
        return tx
          .select({
            id: audits.id,
            sourceKind: audits.sourceKind,
            sourceEventId: audits.sourceEventId,
            values: audits.values,
            beforeSnapshot: audits.beforeSnapshot,
            afterSnapshot: audits.afterSnapshot,
            createdAt: audits.createdAt,
            cursorAt: sql<string>`to_char(${audits.createdAt} at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
          })
          .from(audits)
          .where(
            and(
              eq(audits.workspaceId, workspaceId),
              eq(audits.ownerId, userId),
              eq(audits.invoiceId, invoiceId),
              after
                ? sql`(${audits.createdAt},${audits.id})>(${after.split("|")[0]}::text::timestamptz,${after.split("|")[1]}::uuid)`
                : undefined,
            ),
          )
          .orderBy(audits.createdAt, audits.id)
          .limit(limit + 1);
      },
      { isolationLevel: "repeatable read" },
    );
  },
};
