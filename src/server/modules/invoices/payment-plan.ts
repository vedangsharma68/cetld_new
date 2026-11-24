import "server-only";
import { moneyUnits, moneyString } from "@/shared/schemas/exact-money";
import { ConflictError } from "@/server/lib/errors";
export type PaymentState = {
  amount: string;
  amountPaid: string;
  financialStatus:
    "draft" | "open" | "partially_paid" | "paid" | "void" | "cancelled";
  deletedAt: Date | null;
  currency: string;
};
export type PaymentRequest = {
  amount?: string;
  settleRemaining: boolean;
  reference: string | null;
  idempotencyKey: string;
};
export type SavedPayment = {
  amount: string;
  settleRemaining: boolean;
  reference: string | null;
  invoiceId: string;
};
// Pure financial rules. Repository must lock invoice + idempotency scope and persist atomically.
export function planPayment(
  invoiceId: string,
  state: PaymentState,
  input: PaymentRequest,
  existing: SavedPayment | null,
) {
  if (input.settleRemaining && input.amount !== undefined)
    throw new ConflictError(
      "INVALID_PAYMENT",
      "Settling the balance does not accept an amount",
    );
  if (state.deletedAt)
    throw new ConflictError(
      "INVOICE_DELETED",
      "Restore the invoice before recording payment",
    );
  if (existing) {
    if (
      existing.invoiceId !== invoiceId ||
      existing.settleRemaining !== input.settleRemaining ||
      existing.reference !== input.reference ||
      (!input.settleRemaining &&
        (input.amount === undefined ||
          moneyUnits(existing.amount) !== moneyUnits(input.amount)))
    )
      throw new ConflictError(
        "IDEMPOTENCY_MISMATCH",
        "Payment key was reused with a different request",
      );
    return { replayed: true as const, payment: existing };
  }
  if (["void", "cancelled", "paid"].includes(state.financialStatus))
    throw new ConflictError(
      "INVOICE_TERMINAL",
      "This invoice cannot accept payment",
    );
  const total = moneyUnits(state.amount),
    paid = moneyUnits(state.amountPaid),
    balance = total - paid;
  if (balance <= 0n)
    throw new ConflictError("ALREADY_PAID", "Invoice is already paid");
  const applied = input.settleRemaining
    ? balance
    : input.amount === undefined
      ? 0n
      : moneyUnits(input.amount);
  if (applied <= 0n || applied > balance)
    throw new ConflictError(
      "INVALID_PAYMENT",
      "Payment must be positive and cannot exceed the balance",
    );
  const updated = paid + applied;
  return {
    replayed: false as const,
    amount: moneyString(applied),
    amountPaid: moneyString(updated),
    financialStatus:
      updated === total ? ("paid" as const) : ("partially_paid" as const),
  };
}
