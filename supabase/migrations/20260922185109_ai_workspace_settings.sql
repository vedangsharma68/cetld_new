-- Model identifiers only. Provider credentials remain server environment secrets.
create table public.workspace_ai_settings (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade,
  primary_model text not null default 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'
    check (primary_model = 'openrouter/free' or (length(primary_model) <= 160 and primary_model ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._-]*:free$')),
  fallback_model text default 'openrouter/free'
    check (fallback_model is null or fallback_model = 'openrouter/free' or (length(fallback_model) <= 160 and fallback_model ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]*/[a-zA-Z0-9][a-zA-Z0-9._-]*:free$')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (fallback_model is null or fallback_model <> primary_model)
);
alter table public.workspace_ai_settings enable row level security;
revoke all on public.workspace_ai_settings from public, anon, authenticated;
grant select, insert, update on public.workspace_ai_settings to authenticated;
create policy workspace_ai_settings_read on public.workspace_ai_settings
  for select to authenticated using (app.is_workspace_member(workspace_id));
create policy workspace_ai_settings_insert on public.workspace_ai_settings
  for insert to authenticated with check (app.can_manage_settings(workspace_id));
create policy workspace_ai_settings_update on public.workspace_ai_settings
  for update to authenticated using (app.can_manage_settings(workspace_id))
  with check (app.can_manage_settings(workspace_id));
create trigger workspace_ai_settings_immutable_workspace
  before update on public.workspace_ai_settings for each row execute function app.prevent_workspace_change();
create trigger workspace_ai_settings_updated_at
  before update on public.workspace_ai_settings for each row execute function app.set_updated_at();
