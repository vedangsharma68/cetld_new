import "server-only";
import { and, eq, exists, count, desc, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import {
  invoices,
  workspaceMembers,
  workspaces,
  customers,
  storageCleanup,
} from "@/server/db/schema";
import type {
  CreateInvoiceInput,
  InvoiceFilters,
  InvoiceUploadInput,
} from "@/shared/schemas/invoices.schema";
const scope = (userId: string) =>
  exists(
    db
      .select({ id: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, invoices.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      ),
  );
export const invoiceRepository = {
  async membership(userId: string, workspaceId: string) {
    const [member] = await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.userId, userId),
          eq(workspaceMembers.workspaceId, workspaceId),
        ),
      );
    return member ?? null;
  },
  async list(userId: string, filters: InvoiceFilters) {
    const where = and(
      eq(invoices.workspaceId, filters.workspaceId),
      scope(userId),
    );
    return db.transaction(
      async (tx) => {
        const rows = await tx
          .select()
          .from(invoices)
          .where(where)
          .orderBy(desc(invoices.createdAt), desc(invoices.id))
          .limit(filters.pageSize)
          .offset((filters.page - 1) * filters.pageSize);
        const [total] = await tx
          .select({ n: count() })
          .from(invoices)
          .where(where);
        return { rows, total: total?.n ?? 0 };
      },
      { isolationLevel: "repeatable read" },
    );
  },
  async find(userId: string, id: string) {
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, id), scope(userId)));
    return row ?? null;
  },
  async create(userId: string, input: CreateInvoiceInput) {
    return db.transaction(async (tx) => {
      const [member] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.workspaceId, input.workspaceId),
          ),
        )
        .for("share");
      if (!member) return null;
      const [business] = await tx
        .select({ ownerId: workspaces.ownerId })
        .from(workspaces)
        .where(eq(workspaces.id, input.workspaceId))
        .for("share");
      if (!business) return null;
      if (input.customerId) {
        const [customer] = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(
            and(
              eq(customers.id, input.customerId),
              eq(customers.workspaceId, input.workspaceId),
            ),
          )
          .for("share");
        if (!customer) return null;
      }
      const [row] = await tx
        .insert(invoices)
        .values({ ...input, ownerId: business.ownerId })
        .returning();
      return row ?? null;
    });
  },
  async reserveUpload(
    userId: string,
    id: string,
    input: InvoiceUploadInput,
    path: string,
  ) {
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(invoices)
        .where(
          and(
            eq(invoices.id, id),
            scope(userId),
            eq(invoices.status, "pending_upload"),
          ),
        )
        .for("update");
      if (!current) return null;
      if (
        current.fileSize !== null &&
        (current.fileSize !== input.size || current.mimeType !== input.mimeType)
      )
        return null;
      const [row] = await tx
        .update(invoices)
        .set({ filePath: path, fileSize: input.size, mimeType: input.mimeType })
        .where(
          and(
            eq(invoices.id, id),
            scope(userId),
            eq(invoices.status, "pending_upload"),
          ),
        )
        .returning();
      return row ?? null;
    });
  },
  async finalize(userId: string, id: string) {
    const [row] = await db
      .update(invoices)
      .set({ status: "uploaded", uploadedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(invoices.id, id),
          scope(userId),
          eq(invoices.status, "pending_upload"),
        ),
      )
      .returning();
    return row ?? null;
  },
  async remove(userId: string, id: string, requestId: string) {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(invoices)
        .where(and(eq(invoices.id, id), scope(userId)))
        .for("update");
      if (!row) return null;
      const [member] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.workspaceId, row.workspaceId),
            eq(workspaceMembers.role, "owner"),
          ),
        )
        .for("share");
      if (!member) return null;
      const path = `${row.ownerId}/${row.id}.pdf`;
      const [job] = await tx
        .insert(storageCleanup)
        .values({ path, requestId })
        .returning({ id: storageCleanup.id });
      await tx.delete(invoices).where(and(eq(invoices.id, id), scope(userId)));
      return job ? { jobId: job.id, path } : null;
    });
  },
  async dueCleanup() {
    return db
      .select()
      .from(storageCleanup)
      .where(sql`${storageCleanup.notBefore}<=clock_timestamp()`)
      .orderBy(storageCleanup.notBefore)
      .limit(10);
  },
  async finishCleanup(id: string) {
    await db
      .update(storageCleanup)
      .set({ notBefore: sql`clock_timestamp()+interval '3 hours'` })
      .where(eq(storageCleanup.id, id));
  },
};
