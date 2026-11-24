import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/server/db/client";
import {
  invoices,
  payments,
  paymentReversals,
  webReopeningProposals as proposals,
  workspaceMembers,
  workspaces,
} from "@/server/db/schema";
export const reopeningRepository = {
  async withLockedInvoice<T>(
    userId: string,
    invoiceId: string,
    run: (context: ReopeningContext) => Promise<T>,
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
      const clock = await tx.execute<{ now: Date; today: string }>(
        sql`select clock_timestamp() now, (clock_timestamp() at time zone coalesce((select default_timezone from workspace_settings where workspace_id=${invoice.workspaceId}),'UTC'))::date::text today`,
      );
      const receipts = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.workspaceId, invoice.workspaceId),
            eq(payments.invoiceId, invoiceId),
          ),
        )
        .for("update");
      const reversals = await tx
        .select()
        .from(paymentReversals)
        .where(
          and(
            eq(paymentReversals.workspaceId, invoice.workspaceId),
            eq(paymentReversals.invoiceId, invoiceId),
          ),
        )
        .for("share");
      const scope = and(
        eq(proposals.workspaceId, invoice.workspaceId),
        eq(proposals.ownerId, userId),
        eq(proposals.invoiceId, invoiceId),
      );
      const first = <T>(rows: T[]) => rows[0] ?? null;
      return run({
        invoice,
        receipts,
        reversals,
        now: new Date(clock[0]!.now),
        today: clock[0]!.today,
        store: {
          prepare: async (key: string) =>
            first(
              await tx
                .select()
                .from(proposals)
                .where(eq(proposals.prepareKey, key))
                .for("update"),
            ),
          proposal: async (id: string) =>
            first(
              await tx
                .select()
                .from(proposals)
                .where(and(scope, eq(proposals.id, id)))
                .for("update"),
            ),
          create: async (values: typeof proposals.$inferInsert) =>
            first(await tx.insert(proposals).values(values).returning()),
          update: async (
            id: string,
            values: Partial<typeof proposals.$inferInsert>,
          ) =>
            first(
              await tx
                .update(proposals)
                .set(values)
                .where(and(scope, eq(proposals.id, id)))
                .returning(),
            ),
          reverse: async (values: (typeof paymentReversals.$inferInsert)[]) => {
            if (values.length) await tx.insert(paymentReversals).values(values);
          },
          updateInvoice: async (
            values: Partial<typeof invoices.$inferInsert>,
          ) => {
            await tx
              .update(invoices)
              .set(values)
              .where(eq(invoices.id, invoiceId));
          },
        },
      });
    });
  },
};
type ReopeningContext = {
  invoice: typeof invoices.$inferSelect;
  receipts: (typeof payments.$inferSelect)[];
  reversals: (typeof paymentReversals.$inferSelect)[];
  now: Date;
  today: string;
  store: {
    prepare(key: string): Promise<typeof proposals.$inferSelect | null>;
    proposal(id: string): Promise<typeof proposals.$inferSelect | null>;
    create(
      values: typeof proposals.$inferInsert,
    ): Promise<typeof proposals.$inferSelect | null>;
    update(
      id: string,
      values: Partial<typeof proposals.$inferInsert>,
    ): Promise<typeof proposals.$inferSelect | null>;
    reverse(values: (typeof paymentReversals.$inferInsert)[]): Promise<void>;
    updateInvoice(values: Partial<typeof invoices.$inferInsert>): Promise<void>;
  };
};
