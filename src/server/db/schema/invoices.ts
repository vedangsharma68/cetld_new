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
    amount: numeric("amount", { precision: 18, scale: 2 }).notNull(),
    currency: text("currency").notNull(),
    status: text("status", { enum: ["pending_upload", "uploaded"] })
      .notNull()
      .default("pending_upload"),
    filePath: text("file_path"),
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
    check("invoices_amount_check", sql`${t.amount}>=0`),
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
