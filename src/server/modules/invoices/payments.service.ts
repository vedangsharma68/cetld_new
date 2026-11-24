import "server-only";
import { paymentRepository } from "./payments.repository";
import { planPayment } from "./payment-plan";
import { NotFoundError } from "@/server/lib/errors";
import type { RecordPaymentInput } from "@/shared/schemas/payments.schema";
export function createPaymentService(repository = paymentRepository) {
  return {
    async record(userId: string, invoiceId: string, input: RecordPaymentInput) {
      const row = await repository.withLockedInvoice(
        userId,
        invoiceId,
        input.idempotencyKey,
        async (tx) => {
          const plan = planPayment(invoiceId, tx.invoice, input, tx.existing);
          if (plan.replayed) return tx.existing;
          const saved = await tx.insertPayment({
            workspaceId: tx.invoice.workspaceId,
            invoiceId,
            recordedBy: userId,
            amount: plan.amount,
            reference: input.reference,
            idempotencyKey: input.idempotencyKey,
            settleRemaining: input.settleRemaining,
          });
          if (!saved) throw new Error("Payment insert returned no row");
          await tx.updateInvoice({
            amountPaid: plan.amountPaid,
            financialStatus: plan.financialStatus,
            ...(plan.financialStatus === "paid"
              ? {
                  followupState: "cancelled" as const,
                  nextFollowUpAt: null,
                  metadata: {
                    ...tx.invoice.metadata,
                    followup_state: "cancelled",
                    next_follow_up_at: null,
                  },
                }
              : {}),
          });
          return saved;
        },
      );
      if (!row) throw new NotFoundError("Invoice");
      return { id: row.id, amount: row.amount };
    },
  };
}
export const paymentService = createPaymentService();
