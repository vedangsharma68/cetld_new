import "server-only";
import { createHash } from "node:crypto";
import { ConflictError } from "@/server/lib/errors";
import { moneyUnits, moneyString } from "@/shared/schemas/exact-money";
export type ReopeningInvoice = {
  id: string;
  amount: string;
  amountPaid: string;
  financialStatus: string;
  deletedAt: Date | null;
  revision: number;
  lifecycleRiskVerified: boolean;
  currency: string;
  dueDate: string | null;
  externalProvider: string | null;
  externalInvoiceId: string | null;
  metadata: Record<string, unknown>;
};
export type ReopeningPayment = {
  id: string;
  amount: string;
  externalProvider: string | null;
  externalPaymentId: string | null;
  metadata: Record<string, unknown>;
};
export function reopeningLedger(
  invoice: ReopeningInvoice,
  receipts: ReopeningPayment[],
  reversedIds: string[],
) {
  if (!invoice.lifecycleRiskVerified)
    throw new ConflictError(
      "LIFECYCLE_RISK_UNKNOWN",
      "Reminder delivery state has not been verified",
    );
  if (
    invoice.deletedAt ||
    ["void", "cancelled"].includes(invoice.financialStatus) ||
    !["INR", "USD", "EUR", "GBP", "AED", "SGD", "AUD", "CAD", "CHF"].includes(
      invoice.currency,
    ) ||
    moneyUnits(invoice.amount) <= 0n ||
    moneyUnits(invoice.amount) > 99999999999999n
  )
    throw new ConflictError("PAYMENT_GUARD", "Invoice cannot be reopened");
  const nonempty = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  if (
    [
      invoice.externalProvider,
      invoice.externalInvoiceId,
      invoice.metadata.accounting_provider,
      invoice.metadata.bookkeeping_record_id,
    ].some(nonempty) ||
    receipts.some((p) =>
      [
        p.externalProvider,
        p.externalPaymentId,
        p.metadata.accounting_provider,
      ].some(nonempty),
    )
  )
    throw new ConflictError(
      "EXTERNAL_LEDGER",
      "Reopen this invoice in its connected ledger",
    );
  const reversed = new Set(reversedIds),
    active = receipts
      .filter((p) => !reversed.has(p.id))
      .sort((a, b) => a.id.localeCompare(b.id));
  const sum = active.reduce((n, p) => n + moneyUnits(p.amount), 0n);
  if (sum !== moneyUnits(invoice.amountPaid))
    throw new ConflictError(
      "LEDGER_MISMATCH",
      "Invoice and receipt balance differ",
    );
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        receipts: [...receipts].sort((a, b) => a.id.localeCompare(b.id)),
        reversed: [...reversedIds].sort(),
      }),
    )
    .digest("hex");
  return {
    active,
    amount: moneyString(sum),
    fingerprint,
    alreadyUnpaid: sum === 0n && invoice.financialStatus !== "paid",
  };
}
export function reopeningUpdate(invoice: ReopeningInvoice, today: string) {
  return {
    amountPaid: "0.00",
    financialStatus:
      invoice.dueDate && invoice.dueDate < today
        ? ("overdue" as const)
        : ("sent" as const),
    followupState: "paused" as const,
    nextFollowUpAt: null,
    metadata: {
      ...invoice.metadata,
      outstanding_amount: invoice.amount,
      followup_state: "paused",
      next_follow_up_at: null,
      approved_reminder_text: null,
      approved_preferences_updated_at: null,
    },
  };
}
