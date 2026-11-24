import "server-only";
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
export const emailSignups = pgTable(
  "email_signup_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull(),
    businessName: text("business_name").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [index("email_signup_expiry_idx").on(table.expiresAt)],
).enableRLS();
