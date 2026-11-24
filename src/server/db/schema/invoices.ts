import "server-only";
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  integer,
  check,
  foreignKey,
  index,
  uniqueIndex,
  jsonb,
  boolean,
  date,
  bigint,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { workspaces } from "./workspaces";
import { customers } from "./customers";
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    customerId: uuid("customer_id"),
    invoiceNumber: text("invoice_number").notNull(),
    amount: numeric("amount").notNull(),
    amountPaid: numeric("amount_paid").notNull().default("0"),
    financialStatus: text("financial_status", {
      enum: [
        "draft",
        "open",
        "partially_paid",
        "sent",
        "overdue",
        "paid",
        "void",
        "cancelled",
      ],
    })
      .notNull()
      .default("draft"),
    issueDate: date("issue_date"),
    dueDate: date("due_date"),
    notes: text("notes"),
    customFields: jsonb("custom_fields")
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
    externalProvider: text("external_provider"),
    externalInvoiceId: text("external_invoice_id"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    syncStatus: text("sync_status"),
    lastSyncError: text("last_sync_error"),
    lastFollowUpAt: timestamp("last_follow_up_at", { withTimezone: true }),
    reminderCount: integer("reminder_count").notNull().default(0),
    customerPhone: text("customer_phone"),
    followUpSettings: jsonb("follow_up_settings")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    automationVersion: bigint("automation_version", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    revision: integer("revision").notNull().default(0),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    followupState: text("followup_state", {
      enum: ["paused", "cancelled", "scheduled"],
    })
      .notNull()
      .default("paused"),
    nextFollowUpAt: timestamp("next_follow_up_at", { withTimezone: true }),
    lifecycleRiskVerified: boolean("lifecycle_risk_verified")
      .notNull()
      .default(false),
    deletedBy: uuid("deleted_by").references(() => users.id),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    currency: text("currency").notNull(),
    status: text("status", { enum: ["pending_upload", "uploaded"] })
      .notNull()
      .default("pending_upload"),
    filePath: text("file_path"),
    originalFileName: text("original_file_name"),
    fileSize: integer("file_size"),
    mimeType: text("mime_type"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.customerId],
      foreignColumns: [customers.workspaceId, customers.id],
    }),
    uniqueIndex("invoices_business_number_unique").on(
      t.workspaceId,
      t.invoiceNumber,
    ),
    check(
      "invoices_status_check",
      sql`${t.status} in ('pending_upload','uploaded')`,
    ),
    check(
      "invoices_path_check",
      sql`${t.filePath} is null or ${t.filePath}=${t.ownerId}::text||'/'||${t.id}::text||'.pdf'`,
    ),
    check(
      "invoices_uploaded_check",
      sql`${t.status}<>'uploaded' or (${t.filePath} is not null and ${t.fileSize} is not null and ${t.mimeType}='application/pdf' and ${t.uploadedAt} is not null)`,
    ),
    check(
      "invoices_amount_check",
      sql`${t.amount}>=0 and scale(${t.amount})<=2 and ${t.amount}<10000000000000000`,
    ),
    check(
      "invoices_paid_amount_check",
      sql`${t.amountPaid}>=0 and ${t.amountPaid}<=${t.amount} and scale(${t.amountPaid})<=2`,
    ),
    check(
      "invoices_financial_status_check",
      sql`${t.financialStatus} in ('draft','open','partially_paid','sent','overdue','paid','void','cancelled')`,
    ),
    uniqueIndex("invoices_workspace_id_pair").on(t.workspaceId, t.id),
    check(
      "invoices_pdf_check",
      sql`${t.mimeType} is null or ${t.mimeType}='application/pdf'`,
    ),
    check(
      "invoices_size_check",
      sql`${t.fileSize} is null or (${t.fileSize}>0 and ${t.fileSize}<=10485760)`,
    ),
  ],
).enableRLS();
export const storageCleanup = pgTable(
  "storage_cleanup_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    path: text("path").notNull(),
    requestId: text("request_id").notNull(),
    notBefore: timestamp("not_before", { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()+interval '3 hours'`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("storage_cleanup_age_idx").on(t.createdAt)],
).enableRLS();
