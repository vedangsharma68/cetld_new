ALTER TABLE "customers" ADD COLUMN "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "external_provider" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "external_customer_id" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "last_synced_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "sync_status" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "last_sync_error" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "reminder_tone" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;