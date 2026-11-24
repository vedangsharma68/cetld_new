ALTER TABLE "workspace_members" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "slug" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;