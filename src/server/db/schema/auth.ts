import "server-only";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  primaryKey,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users";
export const providerAccounts = pgTable(
  "provider_accounts",
  {
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.providerAccountId] }),
  ],
).enableRLS();
export const signupInvites = pgTable("signup_invites_v2", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull(),
  codeHash: text("code_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}).enableRLS();
export const authRateLimits = pgTable(
  "auth_rate_limits",
  {
    key: text("key").primaryKey(),
    count: integer("count").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  },
  (table) => [index("auth_rate_limits_window_idx").on(table.windowStart)],
).enableRLS();
