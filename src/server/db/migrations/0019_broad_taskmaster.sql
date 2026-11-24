CREATE TABLE "web_reopening_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"prepare_key" text NOT NULL,
	"decision_key" text,
	"state" text DEFAULT 'pending' NOT NULL,
	"revision" integer NOT NULL,
	"ledger_fingerprint" text NOT NULL,
	"amount" numeric NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_reopening_proposals_prepare_key_unique" UNIQUE("prepare_key"),
	CONSTRAINT "web_reopening_proposals_decision_key_unique" UNIQUE("decision_key"),
	CONSTRAINT "web_reopening_state_check" CHECK ("web_reopening_proposals"."state" in ('pending','confirmed','cancelled')),
	CONSTRAINT "web_reopening_amount_check" CHECK ("web_reopening_proposals"."amount">=0 and scale("web_reopening_proposals"."amount")<=2)
);
--> statement-breakpoint
ALTER TABLE "web_reopening_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_reversals" ALTER COLUMN "proposal_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_reversals" ADD COLUMN "web_proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "web_reopening_proposals" ADD CONSTRAINT "web_reopening_proposals_workspace_id_owner_id_workspaces_id_owner_id_fk" FOREIGN KEY ("workspace_id","owner_id") REFERENCES "public"."workspaces"("id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_reopening_proposals" ADD CONSTRAINT "web_reopening_proposals_workspace_id_invoice_id_invoices_workspace_id_id_fk" FOREIGN KEY ("workspace_id","invoice_id") REFERENCES "public"."invoices"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_web_proposal_id_web_reopening_proposals_id_fk" FOREIGN KEY ("web_proposal_id") REFERENCES "public"."web_reopening_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reversals" ADD CONSTRAINT "reversal_single_provenance_check" CHECK (("payment_reversals"."proposal_id" is null) <> ("payment_reversals"."web_proposal_id" is null));