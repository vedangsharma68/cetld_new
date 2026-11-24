CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"customer_id" uuid,
	"invoice_number" text NOT NULL,
	"amount" numeric(18, 2) NOT NULL,
	"currency" text NOT NULL,
	"status" text DEFAULT 'pending_upload' NOT NULL,
	"file_path" text,
	"file_size" integer,
	"mime_type" text,
	"uploaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_status_check" CHECK ("invoices"."status" in ('pending_upload','uploaded')),
	CONSTRAINT "invoices_path_check" CHECK ("invoices"."file_path" is null or "invoices"."file_path"="invoices"."owner_id"::text||'/'||"invoices"."id"::text||'.pdf'),
	CONSTRAINT "invoices_uploaded_check" CHECK ("invoices"."status"<>'uploaded' or ("invoices"."file_path" is not null and "invoices"."file_size" is not null and "invoices"."mime_type"='application/pdf' and "invoices"."uploaded_at" is not null)),
	CONSTRAINT "invoices_amount_check" CHECK ("invoices"."amount">=0),
	CONSTRAINT "invoices_pdf_check" CHECK ("invoices"."mime_type" is null or "invoices"."mime_type"='application/pdf'),
	CONSTRAINT "invoices_size_check" CHECK ("invoices"."file_size" is null or ("invoices"."file_size">0 and "invoices"."file_size"<=10485760))
);
--> statement-breakpoint
ALTER TABLE "invoices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "storage_cleanup_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path" text NOT NULL,
	"request_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "storage_cleanup_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_workspace_id_customer_id_customers_workspace_id_id_fk" FOREIGN KEY ("workspace_id","customer_id") REFERENCES "public"."customers"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_business_number_unique" ON "invoices" USING btree ("workspace_id","invoice_number");--> statement-breakpoint
CREATE INDEX "storage_cleanup_age_idx" ON "storage_cleanup_jobs" USING btree ("created_at");