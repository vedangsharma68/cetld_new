begin;

alter table public.workspace_ai_settings
  drop constraint if exists workspace_ai_settings_fallback_openrouter_free_model_check;

update public.workspace_ai_settings
set fallback_model = case
  when fallback_model is null then null
  else 'space-bunny-free'
end;

alter table public.workspace_ai_settings
  alter column fallback_model set default 'space-bunny-free',
  add constraint workspace_ai_settings_fallback_zen_model_check
    check (fallback_model is null or
      (length(fallback_model) <= 100 and fallback_model ~ '^[a-z0-9][a-z0-9.-]*-free$'));

commit;
