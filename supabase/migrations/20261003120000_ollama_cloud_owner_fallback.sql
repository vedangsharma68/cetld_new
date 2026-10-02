-- Allow the vetted Ollama Cloud model as an optional owner-agent fallback.
-- This changes model-choice validation only; it does not rewrite settings rows.
begin;

alter table public.workspace_ai_settings
  drop constraint if exists workspace_ai_settings_fallback_model_check;

alter table public.workspace_ai_settings
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
    'gemini-3.5-flash-lite',
    'gpt-oss:20b-cloud'
  ) or (length(fallback_model) <= 100 and fallback_model ~ '^[a-z0-9][a-z0-9.-]*-free$'));

do $ollama_workspace_data$
declare
  v_function regprocedure := pg_catalog.to_regprocedure(
    'public.whatsapp_workspace_data_propose(uuid,uuid,text,text,text,text,uuid,timestamptz,jsonb,text,bigint,bigint,bigint)');
  v_definition text;
  v_marker text := '''gemini-3.5-flash-lite'',''longcat-2.5-preview-free''';
  v_position integer;
begin
  if v_function is null then
    raise exception 'workspaceData proposal function is missing';
  end if;
  v_definition := pg_catalog.pg_get_functiondef(v_function);
  v_position := pg_catalog.strpos(v_definition,v_marker);
  if v_position = 0
     or pg_catalog.strpos(pg_catalog.substr(v_definition,v_position + pg_catalog.length(v_marker)),v_marker) > 0 then
    raise exception 'workspaceData model allowlist did not match the expected single location';
  end if;
  execute pg_catalog.replace(v_definition,v_marker,
    '''gemini-3.5-flash-lite'',''longcat-2.5-preview-free'',''gpt-oss:20b-cloud''');
end;
$ollama_workspace_data$;

commit;
