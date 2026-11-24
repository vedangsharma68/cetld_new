import "server-only";
import { ConflictError } from "@/server/lib/errors";
// Pure owner lifecycle rules, not an authorization boundary. The repository must
// independently lock owner membership, invoice, proposal and delivery-risk rows.
export type LifecycleInvoice = {
  id: string;
  number: string;
  revision: string;
  deletedAt: Date | null;
  amountPaid: string;
  status: string;
};
export type LifecycleRisk = {
  hadPayment: boolean;
  hadSentReminder: boolean;
  activeDispatch: boolean;
};
export type LifecycleProposal = {
  invoiceId: string;
  revision: string;
  state: "pending" | "cancelled" | "deleted" | "restored" | "expired" | "stale";
  expiresAt: Date;
  hadPayment: boolean;
  hadSentReminder: boolean;
};
export function confirmLifecyclePlan(
  invoice: LifecycleInvoice,
  proposal: LifecycleProposal,
  risk: LifecycleRisk,
  confirmation: string,
  dbNow: Date,
) {
  if (proposal.invoiceId !== invoice.id || proposal.state !== "pending")
    throw new ConflictError("ACTION_STALE", "Prepare a new deletion proposal");
  if (proposal.expiresAt <= dbNow)
    throw new ConflictError("ACTION_EXPIRED", "Deletion proposal expired");
  if (invoice.deletedAt)
    throw new ConflictError("ALREADY_DELETED", "Invoice is already deleted");
  if (
    invoice.revision !== proposal.revision ||
    (risk.hadPayment && !proposal.hadPayment) ||
    (risk.hadSentReminder && !proposal.hadSentReminder)
  )
    throw new ConflictError(
      "ACTION_STALE",
      "Invoice changed, prepare a new deletion proposal",
    );
  const requiresExact =
    proposal.hadPayment ||
    proposal.hadSentReminder ||
    risk.hadPayment ||
    risk.hadSentReminder;
  if (
    requiresExact
      ? confirmation !== "DELETE " + invoice.number
      : confirmation.trim().toLowerCase() !== "yes"
  )
    throw new ConflictError(
      requiresExact ? "EXACT_CONFIRMATION_REQUIRED" : "INVALID_CONFIRMATION",
      requiresExact
        ? "Type DELETE followed by the exact invoice number"
        : "Confirm deletion with yes",
    );
  if (risk.activeDispatch)
    throw new ConflictError(
      "ACTION_PENDING",
      "A reminder is being sent, try again after it finishes",
    );
  return {
    deletedAt: dbNow,
    followupState: "cancelled" as const,
    nextFollowUpAt: null,
    requiresExact,
  };
}
