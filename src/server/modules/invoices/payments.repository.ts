import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { invoices, payments, workspaceMembers } from "@/server/db/schema";
export type PaymentTransaction = {
  invoice: typeof invoices.$inferSelect;
  existing: typeof payments.$inferSelect | null;
  insertPayment(
    values: typeof payments.$inferInsert,
  ): Promise<typeof payments.$inferSelect | null>;
  updateInvoice(values: Partial<typeof invoices.$inferInsert>): Promise<void>;
};
export const paymentRepository = {
  async withLockedInvoice<T>(
    userId: string,
    invoiceId: string,
    key: string,
    run: (context: PaymentTransaction) => Promise<T>,
  ): Promise<T | null> {
    return db.transaction(async (tx) => {
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .for("update");
      if (!invoice) return null;
      const [member] = await tx
        .select()
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.workspaceId, invoice.workspaceId),
          ),
        )
        .for("share");
      if (!member) return null;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${invoice.workspaceId + ":" + key},14))`,
      );
      const [existing] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.workspaceId, invoice.workspaceId),
            eq(payments.idempotencyKey, key),
          ),
        );
      return run({
        invoice,
        existing: existing ?? null,
        async insertPayment(values) {
          const [saved] = await tx.insert(payments).values(values).returning();
          return saved ?? null;
        },
        async updateInvoice(values) {
          await tx
            .update(invoices)
            .set(values)
            .where(eq(invoices.id, invoiceId));
        },
      });
    });
  },
};
