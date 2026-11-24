ALTER TABLE "users" ADD COLUMN "banned_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;