import "server-only";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  primaryKey,
  check,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./users";
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").unique(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("workspaces_id_owner_id_key").on(table.id, table.ownerId),
    check(
      "workspaces_name_check",
      sql.raw(
        "(((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 160)))",
      ),
    ),
    check(
      "workspaces_slug_check",
      sql.raw("((slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'::text))"),
    ),
  ],
).enableRLS();
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    role: text("role", { enum: ["owner", "admin", "member"] })
      .notNull()
      .default("member"),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.userId] }),
    check(
      "workspace_members_role_check",
      sql`${table.role} in ('owner','admin','member')`,
    ),
  ],
).enableRLS();
