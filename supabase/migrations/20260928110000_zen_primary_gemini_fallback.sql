begin;

alter table public.workspace_ai_settings
  drop constraint if exists workspace_ai_settings_primary_gemini_model_check,
  drop constraint if exists workspace_ai_settings_fallback_zen_model_check,
  drop constraint if exists workspace_ai_settings_models_different;

update public.workspace_ai_settings
set primary_model = 'space-bunny-free',
    fallback_model = 'longcat-2.5-preview-free';

alter table public.workspace_ai_settings
  alter column primary_model set default 'space-bunny-free',
  alter column fallback_model set default 'longcat-2.5-preview-free',
  add constraint workspace_ai_settings_primary_zen_model_check
    check (length(primary_model) <= 100 and primary_model ~ '^[a-z0-9][a-z0-9.-]*-free$'),
  add constraint workspace_ai_settings_fallback_model_check
    check (fallback_model is null or fallback_model = 'gemini-3.5-flash' or
      (length(fallback_model) <= 100 and fallback_model ~ '^[a-z0-9][a-z0-9.-]*-free$')),
  add constraint workspace_ai_settings_models_different
    check (fallback_model is null or fallback_model <> primary_model);

commit;
