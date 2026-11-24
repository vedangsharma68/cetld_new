import "server-only";
import type { LifecycleInput } from "@/shared/schemas/invoice-lifecycle.schema";
import { ConflictError, NotFoundError } from "@/server/lib/errors";
import { moneyUnits } from "@/shared/schemas/exact-money";
import { confirmLifecyclePlan } from "./lifecycle-plan";
import { lifecycleRepository } from "./lifecycle.repository";
export function createLifecycleService(repository = lifecycleRepository) {
  return {
    async act(userId: string, id: string, input: LifecycleInput) {
      const invoiceId = id;
      const result = await repository.withLockedInvoice(
        userId,
        id,
        async ({ invoice, now, store }) => {
          if (!invoice.lifecycleRiskVerified)
            throw new ConflictError(
              "LIFECYCLE_RISK_UNKNOWN",
              "Reminder delivery state has not been verified for this invoice",
            );
          const ledger = await store.payment();
          const risk = {
            hadPayment:
              !!ledger ||
              invoice.financialStatus === "paid" ||
              moneyUnits(invoice.amountPaid) > 0n,
            hadSentReminder: false,
            activeDispatch: false,
          };

          if (input.action === "prepare") {
            const replay = await store.byPrepareKey(input.key);
            if (replay) {
              if (replay.invoiceId !== invoiceId)
                throw new ConflictError(
                  "IDEMPOTENCY_MISMATCH",
                  "Deletion key belongs to another invoice",
                );
              if (replay.state !== "pending" || replay.expiresAt <= now)
                throw new ConflictError(
                  "ACTION_STALE",
                  "Prepare a new deletion proposal",
                );
              return replay;
            }
            if (invoice.deletedAt)
              throw new ConflictError(
                "ALREADY_DELETED",
                "Invoice is already deleted",
              );
            await store.expirePending();
            const pending = await store.pending();
            if (pending)
              throw new ConflictError(
                "ACTION_PENDING",
                "Complete or cancel the pending deletion first",
              );
            const created = await store.create({
              workspaceId: invoice.workspaceId,
              ownerId: userId,
              invoiceId: invoice.id,
              idempotencyKey: input.key,
              revision: String(invoice.revision),
              invoiceNumber: invoice.invoiceNumber,
              hadPayment: risk.hadPayment,
              hadSentReminder: risk.hadSentReminder,
              expiresAt: new Date(now.getTime() + 600000),
              snapshot: {
                invoiceNumber: invoice.invoiceNumber,
                amount: invoice.amount,
                currency: invoice.currency,
                status: invoice.financialStatus,
              },
            });
            return created ?? null;
          }
          if (input.action === "restore") {
            const replay = await store.byRestoreKey(input.key);
            if (replay) {
              if (replay.invoiceId !== invoiceId)
                throw new ConflictError(
                  "IDEMPOTENCY_MISMATCH",
                  "Restore key belongs to another invoice",
                );
              if (replay.state !== "restored")
                throw new ConflictError("ACTION_STALE", "Restore changed");
              return replay;
            }
            if (!invoice.deletedAt || invoice.deletedBy !== userId)
              throw new ConflictError(
                "INVOICE_NOT_DELETED",
                "Invoice is not deleted by this owner",
              );
            if (invoice.deletedAt.getTime() < now.getTime() - 30 * 86400000)
              throw new ConflictError(
                "UNDO_EXPIRED",
                "Restore is available for thirty days",
              );
            const proposal = await store.deletedProposal();
            if (!proposal) return null;
            const followupState =
              ["paid", "void", "cancelled"].includes(invoice.financialStatus) ||
              moneyUnits(invoice.amountPaid) >= moneyUnits(invoice.amount)
                ? "cancelled"
                : "paused";
            await store.updateInvoice({
              deletedAt: null,
              deletedBy: null,
              followupState,
              nextFollowUpAt: null,
              metadata: {
                ...invoice.metadata,
                followup_state: followupState,
                next_follow_up_at: null,
              },
            });
            const restored = await store.updateProposal(proposal.id, {
              state: "restored",
              restoreKey: input.key,
            });
            return restored ?? null;
          }
          const proposal = await store.proposal(input.proposalId!);
          if (!proposal) return null;
          if (input.action === "cancel") {
            if (
              proposal.state === "cancelled" &&
              proposal.cancelKey === input.key
            )
              return proposal;
            if (proposal.state !== "pending" || proposal.expiresAt <= now)
              throw new ConflictError(
                "ACTION_STALE",
                "Deletion proposal changed or expired",
              );
            const cancelled = await store.updateProposal(proposal.id, {
              state: "cancelled",
              cancelKey: input.key,
            });
            return cancelled ?? null;
          }
          if (
            proposal.state === "deleted" &&
            proposal.confirmationKey === input.key
          ) {
            const exact = proposal.hadPayment || proposal.hadSentReminder;
            if (
              exact
                ? input.confirmation !== "DELETE " + proposal.invoiceNumber
                : input.confirmation?.trim().toLowerCase() !== "yes"
            )
              throw new ConflictError(
                "IDEMPOTENCY_MISMATCH",
                "Confirmation changed on replay",
              );
            return proposal;
          }
          const planned = confirmLifecyclePlan(
            {
              id: invoice.id,
              number: invoice.invoiceNumber,
              revision: String(invoice.revision),
              deletedAt: invoice.deletedAt,
              amountPaid: invoice.amountPaid,
              status: invoice.financialStatus,
            },
            proposal,
            risk,
            input.confirmation ?? "",
            now,
          );
          await store.updateInvoice({
            deletedAt: planned.deletedAt,
            deletedBy: userId,
            followupState: "cancelled",
            nextFollowUpAt: null,
            metadata: {
              ...invoice.metadata,
              followup_state: "cancelled",
              next_follow_up_at: null,
            },
          });
          const deleted = await store.updateProposal(proposal.id, {
            state: "deleted",
            deletedAt: planned.deletedAt,
            confirmationKey: input.key,
          });
          return deleted ?? null;
        },
      );
      if (!result) throw new NotFoundError("Invoice lifecycle");
      return {
        id: result.id,
        invoiceId: result.invoiceId,
        invoiceNumber: result.invoiceNumber,
        state: result.state,
        hadPayment: result.hadPayment,
        hadSentReminder: result.hadSentReminder,
        expiresAt: result.expiresAt,
      };
    },
    async state(userId: string, workspaceId: string) {
      return {
        deleted: await repository.deleted(userId, workspaceId),
        pending: await repository.pending(userId, workspaceId),
      };
    },
  };
}
export const lifecycleService = createLifecycleService();
