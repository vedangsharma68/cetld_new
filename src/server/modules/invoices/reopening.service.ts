import "server-only";
import { ConflictError, NotFoundError } from "@/server/lib/errors";
import type { ReopeningInput } from "@/shared/schemas/invoice-reopening.schema";
import { reopeningRepository } from "./reopening.repository";
import { reopeningLedger, reopeningUpdate } from "./reopening-plan";
export function createReopeningService(repository = reopeningRepository) {
  return {
    async act(userId: string, invoiceId: string, input: ReopeningInput) {
      const result = await repository.withLockedInvoice(
        userId,
        invoiceId,
        async (c) => {
          if (input.action === "prepare") {
            const ledger = reopeningLedger(
              c.invoice,
              c.receipts,
              c.reversals.map((r) => r.paymentId),
            );
            const replay = await c.store.prepare(input.key);
            if (replay) {
              if (
                replay.workspaceId !== c.invoice.workspaceId ||
                replay.ownerId !== userId ||
                replay.invoiceId !== invoiceId ||
                replay.state !== "pending" ||
                replay.expiresAt <= c.now
              )
                throw new ConflictError(
                  "ACTION_STALE",
                  "Prepare a new reopening proposal",
                );
              return replay;
            }
            if (ledger.alreadyUnpaid)
              throw new ConflictError(
                "ALREADY_UNPAID",
                "Invoice is already unpaid",
              );
            return c.store.create({
              workspaceId: c.invoice.workspaceId,
              ownerId: userId,
              invoiceId,
              prepareKey: input.key,
              revision: c.invoice.revision,
              ledgerFingerprint: ledger.fingerprint,
              amount: ledger.amount,
              expiresAt: new Date(c.now.getTime() + 600000),
            });
          }
          const proposal = await c.store.proposal(input.proposalId);
          if (!proposal) return null;
          const target = input.action === "cancel" ? "cancelled" : "confirmed";
          if (proposal.state === target && proposal.decisionKey === input.key)
            return proposal;
          if (
            proposal.state !== "pending" ||
            proposal.expiresAt <= c.now ||
            proposal.prepareKey === input.key
          )
            throw new ConflictError(
              "ACTION_STALE",
              "Reopening proposal changed or expired",
            );
          if (input.action === "confirm") {
            const ledger = reopeningLedger(
              c.invoice,
              c.receipts,
              c.reversals.map((r) => r.paymentId),
            );
            if (
              proposal.revision !== c.invoice.revision ||
              proposal.ledgerFingerprint !== ledger.fingerprint ||
              proposal.amount !== ledger.amount
            )
              throw new ConflictError(
                "ACTION_STALE",
                "Invoice or payment history changed",
              );
            await c.store.reverse(
              ledger.active.map((p) => ({
                workspaceId: c.invoice.workspaceId,
                invoiceId,
                paymentId: p.id,
                webProposalId: proposal.id,
                amount: p.amount,
                actorId: userId,
                reason: "owner_invoice_reopening",
              })),
            );
            await c.store.updateInvoice(reopeningUpdate(c.invoice, c.today));
          }
          return c.store.update(proposal.id, {
            state: target,
            decisionKey: input.key,
          });
        },
      );
      if (!result) throw new NotFoundError("Invoice reopening");
      return {
        id: result.id,
        invoiceId: result.invoiceId,
        state: result.state,
        reversedAmount: result.amount,
        expiresAt: result.expiresAt,
        cashRefund: false,
        paymentHistoryPreserved: true,
      };
    },
  };
}
export const reopeningService = createReopeningService();
