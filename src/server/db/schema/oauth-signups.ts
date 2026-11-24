import "server-only";
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { signupInvites } from "./auth";
export const oauthSignups = pgTable(
  "oauth_signup_challenges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    email: text("email").notNull(),
    inviteId: uuid("invite_id")
      .notNull()
      .references(() => signupInvites.id),
    name: text("name").notNull(),
    businessName: text("business_name").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [index("oauth_signup_expiry_idx").on(table.expiresAt)],
).enableRLS();
