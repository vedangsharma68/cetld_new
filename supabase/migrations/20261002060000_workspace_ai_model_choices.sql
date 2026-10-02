-- Expand the server-verified model choices while retaining every existing
-- free-model setting. Saved rows and the current column defaults are preserved.
begin;

alter table public.workspace_ai_settings
  drop constraint if exists workspace_ai_settings_primary_zen_model_check,
  drop constraint if exists workspace_ai_settings_fallback_model_check,
  drop constraint if exists workspace_ai_settings_models_different,
  drop constraint if exists workspace_ai_settings_primary_gemini_model_check,
  drop constraint if exists workspace_ai_settings_fallback_zen_model_check,
  drop constraint if exists workspace_ai_settings_distinct_models_check,
  drop constraint if exists workspace_ai_settings_primary_free_model_check,
  drop constraint if exists workspace_ai_settings_fallback_free_model_check,
  drop constraint if exists workspace_ai_settings_fallback_openrouter_free_model_check,
  drop constraint if exists workspace_ai_settings_primary_model_check,
  drop constraint if exists workspace_ai_settings_check;

alter table public.workspace_ai_settings
  add constraint workspace_ai_settings_primary_model_check
    check (primary_model in (
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      '@cf/meta/llama-4-scout-17b-16e-instruct',
      '@cf/mistralai/mistral-small-3.1-24b-instruct',
      '@cf/openai/gpt-oss-20b',
      '@cf/qwen/qwen3-30b-a3b-fp8',
      '@cf/zai-org/glm-4.7-flash',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite',
      'space-bunny-free'
    ) or (length(primary_model) <= 100 and primary_model ~ '^[a-z0-9][a-z0-9.-]*-free$')),
  add constraint workspace_ai_settings_fallback_model_check
    check (fallback_model is null or fallback_model in (
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      '@cf/meta/llama-4-scout-17b-16e-instruct',
      '@cf/mistralai/mistral-small-3.1-24b-instruct',
      '@cf/openai/gpt-oss-20b',
      '@cf/qwen/qwen3-30b-a3b-fp8',
      '@cf/zai-org/glm-4.7-flash',
      'space-bunny-free',
      'longcat-2.5-preview-free',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite'
    ) or (length(fallback_model) <= 100 and fallback_model ~ '^[a-z0-9][a-z0-9.-]*-free$')),
  add constraint workspace_ai_settings_models_different
    check (fallback_model is null or fallback_model <> primary_model);

commit;
