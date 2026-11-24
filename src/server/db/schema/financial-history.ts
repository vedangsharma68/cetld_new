import "server-only";
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  jsonb,
  integer,
  bigint,
  primaryKey,
  foreignKey,
  unique,
  check,
} from "drizzle-orm/pg-core";
import { workspaces } from "./workspaces";
import { invoices } from "./invoices";
import { payments } from "./payments";
import { users } from "./users";
export const invoiceNumberSequences = pgTable(
  "invoice_number_sequences",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    invoiceYear: integer("invoice_year").notNull(),
    lastValue: bigint("last_value", { mode: "bigint" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.invoiceYear] }),
    check(
      "invoice_sequence_year_check",
      sql`${t.invoiceYear} between 2000 and 9999`,
    ),
    check("invoice_sequence_value_check", sql`${t.lastValue}>0`),
  ],
).enableRLS();
export const invoiceReopeningProposals = pgTable(
  "invoice_reopening_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    ownerId: uuid("owner_id").notNull(),
    phone: text("phone").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    sourceMessageId: text("source_message_id").notNull().unique(),
    invoiceNumber: text("invoice_number").notNull(),
    currency: text("currency").notNull(),
    amount: numeric("amount").notNull(),
    expectedUpdatedAt: timestamp("expected_updated_at", {
      withTimezone: true,
    }).notNull(),
    ledgerFingerprint: text("ledger_fingerprint").notNull(),
    paymentIds: uuid("payment_ids").array().notNull(),
    state: text("state").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    decisionMessageId: text("decision_message_id").unique(),
    result: jsonb("result"),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.ownerId],
      foreignColumns: [workspaces.id, workspaces.ownerId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.invoiceId],
      foreignColumns: [invoices.workspaceId, invoices.id],
    }).onDelete("cascade"),
    check(
      "reopening_amount_check",
      sql`${t.amount}>=0 and scale(${t.amount})<=2`,
    ),
    check(
      "reopening_state_check",
      sql`${t.state} in ('pending','confirmed','cancelled','expired','stale')`,
    ),
  ],
).enableRLS();
export const paymentReversals = pgTable(
  "payment_reversals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    invoiceId: uuid("invoice_id").notNull(),
    paymentId: uuid("payment_id").notNull(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => invoiceReopeningProposals.id),
    amount: numeric("amount").notNull(),
    actorId: uuid("actor_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason").notNull().default("owner_invoice_reopening"),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("reversal_business_payment_unique").on(t.workspaceId, t.paymentId),
    foreignKey({
      columns: [t.workspaceId, t.invoiceId],
      foreignColumns: [invoices.workspaceId, invoices.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.paymentId],
      foreignColumns: [payments.workspaceId, payments.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [workspaces.id, workspaces.ownerId],
    }),
    check(
      "reversal_amount_check",
      sql`${t.amount}>0 and scale(${t.amount})<=2`,
    ),
    check("reversal_reason_check", sql`${t.reason}='owner_invoice_reopening'`),
  ],
).enableRLS();
