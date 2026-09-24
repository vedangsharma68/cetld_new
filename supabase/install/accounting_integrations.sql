begin;

create table if not exists public.cetld_accounting_connections (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.cetld_workspaces(id) on delete cascade,
  provider text not null check (provider in ('zoho_books','quickbooks')),
  provider_account_id text,
  organization_name text,
  region text,
  accounts_domain text,
  api_domain text,
  token_ciphertext text not null,
  token_iv text not null,
  token_tag text not null,
  token_expires_at timestamptz not null,
  revision bigint not null default 1,
  refresh_lease_token text,
  refresh_lease_until timestamptz,
  status text not null default 'connecting' check (status in ('connecting','needs_organization','connected','needs_attention','disconnected')),
  last_synced_at timestamptz,
  last_sync_status text not null default 'never' check (last_sync_status in ('never','syncing','synced','failed')),
  last_sync_error text,
  connection_problem text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_id, workspace_id, provider)
);

create table if not exists public.cetld_accounting_oauth_states (
  state_hash text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.cetld_workspaces(id) on delete cascade,
  provider text not null check (provider in ('zoho_books','quickbooks')),
  redirect_uri text not null,
  region text,
  provider_account_id text,
  browser_nonce_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.cetld_accounting_sync_records (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.cetld_workspaces(id) on delete cascade,
  provider text not null check (provider in ('zoho_books','quickbooks')),
  record_type text not null check (record_type in ('customer','invoice','payment')),
  external_id text not null,
  payload jsonb not null,
  synced_at timestamptz not null default now(),
  unique(workspace_id, provider, record_type, external_id)
);

create index if not exists cetld_accounting_oauth_expiry_idx on public.cetld_accounting_oauth_states(expires_at);
create index if not exists cetld_accounting_sync_owner_idx on public.cetld_accounting_sync_records(owner_id, workspace_id, provider);

alter table public.cetld_accounting_connections enable row level security;
alter table public.cetld_accounting_oauth_states enable row level security;
alter table public.cetld_accounting_sync_records enable row level security;
revoke all on public.cetld_accounting_connections from anon, authenticated;
revoke all on public.cetld_accounting_oauth_states from anon, authenticated;
revoke all on public.cetld_accounting_sync_records from anon, authenticated;

create or replace function public.cetld_consume_accounting_oauth_state(p_state_hash text, p_now timestamptz default now())
returns table(state_hash text, owner_id uuid, workspace_id uuid, provider text, redirect_uri text, region text, provider_account_id text, browser_nonce_hash text, expires_at timestamptz, used_at timestamptz)
language plpgsql security invoker set search_path = '' as $function$
begin
  return query update public.cetld_accounting_oauth_states s
    set used_at = p_now
    where s.state_hash = p_state_hash and s.used_at is null and s.expires_at > p_now
    returning s.state_hash, s.owner_id, s.workspace_id, s.provider, s.redirect_uri, s.region, s.provider_account_id, s.browser_nonce_hash, s.expires_at, s.used_at;
end;
$function$;

create or replace function public.cetld_claim_accounting_connection_refresh(p_owner_id uuid, p_workspace_id uuid, p_provider text, p_lease_token text, p_lease_ms integer default 30000)
returns table(claimed boolean, revision bigint)
language plpgsql security invoker set search_path = '' as $function$
begin
  return query update public.cetld_accounting_connections c
    set refresh_lease_token = p_lease_token, refresh_lease_until = now() + (greatest(p_lease_ms, 1000) * interval '1 millisecond')
    where c.owner_id = p_owner_id and c.workspace_id = p_workspace_id and c.provider = p_provider
      and (c.refresh_lease_until is null or c.refresh_lease_until <= now())
    returning true, c.revision;
  if not found then
    return query select false, c.revision from public.cetld_accounting_connections c
      where c.owner_id = p_owner_id and c.workspace_id = p_workspace_id and c.provider = p_provider limit 1;
  end if;
end;
$function$;

create or replace function public.cetld_update_accounting_connection_tokens(p_owner_id uuid, p_workspace_id uuid, p_provider text, p_expected_revision bigint, p_lease_token text, p_token_ciphertext text, p_token_iv text, p_token_tag text, p_token_expires_at timestamptz, p_api_domain text default null, p_provider_account_id text default null, p_region text default null)
returns setof public.cetld_accounting_connections
language sql security invoker set search_path = '' as $function$
  update public.cetld_accounting_connections c
    set token_ciphertext = p_token_ciphertext, token_iv = p_token_iv, token_tag = p_token_tag, token_expires_at = p_token_expires_at,
        api_domain = coalesce(p_api_domain, c.api_domain), provider_account_id = coalesce(p_provider_account_id, c.provider_account_id), region = coalesce(p_region, c.region),
        revision = c.revision + 1, refresh_lease_token = null, refresh_lease_until = null, updated_at = now()
    where c.owner_id = p_owner_id and c.workspace_id = p_workspace_id and c.provider = p_provider and c.revision = p_expected_revision and c.refresh_lease_token = p_lease_token
  returning c.*;
$function$;

create or replace function public.cetld_release_accounting_connection_refresh(p_owner_id uuid, p_workspace_id uuid, p_provider text, p_lease_token text)
returns void language sql security invoker set search_path = '' as $function$
  update public.cetld_accounting_connections c set refresh_lease_token = null, refresh_lease_until = null
    where c.owner_id = p_owner_id and c.workspace_id = p_workspace_id and c.provider = p_provider and c.refresh_lease_token = p_lease_token;
$function$;

grant all on public.cetld_accounting_connections,public.cetld_accounting_oauth_states,public.cetld_accounting_sync_records to service_role;
revoke execute on function public.cetld_consume_accounting_oauth_state(text,timestamptz) from public,anon,authenticated;
revoke execute on function public.cetld_claim_accounting_connection_refresh(uuid,uuid,text,text,integer) from public,anon,authenticated;
revoke execute on function public.cetld_update_accounting_connection_tokens(uuid,uuid,text,bigint,text,text,text,text,timestamptz,text,text,text) from public,anon,authenticated;
revoke execute on function public.cetld_release_accounting_connection_refresh(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.cetld_consume_accounting_oauth_state(text,timestamptz) to service_role;
grant execute on function public.cetld_claim_accounting_connection_refresh(uuid,uuid,text,text,integer) to service_role;
grant execute on function public.cetld_update_accounting_connection_tokens(uuid,uuid,text,bigint,text,text,text,text,timestamptz,text,text,text) to service_role;
grant execute on function public.cetld_release_accounting_connection_refresh(uuid,uuid,text,text) to service_role;
commit;
