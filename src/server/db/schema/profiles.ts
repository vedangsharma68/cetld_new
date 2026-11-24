import "server-only";
import { sql } from "drizzle-orm";
import { pgTable, uuid, text, timestamp, check } from "drizzle-orm/pg-core";
import { users } from "./users";
export const profiles = pgTable(
  "profiles",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "cascade" }),
    fullName: text("full_name"),
    avatarUrl: text("avatar_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check(
      "profiles_full_name_check",
      sql`${t.fullName} is null or length(btrim(${t.fullName})) between 1 and 160`,
    ),
  ],
).enableRLS();
