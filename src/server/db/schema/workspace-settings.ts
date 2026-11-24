import "server-only";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  boolean,
  check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";
import { workspaces } from "./workspaces";
export const workspaceSettings = pgTable(
  "workspace_settings",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
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
      { onDelete: "restrict" },
    ),
    whatsappOwnerPhone: text("whatsapp_owner_phone"),
    ownerBotPreferences: jsonb("owner_bot_preferences")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    offlineInvoiceProvenance: boolean("offline_invoice_provenance")
      .notNull()
      .default(false),
  },
  () => [
    check(
      "workspace_settings_business_name_check",
      sql.raw(
        "(((business_name IS NULL) OR ((length(btrim(business_name)) >= 1) AND (length(btrim(business_name)) <= 200))))",
      ),
    ),
    check(
      "workspace_settings_default_currency_check",
      sql.raw("((default_currency ~ '^[A-Z]{3}$'::text))"),
    ),
    check(
      "workspace_settings_follow_up_preferences_check",
      sql.raw("((jsonb_typeof(follow_up_preferences) = 'object'::text))"),
    ),
    check(
      "workspace_settings_owner_bot_preferences_object",
      sql.raw(
        "(((jsonb_typeof(owner_bot_preferences) = 'object'::text) AND (octet_length((owner_bot_preferences)::text) <= 8192)))",
      ),
    ),
    check(
      "workspace_settings_whatsapp_owner_phone_check",
      sql.raw(
        "(((whatsapp_owner_phone IS NULL) OR (whatsapp_owner_phone ~ '^\\+[1-9][0-9]{7,14}$'::text)))",
      ),
    ),
  ],
).enableRLS();
export const workspaceAiSettings = pgTable(
  "workspace_ai_settings",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
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
  },
  () => [
    check(
      "workspace_ai_settings_fallback_model_check",
      sql.raw(
        "(((fallback_model IS NULL) OR (fallback_model = ANY (ARRAY['@cf/meta/llama-3.3-70b-instruct-fp8-fast'::text, '@cf/meta/llama-4-scout-17b-16e-instruct'::text, '@cf/mistralai/mistral-small-3.1-24b-instruct'::text, '@cf/openai/gpt-oss-20b'::text, '@cf/qwen/qwen3-30b-a3b-fp8'::text, '@cf/zai-org/glm-4.7-flash'::text, 'space-bunny-free'::text, 'longcat-2.5-preview-free'::text, 'gemini-3.5-flash'::text, 'gemini-3.5-flash-lite'::text, 'gpt-oss:20b-cloud'::text])) OR ((length(fallback_model) <= 100) AND (fallback_model ~ '^[a-z0-9][a-z0-9.-]*-free$'::text))))",
      ),
    ),
    check(
      "workspace_ai_settings_models_different",
      sql.raw(
        "(((fallback_model IS NULL) OR (fallback_model <> primary_model)))",
      ),
    ),
    check(
      "workspace_ai_settings_primary_model_check",
      sql.raw(
        "(((primary_model = ANY (ARRAY['@cf/meta/llama-3.3-70b-instruct-fp8-fast'::text, '@cf/meta/llama-4-scout-17b-16e-instruct'::text, '@cf/mistralai/mistral-small-3.1-24b-instruct'::text, '@cf/openai/gpt-oss-20b'::text, '@cf/qwen/qwen3-30b-a3b-fp8'::text, '@cf/zai-org/glm-4.7-flash'::text, 'gemini-3.5-flash'::text, 'gemini-3.5-flash-lite'::text, 'space-bunny-free'::text])) OR ((length(primary_model) <= 100) AND (primary_model ~ '^[a-z0-9][a-z0-9.-]*-free$'::text))))",
      ),
    ),
  ],
).enableRLS();
