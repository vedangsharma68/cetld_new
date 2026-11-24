CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"recorded_by" uuid NOT NULL,
	"amount" numeric NOT NULL,
	"reference" text,
	"idempotency_key" text NOT NULL,
	"settle_remaining" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_check" CHECK ("payments"."amount">0 and scale("payments"."amount")<=2 and "payments"."amount"<10000000000000000)
);
--> statement-breakpoint
ALTER TABLE "payments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_amount_check";--> statement-breakpoint
ALTER TABLE "invoices" ALTER COLUMN "amount" SET DATA TYPE numeric;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "amount_paid" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "financial_status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_workspace_id_pair" ON "invoices" USING btree ("workspace_id","id");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_workspace_id_invoice_id_invoices_workspace_id_id_fk" FOREIGN KEY ("workspace_id","invoice_id") REFERENCES "public"."invoices"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_business_idempotency" ON "payments" USING btree ("workspace_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_paid_amount_check" CHECK ("invoices"."amount_paid">=0 and "invoices"."amount_paid"<="invoices"."amount" and scale("invoices"."amount_paid")<=2);--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_financial_status_check" CHECK ("invoices"."financial_status" in ('draft','open','partially_paid','paid','void','cancelled'));--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_amount_check" CHECK ("invoices"."amount">=0 and scale("invoices"."amount")<=2 and "invoices"."amount"<10000000000000000);