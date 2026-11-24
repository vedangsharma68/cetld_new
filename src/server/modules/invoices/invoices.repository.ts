import "server-only";
import { planInvoiceNumber } from "./invoice-number-plan";
import { and, eq, exists, count, desc, sql, isNull } from "drizzle-orm";
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
const publicColumns = {
  id: invoices.id,
  workspaceId: invoices.workspaceId,
  ownerId: invoices.ownerId,
  customerId: invoices.customerId,
  invoiceNumber: invoices.invoiceNumber,
  amount: invoices.amount,
  amountPaid: invoices.amountPaid,
  financialStatus: invoices.financialStatus,
  deletedAt: invoices.deletedAt,
  currency: invoices.currency,
  status: invoices.status,
  filePath: invoices.filePath,
  originalFileName: invoices.originalFileName,
  fileSize: invoices.fileSize,
  mimeType: invoices.mimeType,
  uploadedAt: invoices.uploadedAt,
  createdAt: invoices.createdAt,
  issueDate: invoices.issueDate,
  dueDate: invoices.dueDate,
  notes: invoices.notes,
  customFields: invoices.customFields,
};
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
      isNull(invoices.deletedAt),
    );
    return db.transaction(
      async (tx) => {
        const rows = await tx
          .select(publicColumns)
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
      .select(publicColumns)
      .from(invoices)
      .where(
        and(eq(invoices.id, id), scope(userId), isNull(invoices.deletedAt)),
      );
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
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${input.workspaceId},92741))`,
      );
      const history = await tx
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          createdAt: invoices.createdAt,
          metadata: invoices.metadata,
        })
        .from(invoices)
        .where(eq(invoices.workspaceId, input.workspaceId));
      const clock = await tx.execute<{ today: string }>(
        sql`select current_date::text as today`,
      );
      const numbering = planInvoiceNumber(history, {
        sourceNumber: input.invoiceNumber,
        idempotencyKey: null,
        preserveOwnerNumber: true,
        today: clock[0]!.today,
      });
      const [row] = await tx
        .insert(invoices)
        .values({
          ...input,
          invoiceNumber: numbering.invoiceNumber,
          metadata: numbering.sourceInvoiceNumber
            ? { source_invoice_number: numbering.sourceInvoiceNumber }
            : {},
          ownerId: business.ownerId,
          lifecycleRiskVerified: true,
        })
        .returning(publicColumns);
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
            isNull(invoices.deletedAt),
            eq(invoices.status, "pending_upload"),
          ),
        )
        .for("update");
      if (!current) return null;
      if (
        current.fileSize !== null &&
        (current.fileSize !== input.size ||
          current.mimeType !== input.mimeType ||
          current.originalFileName !== input.fileName)
      )
        return null;
      const [row] = await tx
        .update(invoices)
        .set({
          filePath: path,
          originalFileName: input.fileName,
          fileSize: input.size,
          mimeType: input.mimeType,
        })
        .where(
          and(
            eq(invoices.id, id),
            scope(userId),
            isNull(invoices.deletedAt),
            eq(invoices.status, "pending_upload"),
          ),
        )
        .returning(publicColumns);
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
          isNull(invoices.deletedAt),
          eq(invoices.status, "pending_upload"),
        ),
      )
      .returning(publicColumns);
    return row ?? null;
  },
  async dueCleanup() {
    return db
      .select()
      .from(storageCleanup)
      .where(
        sql`${storageCleanup.notBefore}<=clock_timestamp() and not exists(select 1 from invoices i where ${storageCleanup.path}=i.owner_id::text||'/'||i.id::text||'.pdf')`,
      )
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
