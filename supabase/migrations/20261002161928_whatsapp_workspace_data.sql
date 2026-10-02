-- Durable, workspace-scoped proposals for owner workspaceData writes.
-- Applying this migration creates only the RPC/table contract; it does not
-- rewrite existing customer, settings, invoice, or payment data.
begin;

do $preflight$
begin
  if pg_catalog.to_regclass('public.whatsapp_pending_actions') is null
     or pg_catalog.to_regclass('public.whatsapp_inbound_events') is null
     or pg_catalog.to_regclass('public.whatsapp_owner_action_receipts') is null
     or pg_catalog.to_regclass('public.customers') is null
     or pg_catalog.to_regclass('public.workspace_settings') is null
     or pg_catalog.to_regclass('public.workspace_ai_settings') is null
     or pg_catalog.to_regclass('public.workspaces') is null then
    raise exception 'workspaceData proposal prerequisites are missing';
  end if;
  if pg_catalog.to_regprocedure('public.whatsapp_resolve_verified_owner(text)') is null
     or pg_catalog.to_regprocedure('public.whatsapp_store_pending_action(uuid,uuid,text,jsonb,text,bigint,bigint,bigint)') is null then
    raise exception 'workspaceData owner confirmation functions are missing';
  end if;
end;
$preflight$;

create table public.whatsapp_workspace_data_proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  owner_id uuid not null references auth.users(id) on delete cascade,
  customer_id uuid not null,
  phone text not null check (phone ~ '^\+[1-9][0-9]{6,14}$'),
  operation text not null check (operation in ('create','update','delete')),
  table_name text not null check (table_name in ('customers','workspace_settings','workspace_ai_settings')),
  target_id uuid,
  expected_updated_at timestamptz,
  values jsonb not null check (jsonb_typeof(values) = 'object'),
  summary text not null check (length(summary) between 1 and 1200),
  request_message_id text not null unique check (length(request_message_id) between 1 and 256),
  confirmation_message_id text,
  cancel_message_id text,
  state text not null default 'pending' check (state in ('pending','confirmed','cancelled','stale','expired')),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check ((operation = 'create' and target_id is null and expected_updated_at is null)
      or (operation in ('update','delete') and target_id is not null and expected_updated_at is not null)
      or (table_name = 'workspace_ai_settings' and operation = 'update' and target_id is not null)),
  check ((confirmation_message_id is null) or length(confirmation_message_id) between 1 and 256),
  check ((cancel_message_id is null) or length(cancel_message_id) between 1 and 256)
);

create index whatsapp_workspace_data_pending_idx
  on public.whatsapp_workspace_data_proposals(workspace_id, customer_id, phone, created_at desc)
  where state = 'pending';

alter table public.whatsapp_workspace_data_proposals enable row level security;
alter table public.whatsapp_workspace_data_proposals force row level security;
revoke all on public.whatsapp_workspace_data_proposals from public, anon, authenticated;
grant select, insert, update on public.whatsapp_workspace_data_proposals to service_role;

-- A later granular owner action must not silently replace a workspaceData proposal.
create or replace function public.whatsapp_store_pending_action(
  p_workspace_id uuid, p_customer_id uuid, p_phone text, p_action jsonb, p_source text,
  p_expected_generation bigint, p_expected_id bigint, p_expected_version bigint
) returns table(id bigint, version bigint, generation bigint, action jsonb)
language plpgsql security definer set search_path = pg_catalog, public as $function$
declare
  v_generation bigint;
  v_active public.whatsapp_pending_actions%rowtype;
begin
  if p_workspace_id is null or p_customer_id is null or p_phone is null
     or p_phone !~ '^\+[1-9][0-9]{6,14}$' or p_expected_generation is null
     or p_action is null or pg_catalog.jsonb_typeof(p_action) is distinct from 'object'
     or p_source is null or p_source='' then raise exception 'invalid pending action'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_workspace_id::text || ':' || p_customer_id::text || ':' || p_phone, 0));
  select coalesce(max(p.generation),0) into v_generation from public.whatsapp_pending_actions p
    where p.workspace_id=p_workspace_id and p.customer_id=p_customer_id and p.phone=p_phone;
  select p.* into v_active from public.whatsapp_pending_actions p
    where p.workspace_id=p_workspace_id and p.customer_id=p_customer_id and p.phone=p_phone
      and p.consumed_at is null order by p.generation desc limit 1 for update;
  if v_generation<>p_expected_generation or v_active.id is distinct from p_expected_id
     or v_active.version is distinct from p_expected_version then return; end if;
  if v_active.id is not null and (v_active.action->>'type'='owner_workspace_data_change'
     or (v_active.action->>'type'='invoice_review_draft'
       and v_active.action->>'stage' in ('extracting','incomplete','proposal','saving','failed'))) then return; end if;
  update public.whatsapp_pending_actions p set consumed_at=pg_catalog.clock_timestamp()
    where p.workspace_id=p_workspace_id and p.customer_id=p_customer_id and p.phone=p_phone
      and p.consumed_at is null;
  return query insert into public.whatsapp_pending_actions(workspace_id,customer_id,phone,action,source,version,generation)
    values(p_workspace_id,p_customer_id,p_phone,p_action,p_source,1,v_generation+1)
    returning whatsapp_pending_actions.id,whatsapp_pending_actions.version,
      whatsapp_pending_actions.generation,whatsapp_pending_actions.action;
end;
$function$;

create or replace function public.whatsapp_workspace_data_propose(
  p_workspace_id uuid,
  p_customer_id uuid,
  p_phone text,
  p_request_message_id text,
  p_operation text,
  p_table text,
  p_target_id uuid,
  p_expected_updated_at timestamptz,
  p_values jsonb,
  p_summary text,
  p_expected_generation bigint,
  p_expected_pending_id bigint,
  p_expected_pending_version bigint
) returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare
  v_owner record;
  v_proposal_id uuid := pg_catalog.gen_random_uuid();
  v_expires_at timestamptz := pg_catalog.clock_timestamp() + interval '10 minutes';
  v_stored record;
  v_active public.whatsapp_pending_actions%rowtype;
  v_request public.whatsapp_inbound_events%rowtype;
  v_existing public.whatsapp_workspace_data_proposals%rowtype;
  v_row_updated_at timestamptz;
  v_customer_metadata jsonb;
  v_timezone text;
begin
  if p_workspace_id is null or p_customer_id is null or p_phone is null
     or p_phone !~ '^\+[1-9][0-9]{6,14}$'
     or p_request_message_id is null or length(p_request_message_id) not between 1 and 256
     or p_operation is null or p_operation not in ('create','update','delete')
     or p_table is null or p_table not in ('customers','workspace_settings','workspace_ai_settings')
     or pg_catalog.jsonb_typeof(p_values) is distinct from 'object'
     or p_summary is null or length(p_summary) not between 1 and 1200
     or p_summary ~ '[[:cntrl:]]'
     or p_expected_generation is null or p_expected_generation < 0 then
    return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
  end if;

  if (select count(*) from public.whatsapp_resolve_verified_owner(p_phone)) <> 1 then
    return pg_catalog.jsonb_build_object('ok',false,'reason','unbound');
  end if;
  select * into v_owner from public.whatsapp_resolve_verified_owner(p_phone)
    where workspace_id = p_workspace_id and customer_id = p_customer_id;
  if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','unbound'); end if;

  -- Match the lock order used by owner unlink/relink and existing owner actions.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_phone,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_workspace_id::text || ':' || p_customer_id::text || ':' || p_phone, 0));
  if (select count(*) from public.whatsapp_resolve_verified_owner(p_phone)) <> 1
     or not exists(select 1 from public.whatsapp_resolve_verified_owner(p_phone) r
       where r.workspace_id=p_workspace_id and r.customer_id=p_customer_id and r.owner_id=v_owner.owner_id) then
    return pg_catalog.jsonb_build_object('ok',false,'reason','unbound');
  end if;

  select p.* into v_active from public.whatsapp_pending_actions p
    where p.workspace_id=p_workspace_id and p.customer_id=p_customer_id and p.phone=p_phone
      and p.consumed_at is null order by p.generation desc limit 1 for update;
  if v_active.id is not null and v_active.action->>'type' <> 'owner_invoice_deleted'
     and not (v_active.action->>'type'='invoice_review_draft'
       and v_active.action->>'stage' in ('saved','canceled')) then
    return pg_catalog.jsonb_build_object('ok',false,'reason','pending');
  end if;

  select * into v_request from public.whatsapp_inbound_events e
    where e.provider_message_id=p_request_message_id and e.sender_phone=p_phone
      and e.status in ('processing','done') for update;
  if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','invalid_request'); end if;
  select * into v_existing from public.whatsapp_workspace_data_proposals p
    where p.request_message_id=p_request_message_id for update;
  if found then
    if v_existing.workspace_id=p_workspace_id and v_existing.owner_id=v_owner.owner_id
       and v_existing.customer_id=p_customer_id and v_existing.phone=p_phone
       and v_existing.state='pending'
       and exists(select 1 from public.whatsapp_pending_actions a where a.workspace_id=p_workspace_id
         and a.customer_id=p_customer_id and a.phone=p_phone and a.consumed_at is null
         and a.action->>'type'='owner_workspace_data_change'
         and a.action->>'proposalId'=v_existing.id::text) then
      return pg_catalog.jsonb_build_object('ok',true,'proposal',true,'replayed',true,'expires_at',v_existing.expires_at);
    end if;
    return pg_catalog.jsonb_build_object('ok',false,'reason','stale');
  end if;

  if p_table = 'customers' then
    if p_operation = 'create' then
      if p_target_id is not null or p_expected_updated_at is not null
         or not (p_values ? 'name')
         or exists(select 1 from pg_catalog.jsonb_each(p_values) e
           where e.key not in ('name','company_name','email','phone')
             or pg_catalog.jsonb_typeof(e.value) not in ('string','null'))
         or pg_catalog.jsonb_typeof(p_values->'name') is distinct from 'string'
         or length(pg_catalog.btrim(p_values->>'name')) not between 1 and 200
         or p_values->>'name' ~ '[[:cntrl:]]'
         or (p_values ? 'company_name' and p_values->'company_name' <> 'null'::jsonb
             and (length(p_values->>'company_name')>255 or p_values->>'company_name' ~ '[[:cntrl:]]'))
         or (p_values ? 'email' and p_values->'email' <> 'null'::jsonb
             and (length(p_values->>'email')>320 or p_values->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
         or (p_values ? 'phone' and p_values->'phone' <> 'null'::jsonb
             and (length(p_values->>'phone')>40 or p_values->>'phone' ~ '[[:cntrl:]]'
               or p_values->>'phone'=p_phone)) then
        return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
      end if;
    elsif p_operation = 'update' then
      if p_target_id is null or p_expected_updated_at is null or p_values = '{}'::jsonb
         or exists(select 1 from pg_catalog.jsonb_each(p_values) e
           where e.key not in ('name','company_name','email','phone')
             or pg_catalog.jsonb_typeof(e.value) not in ('string','null'))
         or (p_values ? 'name' and (pg_catalog.jsonb_typeof(p_values->'name') is distinct from 'string'
             or length(pg_catalog.btrim(p_values->>'name')) not between 1 and 200
             or p_values->>'name' ~ '[[:cntrl:]]'))
         or (p_values ? 'company_name' and p_values->'company_name' <> 'null'::jsonb
             and (length(p_values->>'company_name')>255 or p_values->>'company_name' ~ '[[:cntrl:]]'))
         or (p_values ? 'email' and p_values->'email' <> 'null'::jsonb
             and (length(p_values->>'email')>320 or p_values->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
         or (p_values ? 'phone' and p_values->'phone' <> 'null'::jsonb
             and (length(p_values->>'phone')>40 or p_values->>'phone' ~ '[[:cntrl:]]'
               or p_values->>'phone'=p_phone)) then
        return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
      end if;
      select c.updated_at,c.metadata into v_row_updated_at,v_customer_metadata
        from public.customers c where c.workspace_id=p_workspace_id and c.id=p_target_id;
      if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','not_found'); end if;
      if coalesce(v_customer_metadata->>'whatsapp_owner','false')='true'
         or v_row_updated_at is distinct from p_expected_updated_at then
        return pg_catalog.jsonb_build_object('ok',false,'reason','stale');
      end if;
    elsif p_operation = 'delete' then
      if p_target_id is null or p_expected_updated_at is null or p_values <> '{}'::jsonb then
        return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
      end if;
      select c.updated_at,c.metadata into v_row_updated_at,v_customer_metadata
        from public.customers c where c.workspace_id=p_workspace_id and c.id=p_target_id;
      if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','not_found'); end if;
      if coalesce(v_customer_metadata->>'whatsapp_owner','false')='true'
         or v_row_updated_at is distinct from p_expected_updated_at then
        return pg_catalog.jsonb_build_object('ok',false,'reason','stale');
      end if;
    else return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
    end if;
  elsif p_table = 'workspace_settings' then
    if p_operation <> 'update' or p_target_id is distinct from p_workspace_id
       or p_expected_updated_at is null or p_values = '{}'::jsonb
       or exists(select 1 from pg_catalog.jsonb_each(p_values) e
         where e.key not in ('default_currency','default_timezone')
           or pg_catalog.jsonb_typeof(e.value) is distinct from 'string') then
      return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
    end if;
    if p_values ? 'default_currency' and
       (p_values->>'default_currency' !~ '^[A-Z]{3}$') then
      return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
    end if;
    if p_values ? 'default_timezone' then
      v_timezone := p_values->>'default_timezone';
      if length(v_timezone) not between 1 and 100 or v_timezone ~ '[[:cntrl:]]' then
        return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
      end if;
      begin
        perform pg_catalog.timezone(v_timezone, pg_catalog.clock_timestamp());
      exception when others then
        return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
      end;
    end if;
    select s.updated_at into v_row_updated_at from public.workspace_settings s
      where s.workspace_id=p_workspace_id;
    if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','not_found'); end if;
    if v_row_updated_at is distinct from p_expected_updated_at then
      return pg_catalog.jsonb_build_object('ok',false,'reason','stale');
    end if;
  elsif p_table = 'workspace_ai_settings' then
    if p_operation <> 'update' or p_target_id is distinct from p_workspace_id
       or not (p_values ? 'primary_model') or not (p_values ? 'fallback_model')
       or pg_catalog.jsonb_typeof(p_values->'primary_model') is distinct from 'string'
       or pg_catalog.jsonb_typeof(p_values->'fallback_model') not in ('string','null')
       or exists(select 1 from pg_catalog.jsonb_each(p_values) e
         where e.key not in ('primary_model','fallback_model')) then
      return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
    end if;
    if p_values->>'primary_model' not in (
       '@cf/meta/llama-3.3-70b-instruct-fp8-fast','@cf/meta/llama-4-scout-17b-16e-instruct',
       '@cf/mistralai/mistral-small-3.1-24b-instruct','@cf/openai/gpt-oss-20b',
       '@cf/qwen/qwen3-30b-a3b-fp8','@cf/zai-org/glm-4.7-flash',
       'gemini-3.5-flash','gemini-3.5-flash-lite','space-bunny-free')
       or (p_values->'fallback_model' <> 'null'::jsonb and p_values->>'fallback_model' not in (
       '@cf/meta/llama-3.3-70b-instruct-fp8-fast','@cf/meta/llama-4-scout-17b-16e-instruct',
       '@cf/mistralai/mistral-small-3.1-24b-instruct','@cf/openai/gpt-oss-20b',
       '@cf/qwen/qwen3-30b-a3b-fp8','@cf/zai-org/glm-4.7-flash',
       'gemini-3.5-flash','gemini-3.5-flash-lite','longcat-2.5-preview-free'))
       or p_values->>'primary_model'=p_values->>'fallback_model' then
      return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
    end if;
    if p_expected_updated_at is null then
      if exists(select 1 from public.workspace_ai_settings a where a.workspace_id=p_workspace_id) then
        return pg_catalog.jsonb_build_object('ok',false,'reason','stale');
      end if;
    else
      select a.updated_at into v_row_updated_at from public.workspace_ai_settings a
        where a.workspace_id=p_workspace_id;
      if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','stale'); end if;
      if v_row_updated_at is distinct from p_expected_updated_at then
        return pg_catalog.jsonb_build_object('ok',false,'reason','stale');
      end if;
    end if;
  end if;

  insert into public.whatsapp_workspace_data_proposals(
    id,workspace_id,owner_id,customer_id,phone,operation,table_name,target_id,
    expected_updated_at,values,summary,request_message_id,expires_at)
  values(v_proposal_id,p_workspace_id,v_owner.owner_id,p_customer_id,p_phone,p_operation,p_table,
    p_target_id,p_expected_updated_at,p_values,p_summary,p_request_message_id,v_expires_at);

  select * into v_stored from public.whatsapp_store_pending_action(
    p_workspace_id,p_customer_id,p_phone,
    pg_catalog.jsonb_build_object('type','owner_workspace_data_change','proposalId',v_proposal_id,
      'operation',p_operation,'table',p_table,'summary',p_summary,
      'requestMessageId',p_request_message_id,'expiresAt',v_expires_at),
    'whatsapp',p_expected_generation,p_expected_pending_id,p_expected_pending_version);
  if not found then
    delete from public.whatsapp_workspace_data_proposals where id=v_proposal_id;
    return pg_catalog.jsonb_build_object('ok',false,'reason','stale');
  end if;
  return pg_catalog.jsonb_build_object('ok',true,'proposal',true,'expires_at',v_expires_at);
end;
$function$;

create or replace function public.whatsapp_workspace_data_decide(
  p_workspace_id uuid,
  p_customer_id uuid,
  p_phone text,
  p_pending_id bigint,
  p_pending_version bigint,
  p_proposal_id uuid,
  p_confirmation_message_id text,
  p_cancel_message_id text,
  p_user_message text,
  p_confirm boolean
) returns jsonb
language plpgsql security definer set search_path = '' as $function$
declare
  v_owner record;
  v_pending public.whatsapp_pending_actions%rowtype;
  v_event public.whatsapp_inbound_events%rowtype;
  v_proposal public.whatsapp_workspace_data_proposals%rowtype;
  v_receipt public.whatsapp_owner_action_receipts%rowtype;
  v_message_id text;
  v_normalized text;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_row_updated_at timestamptz;
  v_metadata jsonb;
  v_result jsonb;
  v_receipt_only boolean := false;
begin
  if p_workspace_id is null or p_customer_id is null or p_phone is null
     or p_phone !~ '^\+[1-9][0-9]{6,14}$'
     or p_confirm is null or p_user_message is null or length(p_user_message)>4000 then
    return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
  end if;
  if p_pending_id is null and p_pending_version is null and p_proposal_id is null then
    v_receipt_only := true;
  elsif p_pending_id is null or p_pending_version is null or p_proposal_id is null then
    return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
  end if;
  if p_confirm then
    if p_confirmation_message_id is null or p_cancel_message_id is not null then
      return pg_catalog.jsonb_build_object('ok',false,'reason','invalid_confirmation');
    end if;
    v_message_id := p_confirmation_message_id;
  else
    if p_cancel_message_id is null or p_confirmation_message_id is not null then
      return pg_catalog.jsonb_build_object('ok',false,'reason','invalid_confirmation');
    end if;
    v_message_id := p_cancel_message_id;
  end if;
  if length(v_message_id) not between 1 and 256 then
    return pg_catalog.jsonb_build_object('ok',false,'reason','invalid_confirmation');
  end if;

  if (select count(*) from public.whatsapp_resolve_verified_owner(p_phone)) <> 1 then
    return pg_catalog.jsonb_build_object('ok',false,'reason','unbound');
  end if;
  select * into v_owner from public.whatsapp_resolve_verified_owner(p_phone)
    where workspace_id=p_workspace_id and customer_id=p_customer_id;
  if not found then return pg_catalog.jsonb_build_object('ok',false,'reason','unbound'); end if;

  -- Use the same lock order as owner unlink/relink and other owner actions.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_phone,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    p_workspace_id::text || ':' || p_customer_id::text || ':' || p_phone, 0));
  if (select count(*) from public.whatsapp_resolve_verified_owner(p_phone)) <> 1
     or not exists(select 1 from public.whatsapp_resolve_verified_owner(p_phone) r
       where r.workspace_id=p_workspace_id and r.customer_id=p_customer_id and r.owner_id=v_owner.owner_id) then
    return pg_catalog.jsonb_build_object('ok',false,'reason','unbound');
  end if;

  select * into v_event from public.whatsapp_inbound_events e
    where e.provider_message_id=v_message_id and e.sender_phone=p_phone and e.status in ('processing','done') for update;
  if not found or v_event.message_text is distinct from p_user_message then
    return pg_catalog.jsonb_build_object('ok',false,'reason','invalid_confirmation');
  end if;
  v_normalized := pg_catalog.regexp_replace(pg_catalog.lower(pg_catalog.btrim(v_event.message_text)), '[.!]$', '');
  if p_confirm and v_normalized not in ('yes','y','ok','okay','confirm','confirmed','do it','go ahead','proceed','approve') then
    return pg_catalog.jsonb_build_object('ok',false,'reason','invalid_confirmation');
  elsif not p_confirm and v_normalized not in ('no','cancel','never mind','nevermind','discard') then
    return pg_catalog.jsonb_build_object('ok',false,'reason','invalid_confirmation');
  end if;

  select * into v_receipt from public.whatsapp_owner_action_receipts r where r.provider_message_id=v_message_id;
  if found then
    if v_receipt.workspace_id is distinct from p_workspace_id or v_receipt.owner_id is distinct from v_owner.owner_id
       or v_receipt.phone is distinct from p_phone
       or v_receipt.result->>'decision' is distinct from (case when p_confirm then 'confirm' else 'cancel' end)
       or (not v_receipt_only and v_receipt.action_id is distinct from p_pending_id) then
      return pg_catalog.jsonb_build_object('ok',false,'reason','no_action');
    end if;
    if v_receipt.result->>'actionType' not in (
       'owner_workspace_data_confirmed','owner_workspace_data_cancelled','owner_workspace_data_expired','owner_workspace_data_stale') then
      return pg_catalog.jsonb_build_object('ok',false,'reason','no_action');
    end if;
    return (v_receipt.result-'decision') || pg_catalog.jsonb_build_object('replayed',true);
  end if;
  if v_receipt_only then
    return pg_catalog.jsonb_build_object('ok',false,'reason','no_action');
  end if;
  select * into v_pending from public.whatsapp_pending_actions p where p.id=p_pending_id
    and p.workspace_id=p_workspace_id and p.customer_id=p_customer_id and p.phone=p_phone for update;
  if not found or v_pending.version is distinct from p_pending_version or v_pending.consumed_at is not null
     or v_pending.action->>'type' is distinct from 'owner_workspace_data_change'
     or v_pending.action->>'proposalId' is distinct from p_proposal_id::text then
    return pg_catalog.jsonb_build_object('ok',false,'reason','no_action');
  end if;
  select * into v_proposal from public.whatsapp_workspace_data_proposals p
    where p.id=p_proposal_id and p.workspace_id=p_workspace_id and p.owner_id=v_owner.owner_id
      and p.customer_id=p_customer_id and p.phone=p_phone for update;
  if not found or v_proposal.state <> 'pending' or v_proposal.request_message_id is null
     or v_proposal.request_message_id=v_message_id
     or v_pending.action->>'requestMessageId' is distinct from v_proposal.request_message_id
     or v_pending.action->>'operation' is distinct from v_proposal.operation
     or v_pending.action->>'table' is distinct from v_proposal.table_name then
    return pg_catalog.jsonb_build_object('ok',false,'reason','no_action');
  end if;
  if v_event.received_at<v_pending.created_at
     or (v_event.provider_timestamp is not null and v_event.provider_timestamp+interval '1 second'<v_pending.created_at) then
    return pg_catalog.jsonb_build_object('ok',false,'reason','stale_confirmation');
  end if;
  if v_proposal.expires_at<=v_now then
    update public.whatsapp_workspace_data_proposals set state='expired',updated_at=v_now where id=v_proposal.id;
    update public.whatsapp_pending_actions set consumed_at=v_now where id=v_pending.id and consumed_at is null;
    v_result := pg_catalog.jsonb_build_object('ok',false,'reason','expired',
      'actionType','owner_workspace_data_expired','decision',case when p_confirm then 'confirm' else 'cancel' end);
    insert into public.whatsapp_owner_action_receipts(provider_message_id,workspace_id,owner_id,phone,action_id,result)
      values(v_message_id,p_workspace_id,v_owner.owner_id,p_phone,v_pending.id,v_result);
    return v_result-'decision';
  end if;

  if not p_confirm then
    update public.whatsapp_workspace_data_proposals set state='cancelled',cancel_message_id=v_message_id,updated_at=v_now
      where id=v_proposal.id and state='pending';
    update public.whatsapp_pending_actions set consumed_at=v_now where id=v_pending.id and consumed_at is null;
    v_result := pg_catalog.jsonb_build_object('ok',true,'actionType','owner_workspace_data_cancelled',
      'table',v_proposal.table_name,'decision','cancel');
    insert into public.whatsapp_owner_action_receipts(provider_message_id,workspace_id,owner_id,phone,action_id,result)
      values(v_message_id,p_workspace_id,v_owner.owner_id,p_phone,v_pending.id,v_result);
    return v_result-'decision';
  end if;

  if v_proposal.table_name='customers' then
    select c.updated_at,c.metadata into v_row_updated_at,v_metadata from public.customers c
      where c.workspace_id=p_workspace_id and c.id=v_proposal.target_id for update;
    if v_proposal.operation='create' then
      insert into public.customers(workspace_id,name,company_name,email,phone)
      values(p_workspace_id,v_proposal.values->>'name',v_proposal.values->>'company_name',
        v_proposal.values->>'email',v_proposal.values->>'phone');
    elsif not found or v_row_updated_at is distinct from v_proposal.expected_updated_at
       or coalesce(v_metadata->>'whatsapp_owner','false')='true' then
      update public.whatsapp_workspace_data_proposals set state='stale',updated_at=v_now where id=v_proposal.id;
      update public.whatsapp_pending_actions set consumed_at=v_now where id=v_pending.id and consumed_at is null;
      v_result := pg_catalog.jsonb_build_object('ok',false,'reason','stale',
        'actionType','owner_workspace_data_stale','decision','confirm');
      insert into public.whatsapp_owner_action_receipts(provider_message_id,workspace_id,owner_id,phone,action_id,result)
        values(v_message_id,p_workspace_id,v_owner.owner_id,p_phone,v_pending.id,v_result);
      return v_result-'decision';
    elsif v_proposal.operation='update' then
      if v_proposal.values ? 'phone' and v_proposal.values->>'phone'=p_phone then
        return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
      end if;
      update public.customers c set
        name=case when v_proposal.values ? 'name' then v_proposal.values->>'name' else c.name end,
        company_name=case when v_proposal.values ? 'company_name' then v_proposal.values->>'company_name' else c.company_name end,
        email=case when v_proposal.values ? 'email' then v_proposal.values->>'email' else c.email end,
        phone=case when v_proposal.values ? 'phone' then v_proposal.values->>'phone' else c.phone end
        where c.workspace_id=p_workspace_id and c.id=v_proposal.target_id;
    elsif v_proposal.operation='delete' then
      if exists(select 1 from public.invoices i where i.workspace_id=p_workspace_id and i.customer_id=v_proposal.target_id) then
        return pg_catalog.jsonb_build_object('ok',false,'reason','in_use');
      end if;
      delete from public.customers c where c.workspace_id=p_workspace_id and c.id=v_proposal.target_id;
    else return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
    end if;
  elsif v_proposal.table_name='workspace_settings' then
    perform 1 from public.workspace_settings s where s.workspace_id=p_workspace_id
      and s.updated_at=v_proposal.expected_updated_at for update;
    if not found then
      update public.whatsapp_workspace_data_proposals set state='stale',updated_at=v_now where id=v_proposal.id;
      update public.whatsapp_pending_actions set consumed_at=v_now where id=v_pending.id and consumed_at is null;
      v_result := pg_catalog.jsonb_build_object('ok',false,'reason','stale',
        'actionType','owner_workspace_data_stale','decision','confirm');
      insert into public.whatsapp_owner_action_receipts(provider_message_id,workspace_id,owner_id,phone,action_id,result)
        values(v_message_id,p_workspace_id,v_owner.owner_id,p_phone,v_pending.id,v_result);
      return v_result-'decision';
    end if;
    update public.workspace_settings s set
      default_currency=case when v_proposal.values ? 'default_currency' then v_proposal.values->>'default_currency' else s.default_currency end,
      default_timezone=case when v_proposal.values ? 'default_timezone' then v_proposal.values->>'default_timezone' else s.default_timezone end
      where s.workspace_id=p_workspace_id;
  elsif v_proposal.table_name='workspace_ai_settings' then
    perform 1 from public.workspaces w where w.id=p_workspace_id for update;
    if v_proposal.expected_updated_at is null then
      if exists(select 1 from public.workspace_ai_settings a where a.workspace_id=p_workspace_id) then
        update public.whatsapp_workspace_data_proposals set state='stale',updated_at=v_now where id=v_proposal.id;
        update public.whatsapp_pending_actions set consumed_at=v_now where id=v_pending.id and consumed_at is null;
        v_result := pg_catalog.jsonb_build_object('ok',false,'reason','stale',
          'actionType','owner_workspace_data_stale','decision','confirm');
        insert into public.whatsapp_owner_action_receipts(provider_message_id,workspace_id,owner_id,phone,action_id,result)
          values(v_message_id,p_workspace_id,v_owner.owner_id,p_phone,v_pending.id,v_result);
        return v_result-'decision';
      end if;
      insert into public.workspace_ai_settings(workspace_id,primary_model,fallback_model)
      values(p_workspace_id,v_proposal.values->>'primary_model',v_proposal.values->>'fallback_model');
    else
      perform 1 from public.workspace_ai_settings a where a.workspace_id=p_workspace_id
        and a.updated_at=v_proposal.expected_updated_at for update;
      if not found then
        update public.whatsapp_workspace_data_proposals set state='stale',updated_at=v_now where id=v_proposal.id;
        update public.whatsapp_pending_actions set consumed_at=v_now where id=v_pending.id and consumed_at is null;
        v_result := pg_catalog.jsonb_build_object('ok',false,'reason','stale',
          'actionType','owner_workspace_data_stale','decision','confirm');
        insert into public.whatsapp_owner_action_receipts(provider_message_id,workspace_id,owner_id,phone,action_id,result)
          values(v_message_id,p_workspace_id,v_owner.owner_id,p_phone,v_pending.id,v_result);
        return v_result-'decision';
      end if;
      update public.workspace_ai_settings set primary_model=v_proposal.values->>'primary_model',
        fallback_model=v_proposal.values->>'fallback_model' where workspace_id=p_workspace_id;
    end if;
  else
    return pg_catalog.jsonb_build_object('ok',false,'reason','invalid');
  end if;

  update public.whatsapp_workspace_data_proposals set state='confirmed',confirmation_message_id=v_message_id,updated_at=v_now
    where id=v_proposal.id and state='pending';
  update public.whatsapp_pending_actions set consumed_at=v_now where id=v_pending.id and consumed_at is null;
  v_result := pg_catalog.jsonb_build_object('ok',true,'actionType','owner_workspace_data_confirmed',
    'table',v_proposal.table_name,'operation',v_proposal.operation,'summary',v_proposal.summary,'decision','confirm');
  insert into public.whatsapp_owner_action_receipts(provider_message_id,workspace_id,owner_id,phone,action_id,result)
    values(v_message_id,p_workspace_id,v_owner.owner_id,p_phone,v_pending.id,v_result);
  return v_result-'decision';
end;
$function$;

create or replace function public.whatsapp_workspace_data_confirm(
  p_workspace_id uuid,p_customer_id uuid,p_phone text,p_pending_id bigint,p_pending_version bigint,
  p_proposal_id uuid,p_confirmation_message_id text,p_cancel_message_id text,p_user_message text
) returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  return public.whatsapp_workspace_data_decide(p_workspace_id,p_customer_id,p_phone,p_pending_id,p_pending_version,
    p_proposal_id,p_confirmation_message_id,p_cancel_message_id,p_user_message,true);
end;
$function$;

create or replace function public.whatsapp_workspace_data_cancel(
  p_workspace_id uuid,p_customer_id uuid,p_phone text,p_pending_id bigint,p_pending_version bigint,
  p_proposal_id uuid,p_confirmation_message_id text,p_cancel_message_id text,p_user_message text
) returns jsonb language plpgsql security definer set search_path = '' as $function$
begin
  return public.whatsapp_workspace_data_decide(p_workspace_id,p_customer_id,p_phone,p_pending_id,p_pending_version,
    p_proposal_id,p_confirmation_message_id,p_cancel_message_id,p_user_message,false);
end;
$function$;

revoke all on function public.whatsapp_workspace_data_propose(uuid,uuid,text,text,text,text,uuid,timestamptz,jsonb,text,bigint,bigint,bigint)
  from public,anon,authenticated;
revoke all on function public.whatsapp_workspace_data_decide(uuid,uuid,text,bigint,bigint,uuid,text,text,text,boolean)
  from public,anon,authenticated,service_role;
revoke all on function public.whatsapp_workspace_data_confirm(uuid,uuid,text,bigint,bigint,uuid,text,text,text)
  from public,anon,authenticated;
revoke all on function public.whatsapp_workspace_data_cancel(uuid,uuid,text,bigint,bigint,uuid,text,text,text)
  from public,anon,authenticated;
grant execute on function public.whatsapp_workspace_data_propose(uuid,uuid,text,text,text,text,uuid,timestamptz,jsonb,text,bigint,bigint,bigint)
  to service_role;
grant execute on function public.whatsapp_workspace_data_confirm(uuid,uuid,text,bigint,bigint,uuid,text,text,text)
  to service_role;
grant execute on function public.whatsapp_workspace_data_cancel(uuid,uuid,text,bigint,bigint,uuid,text,text,text)
  to service_role;

commit;
