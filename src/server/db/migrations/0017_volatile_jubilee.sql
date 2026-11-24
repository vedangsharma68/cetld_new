ALTER TABLE "workspace_members" DROP CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_members" DROP CONSTRAINT "workspace_members_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_ai_settings" DROP CONSTRAINT "workspace_ai_settings_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_settings" DROP CONSTRAINT "workspace_settings_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_settings" DROP CONSTRAINT "workspace_settings_whatsapp_owner_attested_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_ai_settings" ADD CONSTRAINT "workspace_ai_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_whatsapp_owner_attested_by_users_id_fk" FOREIGN KEY ("whatsapp_owner_attested_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_slug_unique" UNIQUE("slug");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_id_owner_id_key" UNIQUE("id","owner_id");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_name_check" CHECK ((((length(btrim(name)) >= 1) AND (length(btrim(name)) <= 160))));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_slug_check" CHECK (((slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'::text)));--> statement-breakpoint
ALTER TABLE "workspace_ai_settings" ADD CONSTRAINT "workspace_ai_settings_fallback_model_check" CHECK ((((fallback_model IS NULL) OR (fallback_model = ANY (ARRAY['@cf/meta/llama-3.3-70b-instruct-fp8-fast'::text, '@cf/meta/llama-4-scout-17b-16e-instruct'::text, '@cf/mistralai/mistral-small-3.1-24b-instruct'::text, '@cf/openai/gpt-oss-20b'::text, '@cf/qwen/qwen3-30b-a3b-fp8'::text, '@cf/zai-org/glm-4.7-flash'::text, 'space-bunny-free'::text, 'longcat-2.5-preview-free'::text, 'gemini-3.5-flash'::text, 'gemini-3.5-flash-lite'::text, 'gpt-oss:20b-cloud'::text])) OR ((length(fallback_model) <= 100) AND (fallback_model ~ '^[a-z0-9][a-z0-9.-]*-free$'::text)))));--> statement-breakpoint
ALTER TABLE "workspace_ai_settings" ADD CONSTRAINT "workspace_ai_settings_models_different" CHECK ((((fallback_model IS NULL) OR (fallback_model <> primary_model))));--> statement-breakpoint
ALTER TABLE "workspace_ai_settings" ADD CONSTRAINT "workspace_ai_settings_primary_model_check" CHECK ((((primary_model = ANY (ARRAY['@cf/meta/llama-3.3-70b-instruct-fp8-fast'::text, '@cf/meta/llama-4-scout-17b-16e-instruct'::text, '@cf/mistralai/mistral-small-3.1-24b-instruct'::text, '@cf/openai/gpt-oss-20b'::text, '@cf/qwen/qwen3-30b-a3b-fp8'::text, '@cf/zai-org/glm-4.7-flash'::text, 'gemini-3.5-flash'::text, 'gemini-3.5-flash-lite'::text, 'space-bunny-free'::text])) OR ((length(primary_model) <= 100) AND (primary_model ~ '^[a-z0-9][a-z0-9.-]*-free$'::text)))));--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_business_name_check" CHECK ((((business_name IS NULL) OR ((length(btrim(business_name)) >= 1) AND (length(btrim(business_name)) <= 200)))));--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_default_currency_check" CHECK (((default_currency ~ '^[A-Z]{3}$'::text)));--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_follow_up_preferences_check" CHECK (((jsonb_typeof(follow_up_preferences) = 'object'::text)));--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_owner_bot_preferences_object" CHECK ((((jsonb_typeof(owner_bot_preferences) = 'object'::text) AND (octet_length((owner_bot_preferences)::text) <= 8192))));--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_whatsapp_owner_phone_check" CHECK ((((whatsapp_owner_phone IS NULL) OR (whatsapp_owner_phone ~ '^\+[1-9][0-9]{7,14}$'::text))));