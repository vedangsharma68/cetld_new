CREATE TABLE "invoice_number_sequences" (
	"workspace_id" uuid NOT NULL,
	"invoice_year" integer NOT NULL,
	"last_value" bigint NOT NULL,
	CONSTRAINT "invoice_number_sequences_workspace_id_invoice_year_pk" PRIMARY KEY("workspace_id","invoice_year"),
	CONSTRAINT "invoice_sequence_year_check" CHECK ("invoice_number_sequences"."invoice_year" between 2000 and 9999),
	CONSTRAINT "invoice_sequence_value_check" CHECK ("invoice_number_sequences"."last_value">0)
);
--> statement-breakpoint
ALTER TABLE "invoice_number_sequences" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "invoice_reopening_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"phone" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"source_message_id" text NOT NULL,
	"invoice_number" text NOT NULL,
	"currency" text NOT NULL,
	"amount" numeric NOT NULL,
	"expected_updated_at" timestamp with time zone NOT NULL,
	"ledger_fingerprint" text NOT NULL,
	"payment_ids" uuid[] NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decision_message_id" text,
	"result" jsonb,
	CONSTRAINT "invoice_reopening_proposals_source_message_id_unique" UNIQUE("source_message_id"),
	CONSTRAINT "invoice_reopening_proposals_decision_message_id_unique" UNIQUE("decision_message_id"),
	CONSTRAINT "reopening_amount_check" CHECK ("invoice_reopening_proposals"."amount">=0 and scale("invoice_reopening_proposals"."amount")<=2),
	CONSTRAINT "reopening_state_check" CHECK ("invoice_reopening_proposals"."state" in ('pending','confirmed','cancelled','expired','stale'))
);
--> statement-breakpoint
ALTER TABLE "invoice_reopening_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "payment_reversals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"proposal_id" uuid NOT NULL,
	"amount" numeric NOT NULL,
	"actor_id" uuid NOT NULL,
	"reason" text DEFAULT 'owner_invoice_reopening' NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reversal_business_payment_unique" UNIQUE("workspace_id","payment_id"),
	CONSTRAINT "reversal_amount_check" CHECK ("payment_reversals"."amount">0 and scale("payment_reversals"."amount")<=2),
	CONSTRAINT "reversal_reason_check" CHECK ("payment_reversals"."reason"='owner_invoice_reopening')
);
--> statement-breakpoint
ALTER TABLE "payment_reversals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_number_sequences" ADD CONSTRAINT "invoice_number_sequences_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_reopening_proposals" ADD CONSTRAINT "invoice_reopening_proposals_workspace_id_owner_id_workspaces_id_owner_id_fk" FOREIGN KEY ("workspace_id","owner_id") REFERENCES "public"."workspaces"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_reopening_proposals" ADD CONSTRAINT "invoice_reopening_proposals_workspace_id_invoice_id_invoices_workspace_id_id_fk" FOREIGN KEY ("workspace_id","invoice_id") REFERENCES "public"."invoices"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_proposal_id_invoice_reopening_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."invoice_reopening_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_workspace_id_invoice_id_invoices_workspace_id_id_fk" FOREIGN KEY ("workspace_id","invoice_id") REFERENCES "public"."invoices"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_business_id_unique" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_workspace_id_payment_id_payments_workspace_id_id_fk" FOREIGN KEY ("workspace_id","payment_id") REFERENCES "public"."payments"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_reversals" ADD CONSTRAINT "payment_reversals_workspace_id_actor_id_workspaces_id_owner_id_fk" FOREIGN KEY ("workspace_id","actor_id") REFERENCES "public"."workspaces"("id","owner_id") ON DELETE no action ON UPDATE no action;