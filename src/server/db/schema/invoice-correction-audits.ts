import "server-only";
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  check,
  foreignKey,
  unique,
} from "drizzle-orm/pg-core";
import { invoices } from "./invoices";
import { workspaces } from "./workspaces";
// Preservation table. No write/update/delete API is exposed by this slice.
export const invoiceCorrectionAudits = pgTable(
  "invoice_correction_audits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    values: jsonb("values").$type<unknown>().notNull(),
    beforeSnapshot: jsonb("before_snapshot").$type<unknown>().notNull(),
    afterSnapshot: jsonb("after_snapshot").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (t) => [
    check(
      "invoice_correction_source_kind_check",
      sql`${t.sourceKind} in ('whatsapp','dashboard')`,
    ),
    foreignKey({
      columns: [t.workspaceId, t.invoiceId],
      foreignColumns: [invoices.workspaceId, invoices.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.ownerId],
      foreignColumns: [workspaces.id, workspaces.ownerId],
    }),
    unique("invoice_correction_source_event_unique").on(
      t.workspaceId,
      t.ownerId,
      t.sourceKind,
      t.sourceEventId,
    ),
  ],
).enableRLS();
