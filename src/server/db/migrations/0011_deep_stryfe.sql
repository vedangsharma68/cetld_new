CREATE TABLE "invoice_lifecycle_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"revision" text NOT NULL,
	"invoice_number" text NOT NULL,
	"had_payment" boolean NOT NULL,
	"had_sent_reminder" boolean NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"confirmation_key" text,
	"cancel_key" text,
	"restore_key" text,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lifecycle_state_check" CHECK ("invoice_lifecycle_proposals"."state" in ('pending','cancelled','deleted','restored','expired','stale'))
);
--> statement-breakpoint
ALTER TABLE "invoice_lifecycle_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "followup_state" text DEFAULT 'paused' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "next_follow_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "lifecycle_risk_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lifecycle_proposals" ADD CONSTRAINT "invoice_lifecycle_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lifecycle_proposals" ADD CONSTRAINT "invoice_lifecycle_proposals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lifecycle_proposals" ADD CONSTRAINT "invoice_lifecycle_proposals_workspace_id_invoice_id_invoices_workspace_id_id_fk" FOREIGN KEY ("workspace_id","invoice_id") REFERENCES "public"."invoices"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lifecycle_business_owner_key" ON "invoice_lifecycle_proposals" USING btree ("workspace_id","owner_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "lifecycle_business_restore_key" ON "invoice_lifecycle_proposals" USING btree ("workspace_id","restore_key");--> statement-breakpoint
CREATE INDEX "lifecycle_business_owner_state" ON "invoice_lifecycle_proposals" USING btree ("workspace_id","owner_id","state");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE FUNCTION bump_invoice_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.revision := OLD.revision + 1; RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER invoice_revision_change BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION bump_invoice_revision();

