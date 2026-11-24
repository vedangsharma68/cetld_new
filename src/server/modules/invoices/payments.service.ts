import "server-only";
import { paymentRepository } from "./payments.repository";
import { NotFoundError } from "@/server/lib/errors";
import type { RecordPaymentInput } from "@/shared/schemas/payments.schema";
export function createPaymentService(repository = paymentRepository) {
  return {
    async record(userId: string, invoiceId: string, input: RecordPaymentInput) {
      const row = await repository.record(userId, invoiceId, input);
      if (!row) throw new NotFoundError("Invoice");
      return { id: row.id, amount: row.amount };
    },
  };
}
export const paymentService = createPaymentService();
