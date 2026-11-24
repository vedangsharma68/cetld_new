import "server-only";
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  check,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users";
import { workspaces } from "./workspaces";
export const businessRecords = pgTable(
  "business_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    recordType: text("record_type").notNull(),
    name: text("name").notNull(),
    customFields: jsonb("custom_fields")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by").references(() => users.id),
  },
  (t) => [
    check(
      "business_record_deletion_pair",
      sql`(${t.deletedAt} is null)=(${t.deletedBy} is null)`,
    ),
    check(
      "business_records_record_type_check",
      sql`${t.recordType} ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
    check(
      "business_records_name_check",
      sql`length(btrim(${t.name})) between 1 and 200 and ${t.name} !~ '[[:cntrl:]]'`,
    ),
    check(
      "business_records_custom_fields_object",
      sql`jsonb_typeof(${t.customFields})='object' and octet_length(${t.customFields}::text)<=8192`,
    ),
    index("business_records_workspace_category_idx").on(
      t.workspaceId,
      t.recordType,
      t.name,
    ),
  ],
).enableRLS();
