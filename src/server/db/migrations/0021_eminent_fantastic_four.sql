CREATE TABLE "business_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"record_type" text NOT NULL,
	"name" text NOT NULL,
	"custom_fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	CONSTRAINT "business_record_deletion_pair" CHECK (("business_records"."deleted_at" is null)=("business_records"."deleted_by" is null)),
	CONSTRAINT "business_records_record_type_check" CHECK ("business_records"."record_type" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "business_records_name_check" CHECK (length(btrim("business_records"."name")) between 1 and 200 and "business_records"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "business_records_custom_fields_object" CHECK (jsonb_typeof("business_records"."custom_fields")='object' and octet_length("business_records"."custom_fields"::text)<=8192)
);
--> statement-breakpoint
ALTER TABLE "business_records" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "business_records" ADD CONSTRAINT "business_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_records" ADD CONSTRAINT "business_records_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "business_records_workspace_category_idx" ON "business_records" USING btree ("workspace_id","record_type","name");