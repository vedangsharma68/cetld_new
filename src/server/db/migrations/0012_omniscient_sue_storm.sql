ALTER TABLE "payments" ALTER COLUMN "recorded_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ALTER COLUMN "idempotency_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "issue_date" date;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "due_date" date;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "external_provider" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "external_invoice_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "sync_status" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "last_sync_error" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "last_follow_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "reminder_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "customer_phone" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "follow_up_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "automation_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "paid_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "method" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "external_provider" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "external_payment_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "sync_status" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "last_sync_error" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;