-- Normalize settings created before the free-model policy and enforce the
-- verified OpenRouter allowlist for all future direct database writes.
begin;

update public.workspace_ai_settings
set primary_model = case
  when primary_model in (
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'openrouter/free'
  ) then primary_model
  else 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'
end;

update public.workspace_ai_settings
set fallback_model = case
  when fallback_model is null then null
  when fallback_model in (
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'openrouter/free'
  ) and fallback_model <> primary_model then fallback_model
  when primary_model = 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free' then 'openrouter/free'
  else 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'
end;

alter table public.workspace_ai_settings
  alter column primary_model set default 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  alter column fallback_model set default 'openrouter/free';

alter table public.workspace_ai_settings
  drop constraint if exists workspace_ai_settings_primary_model_check,
  drop constraint if exists workspace_ai_settings_fallback_model_check,
  drop constraint if exists workspace_ai_settings_check;

alter table public.workspace_ai_settings
  add constraint workspace_ai_settings_primary_free_model_check
    check (primary_model in ('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'openrouter/free')),
  add constraint workspace_ai_settings_fallback_free_model_check
    check (fallback_model is null or fallback_model in ('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'openrouter/free')),
  add constraint workspace_ai_settings_distinct_models_check
    check (fallback_model is null or fallback_model <> primary_model);

commit;
