-- Keep saved workspace configuration aligned with the server provider pair.
begin;

-- Remove the preceding provider allowlist before normalizing saved rows. The
-- old CHECK constraints reject the Gemini value if the update runs first.
alter table public.workspace_ai_settings
  drop constraint if exists workspace_ai_settings_primary_model_check,
  drop constraint if exists workspace_ai_settings_fallback_model_check,
  drop constraint if exists workspace_ai_settings_fallback_distinct_check,
  drop constraint if exists workspace_ai_settings_check,
  drop constraint if exists workspace_ai_settings_primary_free_model_check,
  drop constraint if exists workspace_ai_settings_fallback_free_model_check,
  drop constraint if exists workspace_ai_settings_distinct_models_check;

update public.workspace_ai_settings
set primary_model = 'gemini-3.5-flash',
    fallback_model = case when fallback_model is null then null else 'openrouter/free' end;

alter table public.workspace_ai_settings
  alter column primary_model set default 'gemini-3.5-flash',
  alter column fallback_model set default 'openrouter/free';

alter table public.workspace_ai_settings
  add constraint workspace_ai_settings_primary_gemini_model_check
    check (primary_model = 'gemini-3.5-flash'),
  add constraint workspace_ai_settings_fallback_openrouter_free_model_check
    check (fallback_model is null or fallback_model = 'openrouter/free'),
  add constraint workspace_ai_settings_distinct_models_check
    check (fallback_model is null or fallback_model <> primary_model);

commit;
