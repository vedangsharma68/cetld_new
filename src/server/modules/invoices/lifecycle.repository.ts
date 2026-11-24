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
  async withLockedInvoice<T>(
    userId: string,
    invoiceId: string,
    run: (context: LifecycleContext) => Promise<T>,
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
      const ownerScope = and(
        eq(proposals.workspaceId, invoice.workspaceId),
        eq(proposals.ownerId, userId),
      );
      const first = <T>(rows: T[]) => rows[0] ?? null;
      const store = {
        payment: async () =>
          first(
            await tx
              .select({ id: payments.id })
              .from(payments)
              .where(
                and(
                  eq(payments.workspaceId, invoice.workspaceId),
                  eq(payments.invoiceId, invoice.id),
                ),
              )
              .limit(1),
          ),
        byPrepareKey: async (key: string) =>
          first(
            await tx
              .select()
              .from(proposals)
              .where(and(ownerScope, eq(proposals.idempotencyKey, key)))
              .for("update"),
          ),
        byRestoreKey: async (key: string) =>
          first(
            await tx
              .select()
              .from(proposals)
              .where(and(ownerScope, eq(proposals.restoreKey, key)))
              .for("update"),
          ),
        expirePending: async () => {
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
        },
        pending: async () =>
          first(
            await tx
              .select({ id: proposals.id })
              .from(proposals)
              .where(and(ownerScope, eq(proposals.state, "pending")))
              .limit(1),
          ),
        create: async (values: typeof proposals.$inferInsert) =>
          first(await tx.insert(proposals).values(values).returning()),
        deletedProposal: async () =>
          first(
            await tx
              .select()
              .from(proposals)
              .where(
                and(
                  ownerScope,
                  eq(proposals.invoiceId, invoice.id),
                  eq(proposals.state, "deleted"),
                  eq(proposals.deletedAt, invoice.deletedAt!),
                ),
              )
              .for("update"),
          ),
        proposal: async (id: string) =>
          first(
            await tx
              .select()
              .from(proposals)
              .where(
                and(
                  ownerScope,
                  eq(proposals.invoiceId, invoice.id),
                  eq(proposals.id, id),
                ),
              )
              .for("update"),
          ),
        updateInvoice: async (
          values: Partial<typeof invoices.$inferInsert>,
        ) => {
          await tx
            .update(invoices)
            .set(values)
            .where(eq(invoices.id, invoice.id));
        },
        updateProposal: async (
          id: string,
          values: Partial<typeof proposals.$inferInsert>,
        ) =>
          first(
            await tx
              .update(proposals)
              .set(values)
              .where(
                and(
                  ownerScope,
                  eq(proposals.invoiceId, invoice.id),
                  eq(proposals.id, id),
                ),
              )
              .returning(),
          ),
      };
      return run({ invoice, now, store });
    });
  },
};
type LifecycleContext = {
  invoice: typeof invoices.$inferSelect;
  now: Date;
  store: {
    payment(): Promise<{ id: string } | null>;
    byPrepareKey(key: string): Promise<typeof proposals.$inferSelect | null>;
    byRestoreKey(key: string): Promise<typeof proposals.$inferSelect | null>;
    expirePending(): Promise<void>;
    pending(): Promise<{ id: string } | null>;
    create(
      values: typeof proposals.$inferInsert,
    ): Promise<typeof proposals.$inferSelect | null>;
    deletedProposal(): Promise<typeof proposals.$inferSelect | null>;
    proposal(id: string): Promise<typeof proposals.$inferSelect | null>;
    updateInvoice(values: Partial<typeof invoices.$inferInsert>): Promise<void>;
    updateProposal(
      id: string,
      values: Partial<typeof proposals.$inferInsert>,
    ): Promise<typeof proposals.$inferSelect | null>;
  };
};
