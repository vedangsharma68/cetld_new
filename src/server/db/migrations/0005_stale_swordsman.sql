CREATE TABLE "email_signup_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"name" text NOT NULL,
	"business_name" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "email_signup_verifications_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "email_signup_verifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email_verified_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "email_signup_expiry_idx" ON "email_signup_verifications" USING btree ("expires_at");