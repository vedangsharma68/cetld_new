CREATE TABLE "workspace_ai_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"primary_model" text NOT NULL,
	"fallback_model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"offline_invoice_provenance" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_ai_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"business_name" text,
	"default_currency" text DEFAULT 'INR' NOT NULL,
	"default_timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"follow_up_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"whatsapp_owner_attested_at" timestamp with time zone,
	"whatsapp_owner_attested_by" uuid,
	"whatsapp_owner_phone" text,
	"owner_bot_preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"offline_invoice_provenance" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspace_ai_settings" ADD CONSTRAINT "workspace_ai_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_whatsapp_owner_attested_by_users_id_fk" FOREIGN KEY ("whatsapp_owner_attested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;