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
  unique,
  check,
  jsonb,
} from "drizzle-orm/pg-core";
import { invoices } from "./invoices";
import { users } from "./users";
export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    recordedBy: uuid("recorded_by").references(() => users.id),
    amount: numeric("amount").notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }).notNull().defaultNow(),
    method: text("method"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    externalProvider: text("external_provider"),
    externalPaymentId: text("external_payment_id"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    syncStatus: text("sync_status"),
    lastSyncError: text("last_sync_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    reference: text("reference"),
    idempotencyKey: text("idempotency_key"),
    settleRemaining: boolean("settle_remaining").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("payments_business_id_unique").on(t.workspaceId, t.id),
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
