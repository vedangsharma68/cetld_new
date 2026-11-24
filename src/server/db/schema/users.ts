import "server-only";
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  check,
} from "drizzle-orm/pg-core";
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    name: text("name"),
    role: text("role", { enum: ["admin", "member"] })
      .notNull()
      .default("member"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    passwordHash: text("password_hash"),
    sessionVersion: integer("session_version").notNull().default(0),
    image: text("image"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("users_role_check", sql`${table.role} in ('admin','member')`),
  ],
).enableRLS();
