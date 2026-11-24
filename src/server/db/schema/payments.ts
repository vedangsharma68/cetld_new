import "server-only";
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  numeric,
  boolean,
  timestamp,
  foreignKey,
  uniqueIndex,
  check,
} from "drizzle-orm/pg-core";
import { invoices } from "./invoices";
import { users } from "./users";
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => users.id),
    amount: numeric("amount").notNull(),
    reference: text("reference"),
    idempotencyKey: text("idempotency_key").notNull(),
    settleRemaining: boolean("settle_remaining").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.invoiceId],
      foreignColumns: [invoices.workspaceId, invoices.id],
    }),
    uniqueIndex("payments_business_idempotency").on(
      t.workspaceId,
      t.idempotencyKey,
    ),
    check(
      "payments_amount_check",
      sql`${t.amount}>0 and scale(${t.amount})<=2 and ${t.amount}<10000000000000000`,
    ),
  ],
).enableRLS();
