CREATE TABLE "invoice_correction_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_event_id" text NOT NULL,
	"values" jsonb NOT NULL,
	"before_snapshot" jsonb NOT NULL,
	"after_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "invoice_correction_source_event_unique" UNIQUE("workspace_id","owner_id","source_kind","source_event_id"),
	CONSTRAINT "invoice_correction_source_kind_check" CHECK ("invoice_correction_audits"."source_kind" in ('whatsapp','dashboard'))
);
--> statement-breakpoint
ALTER TABLE "invoice_correction_audits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoice_correction_audits" ADD CONSTRAINT "invoice_correction_audits_workspace_id_invoice_id_invoices_workspace_id_id_fk" FOREIGN KEY ("workspace_id","invoice_id") REFERENCES "public"."invoices"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_correction_audits" ADD CONSTRAINT "invoice_correction_audits_workspace_id_owner_id_workspaces_id_owner_id_fk" FOREIGN KEY ("workspace_id","owner_id") REFERENCES "public"."workspaces"("id","owner_id") ON DELETE no action ON UPDATE no action;