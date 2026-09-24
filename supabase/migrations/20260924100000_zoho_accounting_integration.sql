create table public.cetld_accounting_connections (
  owner_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  provider text not null check (provider = 'zoho'),
  provider_account_id text,
  region text,
  api_domain text,
  token_ciphertext text not null,
  token_iv text not null,
  token_tag text not null,
  token_expires_at timestamptz not null,
  revision bigint not null default 1 check (revision > 0),
  refresh_lease_token uuid,
  refresh_lease_until timestamptz,
  status text not null default 'connected' check (status in ('connected','needs_attention','disconnected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, workspace_id, provider),
  foreign key (workspace_id, owner_id) references public.workspaces(id, owner_id) on delete cascade,
  check ((refresh_lease_token is null) = (refresh_lease_until is null))
);
create table public.cetld_accounting_oauth_states (
  state_hash text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  provider text not null check (provider = 'zoho'),
  redirect_uri text not null,
  region text,
  provider_account_id text,
  browser_nonce_hash text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, owner_id) references public.workspaces(id, owner_id) on delete cascade
);
create index cetld_accounting_oauth_states_expiry on public.cetld_accounting_oauth_states(expires_at);
create table public.cetld_accounting_sync_records (
  id bigint generated always as identity primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null,
  provider text not null check (provider = 'zoho'),
  record_type text not null check (record_type in ('invoice','payment')),
  external_id text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  synced_at timestamptz not null default now(),
  foreign key (workspace_id, owner_id) references public.workspaces(id, owner_id) on delete cascade,
  unique (workspace_id, provider, record_type, external_id)
);
alter table public.cetld_accounting_connections enable row level security;
alter table public.cetld_accounting_oauth_states enable row level security;
alter table public.cetld_accounting_sync_records enable row level security;
revoke all on public.cetld_accounting_connections, public.cetld_accounting_oauth_states, public.cetld_accounting_sync_records from public, anon, authenticated;
grant select, insert, update, delete on public.cetld_accounting_connections, public.cetld_accounting_oauth_states, public.cetld_accounting_sync_records to service_role;
grant usage, select on sequence public.cetld_accounting_sync_records_id_seq to service_role;

create or replace function public.cetld_consume_accounting_oauth_state(p_state_hash text, p_now timestamptz)
returns setof public.cetld_accounting_oauth_states
language sql security definer set search_path = ''
as $$
  update public.cetld_accounting_oauth_states s
  set used_at = p_now
  where s.state_hash = p_state_hash and s.used_at is null and s.expires_at > p_now
  returning s.*;
$$;

create or replace function public.cetld_claim_accounting_connection_refresh(
  p_owner_id uuid, p_workspace_id uuid, p_provider text, p_lease_token uuid, p_lease_ms integer
) returns table(claimed boolean, revision bigint)
language plpgsql security definer set search_path = ''
as $$
begin
  return query
  update public.cetld_accounting_connections c
  set refresh_lease_token = p_lease_token,
      refresh_lease_until = clock_timestamp() + make_interval(secs => greatest(1, least(p_lease_ms, 120000))::double precision / 1000)
  where c.owner_id = p_owner_id and c.workspace_id = p_workspace_id and c.provider = p_provider
    and (c.refresh_lease_until is null or c.refresh_lease_until <= clock_timestamp() or c.refresh_lease_token = p_lease_token)
  returning true, c.revision;
  if not found then
    return query select false, c.revision from public.cetld_accounting_connections c
      where c.owner_id = p_owner_id and c.workspace_id = p_workspace_id and c.provider = p_provider;
  end if;
end;
$$;

create or replace function public.cetld_update_accounting_connection_tokens(
  p_owner_id uuid, p_workspace_id uuid, p_provider text, p_expected_revision bigint,
  p_lease_token uuid, p_token_ciphertext text, p_token_iv text, p_token_tag text,
  p_token_expires_at timestamptz, p_api_domain text, p_provider_account_id text, p_region text
) returns setof public.cetld_accounting_connections
language sql security definer set search_path = ''
as $$
  update public.cetld_accounting_connections c
  set token_ciphertext = p_token_ciphertext, token_iv = p_token_iv, token_tag = p_token_tag,
      token_expires_at = p_token_expires_at, api_domain = coalesce(p_api_domain,c.api_domain),
      provider_account_id = coalesce(p_provider_account_id,c.provider_account_id),
      region = coalesce(p_region,c.region), revision = c.revision + 1,
      refresh_lease_token = null, refresh_lease_until = null,
      status = 'connected', updated_at = now()
  where c.owner_id = p_owner_id and c.workspace_id = p_workspace_id and c.provider = p_provider
    and c.revision = p_expected_revision and c.refresh_lease_token = p_lease_token
  returning c.*;
$$;

create or replace function public.cetld_release_accounting_connection_refresh(
  p_owner_id uuid, p_workspace_id uuid, p_provider text, p_lease_token uuid
) returns void
language sql security definer set search_path = ''
as $$
  update public.cetld_accounting_connections c set refresh_lease_token = null, refresh_lease_until = null
  where c.owner_id = p_owner_id and c.workspace_id = p_workspace_id and c.provider = p_provider and c.refresh_lease_token = p_lease_token;
$$;

revoke all on function public.cetld_consume_accounting_oauth_state(text,timestamptz),
  public.cetld_claim_accounting_connection_refresh(uuid,uuid,text,uuid,integer),
  public.cetld_update_accounting_connection_tokens(uuid,uuid,text,bigint,uuid,text,text,text,timestamptz,text,text,text),
  public.cetld_release_accounting_connection_refresh(uuid,uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.cetld_consume_accounting_oauth_state(text,timestamptz),
  public.cetld_claim_accounting_connection_refresh(uuid,uuid,text,uuid,integer),
  public.cetld_update_accounting_connection_tokens(uuid,uuid,text,bigint,uuid,text,text,text,timestamptz,text,text,text),
  public.cetld_release_accounting_connection_refresh(uuid,uuid,text,uuid) to service_role;