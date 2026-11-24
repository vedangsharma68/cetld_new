import "server-only";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { workspaces } from "./workspaces";
export const workspaceSettings = pgTable("workspace_settings", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id),
  businessName: text("business_name"),
  defaultCurrency: text("default_currency").notNull().default("INR"),
  defaultTimezone: text("default_timezone").notNull().default("Asia/Kolkata"),
  followUpPreferences: jsonb("follow_up_preferences")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  whatsappOwnerAttestedAt: timestamp("whatsapp_owner_attested_at", {
    withTimezone: true,
  }),
  whatsappOwnerAttestedBy: uuid("whatsapp_owner_attested_by").references(
    () => users.id,
  ),
  whatsappOwnerPhone: text("whatsapp_owner_phone"),
  ownerBotPreferences: jsonb("owner_bot_preferences")
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),
  offlineInvoiceProvenance: boolean("offline_invoice_provenance")
    .notNull()
    .default(false),
}).enableRLS();
export const workspaceAiSettings = pgTable("workspace_ai_settings", {
  workspaceId: uuid("workspace_id")
    .primaryKey()
    .references(() => workspaces.id),
  primaryModel: text("primary_model").notNull(),
  fallbackModel: text("fallback_model"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  offlineInvoiceProvenance: boolean("offline_invoice_provenance")
    .notNull()
    .default(false),
}).enableRLS();
