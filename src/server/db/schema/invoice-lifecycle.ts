import "server-only";
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  uniqueIndex,
  index,
  foreignKey,
  check,
  jsonb,
} from "drizzle-orm/pg-core";
import { invoices } from "./invoices";
import { users } from "./users";
import { workspaces } from "./workspaces";
export const invoiceLifecycleProposals = pgTable(
  "invoice_lifecycle_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    invoiceId: uuid("invoice_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state", {
      enum: ["pending", "cancelled", "deleted", "restored", "expired", "stale"],
    })
      .notNull()
      .default("pending"),
    revision: text("revision").notNull(),
    invoiceNumber: text("invoice_number").notNull(),
    hadPayment: boolean("had_payment").notNull(),
    hadSentReminder: boolean("had_sent_reminder").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    confirmationKey: text("confirmation_key"),
    cancelKey: text("cancel_key"),
    restoreKey: text("restore_key"),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.invoiceId],
      foreignColumns: [invoices.workspaceId, invoices.id],
    }),
    uniqueIndex("lifecycle_business_owner_key").on(
      t.workspaceId,
      t.ownerId,
      t.idempotencyKey,
    ),
    uniqueIndex("lifecycle_business_restore_key").on(
      t.workspaceId,
      t.restoreKey,
    ),
    index("lifecycle_business_owner_state").on(
      t.workspaceId,
      t.ownerId,
      t.state,
    ),
    check(
      "lifecycle_state_check",
      sql`${t.state} in ('pending','cancelled','deleted','restored','expired','stale')`,
    ),
  ],
).enableRLS();
