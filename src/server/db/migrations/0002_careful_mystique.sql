CREATE TABLE "oauth_signup_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"invite_id" uuid NOT NULL,
	"name" text NOT NULL,
	"business_name" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "oauth_signup_challenges_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "oauth_signup_challenges" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "oauth_signup_challenges" ADD CONSTRAINT "oauth_signup_challenges_invite_id_signup_invites_v2_id_fk" FOREIGN KEY ("invite_id") REFERENCES "public"."signup_invites_v2"("id") ON DELETE no action ON UPDATE no action;