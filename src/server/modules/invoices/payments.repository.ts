import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import { invoices, payments, workspaceMembers } from "@/server/db/schema";
import { planPayment } from "./payment-plan";
import type { RecordPaymentInput } from "@/shared/schemas/payments.schema";
export const paymentRepository = {
  async record(userId: string, invoiceId: string, input: RecordPaymentInput) {
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
        sql`select pg_advisory_xact_lock(hashtextextended(${invoice.workspaceId + ":" + input.idempotencyKey},14))`,
      );
      const [existing] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.workspaceId, invoice.workspaceId),
            eq(payments.idempotencyKey, input.idempotencyKey),
          ),
        );
      const plan = planPayment(invoiceId, invoice, input, existing ?? null);
      if (plan.replayed) return existing;
      const [saved] = await tx
        .insert(payments)
        .values({
          workspaceId: invoice.workspaceId,
          invoiceId,
          recordedBy: userId,
          amount: plan.amount,
          reference: input.reference,
          idempotencyKey: input.idempotencyKey,
          settleRemaining: input.settleRemaining,
        })
        .returning();
      await tx
        .update(invoices)
        .set({
          amountPaid: plan.amountPaid,
          financialStatus: plan.financialStatus,
        })
        .where(eq(invoices.id, invoiceId));
      return saved ?? null;
    });
  },
};
