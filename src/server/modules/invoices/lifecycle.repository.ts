import "server-only";
import { and, eq, sql, desc } from "drizzle-orm";
import { db } from "@/server/db/client";
import {
  invoices,
  invoiceLifecycleProposals as proposals,
  payments,
  workspaceMembers,
  workspaces,
} from "@/server/db/schema";
import { ConflictError } from "@/server/lib/errors";
import { moneyUnits } from "@/shared/schemas/exact-money";
import { confirmLifecyclePlan } from "./lifecycle-plan";
// No integration may mark imported reminder risk verified until its full delivery
// inventory is mapped. Fresh candidate invoices cannot send reminders yet.
export const lifecycleRepository = {
  async deleted(userId: string, workspaceId: string) {
    return db
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        deletedAt: invoices.deletedAt,
      })
      .from(invoices)
      .innerJoin(workspaces, eq(workspaces.id, invoices.workspaceId))
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, workspaces.id),
          eq(workspaceMembers.userId, userId),
          eq(workspaceMembers.role, "owner"),
        ),
      )
      .where(
        and(
          eq(invoices.workspaceId, workspaceId),
          eq(workspaces.ownerId, userId),
          eq(invoices.deletedBy, userId),
          sql`${invoices.deletedAt} is not null`,
        ),
      )
      .orderBy(desc(invoices.deletedAt), desc(invoices.id))
      .limit(100);
  },
  async pending(userId: string, workspaceId: string) {
    const [row] = await db
      .select({
        id: proposals.id,
        invoiceId: proposals.invoiceId,
        invoiceNumber: proposals.invoiceNumber,
        state: proposals.state,
        hadPayment: proposals.hadPayment,
        hadSentReminder: proposals.hadSentReminder,
        expiresAt: proposals.expiresAt,
      })
      .from(proposals)
      .innerJoin(workspaces, eq(workspaces.id, proposals.workspaceId))
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, workspaces.id),
          eq(workspaceMembers.userId, userId),
          eq(workspaceMembers.role, "owner"),
        ),
      )
      .where(
        and(
          eq(proposals.workspaceId, workspaceId),
          eq(workspaces.ownerId, userId),
          eq(proposals.ownerId, userId),
          eq(proposals.state, "pending"),
          sql`${proposals.expiresAt}>clock_timestamp()`,
        ),
      )
      .limit(1);
    return row ?? null;
  },
  async act(
    userId: string,
    invoiceId: string,
    input: {
      action: "prepare" | "confirm" | "cancel" | "restore";
      key: string;
      proposalId?: string;
      confirmation?: string;
    },
  ) {
    return db.transaction(async (tx) => {
      const [invoice] = await tx
        .select()
        .from(invoices)
        .where(eq(invoices.id, invoiceId))
        .for("update");
      if (!invoice) return null;
      const [owner] = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .innerJoin(
          workspaceMembers,
          and(
            eq(workspaceMembers.workspaceId, workspaces.id),
            eq(workspaceMembers.userId, userId),
            eq(workspaceMembers.role, "owner"),
          ),
        )
        .where(
          and(
            eq(workspaces.id, invoice.workspaceId),
            eq(workspaces.ownerId, userId),
          ),
        )
        .for("share");
      if (!owner) return null;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${invoice.workspaceId + ":" + userId},19))`,
      );
      const clock = await tx.execute<{ now: Date | string }>(
        sql`select clock_timestamp() as now`,
      );
      const now = new Date(clock[0]!.now);
      if (!invoice.lifecycleRiskVerified)
        throw new ConflictError(
          "LIFECYCLE_RISK_UNKNOWN",
          "Reminder delivery state has not been verified for this invoice",
        );
      const [ledger] = await tx
        .select({ id: payments.id })
        .from(payments)
        .where(
          and(
            eq(payments.workspaceId, invoice.workspaceId),
            eq(payments.invoiceId, invoice.id),
          ),
        )
        .limit(1);
      const risk = {
        hadPayment:
          !!ledger ||
          invoice.financialStatus === "paid" ||
          moneyUnits(invoice.amountPaid) > 0n,
        hadSentReminder: false,
        activeDispatch: false,
      };
      const ownerScope = and(
        eq(proposals.workspaceId, invoice.workspaceId),
        eq(proposals.ownerId, userId),
      );
      if (input.action === "prepare") {
        const [replay] = await tx
          .select()
          .from(proposals)
          .where(and(ownerScope, eq(proposals.idempotencyKey, input.key)))
          .for("update");
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
        await tx
          .update(proposals)
          .set({ state: "expired" })
          .where(
            and(
              ownerScope,
              eq(proposals.state, "pending"),
              sql`${proposals.expiresAt}<=clock_timestamp()`,
            ),
          );
        const [pending] = await tx
          .select({ id: proposals.id })
          .from(proposals)
          .where(and(ownerScope, eq(proposals.state, "pending")))
          .limit(1);
        if (pending)
          throw new ConflictError(
            "ACTION_PENDING",
            "Complete or cancel the pending deletion first",
          );
        const [created] = await tx
          .insert(proposals)
          .values({
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
          })
          .returning();
        return created ?? null;
      }
      if (input.action === "restore") {
        const [replay] = await tx
          .select()
          .from(proposals)
          .where(and(ownerScope, eq(proposals.restoreKey, input.key)))
          .for("update");
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
        const [proposal] = await tx
          .select()
          .from(proposals)
          .where(
            and(
              ownerScope,
              eq(proposals.invoiceId, invoice.id),
              eq(proposals.state, "deleted"),
              eq(proposals.deletedAt, invoice.deletedAt),
            ),
          )
          .for("update");
        if (!proposal) return null;
        const followupState =
          ["paid", "void", "cancelled"].includes(invoice.financialStatus) ||
          moneyUnits(invoice.amountPaid) >= moneyUnits(invoice.amount)
            ? "cancelled"
            : "paused";
        await tx
          .update(invoices)
          .set({
            deletedAt: null,
            deletedBy: null,
            followupState,
            nextFollowUpAt: null,
            metadata: {
              ...invoice.metadata,
              followup_state: followupState,
              next_follow_up_at: null,
            },
          })
          .where(eq(invoices.id, invoiceId));
        const [restored] = await tx
          .update(proposals)
          .set({ state: "restored", restoreKey: input.key })
          .where(eq(proposals.id, proposal.id))
          .returning();
        return restored ?? null;
      }
      const [proposal] = await tx
        .select()
        .from(proposals)
        .where(
          and(
            ownerScope,
            eq(proposals.invoiceId, invoice.id),
            eq(proposals.id, input.proposalId!),
          ),
        )
        .for("update");
      if (!proposal) return null;
      if (input.action === "cancel") {
        if (proposal.state === "cancelled" && proposal.cancelKey === input.key)
          return proposal;
        if (proposal.state !== "pending" || proposal.expiresAt <= now)
          throw new ConflictError(
            "ACTION_STALE",
            "Deletion proposal changed or expired",
          );
        const [cancelled] = await tx
          .update(proposals)
          .set({ state: "cancelled", cancelKey: input.key })
          .where(eq(proposals.id, proposal.id))
          .returning();
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
      await tx
        .update(invoices)
        .set({
          deletedAt: planned.deletedAt,
          deletedBy: userId,
          followupState: "cancelled",
          nextFollowUpAt: null,
          metadata: {
            ...invoice.metadata,
            followup_state: "cancelled",
            next_follow_up_at: null,
          },
        })
        .where(eq(invoices.id, invoiceId));
      const [deleted] = await tx
        .update(proposals)
        .set({
          state: "deleted",
          deletedAt: planned.deletedAt,
          confirmationKey: input.key,
        })
        .where(eq(proposals.id, proposal.id))
        .returning();
      return deleted ?? null;
    });
  },
};
