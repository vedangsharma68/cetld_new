do $migration$
begin
  alter table public.whatsapp_pending_actions
    add column if not exists version bigint not null default 1,
    add column if not exists generation bigint not null default 1,
    add column if not exists expires_at timestamptz;

  execute $sql$
    create or replace function public.whatsapp_claim_pending_action(
      p_id bigint, p_workspace_id uuid, p_customer_id uuid, p_phone text
    ) returns table(id bigint, version bigint, generation bigint, action jsonb)
    language plpgsql security definer
    set search_path = pg_catalog, public
    as $function$
    begin
      if p_id is null or p_workspace_id is null or p_customer_id is null or p_phone is null
        or p_phone !~ '^\+[1-9][0-9]{6,14}$' then raise exception 'invalid pending action scope'; end if;
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        p_workspace_id::text || ':' || p_customer_id::text || ':' || p_phone, 0));
      return query update public.whatsapp_pending_actions p set consumed_at = pg_catalog.clock_timestamp()
        where p.id = p_id and p.workspace_id = p_workspace_id and p.customer_id = p_customer_id
          and p.phone = p_phone and p.consumed_at is null and p.action->>'type' <> 'invoice_review_draft'
        returning p.id, p.version, p.generation, p.action;
    end
    $function$
  $sql$;

  execute $sql$
    create or replace function public.whatsapp_load_pending_action_state(
      p_workspace_id uuid, p_customer_id uuid, p_phone text
    ) returns table(id bigint, version bigint, generation bigint, action jsonb)
    language plpgsql security definer
    set search_path = pg_catalog, public
    as $function$
    begin
      if p_workspace_id is null or p_customer_id is null or p_phone is null
        or p_phone !~ '^\+[1-9][0-9]{6,14}$' then raise exception 'invalid pending action scope'; end if;
      return query
        with latest as (
          select p.generation from public.whatsapp_pending_actions p
          where p.workspace_id = p_workspace_id and p.customer_id = p_customer_id and p.phone = p_phone
          order by p.generation desc limit 1
        ), active as (
          select p.id, p.version, p.generation, p.action from public.whatsapp_pending_actions p
          where p.workspace_id = p_workspace_id and p.customer_id = p_customer_id and p.phone = p_phone
            and p.consumed_at is null order by p.generation desc limit 1
        )
        select active.id, active.version, coalesce(latest.generation, 0), active.action
          from (select 1) seed left join latest on true left join active on true;
    end
    $function$
  $sql$;

  execute $sql$
    create or replace function public.whatsapp_store_pending_action(
      p_workspace_id uuid, p_customer_id uuid, p_phone text, p_action jsonb, p_source text,
      p_expected_generation bigint, p_expected_id bigint, p_expected_version bigint
    ) returns table(id bigint, version bigint, generation bigint, action jsonb)
    language plpgsql security definer
    set search_path = pg_catalog, public
    as $function$
    declare
      v_generation bigint;
      v_active public.whatsapp_pending_actions%rowtype;
    begin
      if p_workspace_id is null or p_customer_id is null or p_phone is null
        or p_phone !~ '^\+[1-9][0-9]{6,14}$' or p_expected_generation is null
        or p_action is null or pg_catalog.jsonb_typeof(p_action) is distinct from 'object'
        or p_source is null or p_source = '' then raise exception 'invalid pending action'; end if;
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        p_workspace_id::text || ':' || p_customer_id::text || ':' || p_phone, 0));
      select coalesce(max(p.generation), 0) into v_generation from public.whatsapp_pending_actions p
        where p.workspace_id = p_workspace_id and p.customer_id = p_customer_id and p.phone = p_phone;
      select p.* into v_active from public.whatsapp_pending_actions p
        where p.workspace_id = p_workspace_id and p.customer_id = p_customer_id and p.phone = p_phone
          and p.consumed_at is null order by p.generation desc limit 1 for update;
      if v_generation <> p_expected_generation
        or v_active.id is distinct from p_expected_id
        or v_active.version is distinct from p_expected_version then return; end if;
      if v_active.id is not null and v_active.action->>'type' = 'invoice_review_draft'
        and v_active.action->>'stage' in ('extracting','incomplete','proposal','saving','failed') then return; end if;
      update public.whatsapp_pending_actions p set consumed_at = pg_catalog.clock_timestamp()
        where p.workspace_id = p_workspace_id and p.customer_id = p_customer_id and p.phone = p_phone
          and p.consumed_at is null;
      return query insert into public.whatsapp_pending_actions(workspace_id,customer_id,phone,action,source,version,generation)
        values(p_workspace_id,p_customer_id,p_phone,p_action,p_source,1,v_generation + 1)
        returning whatsapp_pending_actions.id, whatsapp_pending_actions.version,
          whatsapp_pending_actions.generation, whatsapp_pending_actions.action;
    end
    $function$
  $sql$;

  execute $sql$
    create or replace function public.whatsapp_begin_invoice_review(
      p_workspace_id uuid, p_customer_id uuid, p_phone text
    ) returns table(id bigint, version bigint, generation bigint, action jsonb,
      created_at timestamptz, expires_at timestamptz)
    language plpgsql security definer
    set search_path = pg_catalog, public
    as $function$
    declare
      v_generation bigint;
      v_active public.whatsapp_pending_actions%rowtype;
    begin
      if p_workspace_id is null or p_customer_id is null or p_phone is null
        or p_phone !~ '^\+[1-9][0-9]{6,14}$' then
        raise exception 'invalid review scope';
      end if;
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        p_workspace_id::text || ':' || p_customer_id::text || ':' || p_phone, 0));
      select p.* into v_active from public.whatsapp_pending_actions p
        where p.workspace_id = p_workspace_id and p.customer_id = p_customer_id and p.phone = p_phone
          and p.consumed_at is null and p.action->>'type' = 'invoice_review_draft'
        order by p.created_at desc limit 1 for update;
      if v_active.id is not null and v_active.action->>'stage' = 'saving' then
        return query select v_active.id, v_active.version, v_active.generation, v_active.action,
          v_active.created_at, v_active.expires_at;
        return;
      end if;
      select coalesce(max(p.generation), 0) + 1 into v_generation
        from public.whatsapp_pending_actions p
        where p.workspace_id = p_workspace_id and p.customer_id = p_customer_id and p.phone = p_phone;
      update public.whatsapp_pending_actions p set consumed_at = pg_catalog.clock_timestamp()
        where p.workspace_id = p_workspace_id and p.customer_id = p_customer_id and p.phone = p_phone
          and p.consumed_at is null;
      return query
        insert into public.whatsapp_pending_actions(workspace_id, customer_id, phone, action, source,
          version, generation, expires_at)
        values (p_workspace_id, p_customer_id, p_phone,
          pg_catalog.jsonb_build_object('type','invoice_review_draft','stage','extracting'),
          'whatsapp', 1, v_generation, pg_catalog.clock_timestamp() + interval '15 minutes')
        returning whatsapp_pending_actions.id, whatsapp_pending_actions.version,
          whatsapp_pending_actions.generation, whatsapp_pending_actions.action,
          whatsapp_pending_actions.created_at, whatsapp_pending_actions.expires_at;
    end
    $function$
  $sql$;

  execute $sql$
    create or replace function public.whatsapp_load_invoice_review(
      p_workspace_id uuid, p_customer_id uuid, p_phone text
    ) returns table(id bigint, version bigint, generation bigint, action jsonb,
      created_at timestamptz, expires_at timestamptz)
    language plpgsql security definer
    set search_path = pg_catalog, public
    as $function$
    begin
      if p_workspace_id is null or p_customer_id is null or p_phone is null
        or p_phone !~ '^\+[1-9][0-9]{6,14}$' then raise exception 'invalid review scope'; end if;
      update public.whatsapp_pending_actions p set consumed_at = pg_catalog.clock_timestamp()
        where p.workspace_id = p_workspace_id and p.customer_id = p_customer_id and p.phone = p_phone
          and p.consumed_at is null and p.action->>'type' = 'invoice_review_draft'
          and (p.expires_at is null or p.expires_at <= pg_catalog.clock_timestamp())
          and p.action->>'stage' is distinct from 'saving';
      return query select p.id, p.version, p.generation, p.action, p.created_at, p.expires_at
        from public.whatsapp_pending_actions p
        where p.workspace_id = p_workspace_id and p.customer_id = p_customer_id and p.phone = p_phone
          and p.consumed_at is null and p.action->>'type' = 'invoice_review_draft'
          and (p.expires_at > pg_catalog.clock_timestamp() or p.action->>'stage' = 'saving')
        order by p.created_at desc limit 1;
    end
    $function$
  $sql$;

  execute $sql$
    create or replace function public.whatsapp_transition_invoice_review(
      p_id bigint, p_version bigint, p_workspace_id uuid, p_customer_id uuid, p_phone text,
      p_from_stage text, p_action jsonb
    ) returns table(id bigint, version bigint, generation bigint, action jsonb,
      created_at timestamptz, expires_at timestamptz)
    language plpgsql security definer
    set search_path = pg_catalog, public
    as $function$
    declare
      v_to_stage text;
    begin
      if p_action is not null and pg_catalog.jsonb_typeof(p_action) = 'object' then
        v_to_stage := p_action->>'stage';
      end if;
      if p_id is null or p_version is null or p_workspace_id is null or p_customer_id is null
        or p_phone is null or p_phone !~ '^\+[1-9][0-9]{6,14}$'
        or p_action is null or pg_catalog.jsonb_typeof(p_action) is distinct from 'object'
        or p_action->>'type' is distinct from 'invoice_review_draft'
        or p_from_stage is null or p_from_stage not in ('extracting','incomplete','proposal','saving','failed')
        or v_to_stage is null or v_to_stage not in ('incomplete','proposal','saving','saved','failed','canceled')
        or not ((p_from_stage = 'extracting' and v_to_stage in ('incomplete','proposal','canceled'))
          or (p_from_stage = 'incomplete' and v_to_stage in ('proposal','canceled'))
          or (p_from_stage = 'proposal' and v_to_stage in ('saving','canceled'))
          or (p_from_stage = 'saving' and v_to_stage in ('saved','proposal','failed'))
          or (p_from_stage = 'failed' and v_to_stage = 'canceled')) then
        raise exception 'invalid invoice review transition';
      end if;
      if v_to_stage in ('proposal','saving','saved') and
        (p_action->'invoice' is null or pg_catalog.jsonb_typeof(p_action->'invoice') is distinct from 'object'
          or p_action->'missingFields' is distinct from '[]'::jsonb
          or p_action->>'currencySource' is null
          or p_action->>'currencySource' not in ('photo','user')) then
        raise exception 'incomplete invoice review proposal';
      end if;
      return query
        update public.whatsapp_pending_actions p
          set action = p_action, version = p.version + 1
          where p.id = p_id and p.version = p_version
            and p.workspace_id = p_workspace_id and p.customer_id = p_customer_id and p.phone = p_phone
            and p.consumed_at is null
            and (p.expires_at > pg_catalog.clock_timestamp() or p_from_stage = 'saving')
            and p.action->>'type' = 'invoice_review_draft' and p.action->>'stage' = p_from_stage
          returning p.id, p.version, p.generation, p.action, p.created_at, p.expires_at;
    end
    $function$
  $sql$;

  alter table public.whatsapp_pending_actions enable row level security;
  alter table public.whatsapp_pending_actions force row level security;
  revoke all on public.whatsapp_pending_actions from public, anon, authenticated;
  revoke all on sequence public.whatsapp_pending_actions_id_seq from public, anon, authenticated;
  revoke all on function public.whatsapp_begin_invoice_review(uuid,uuid,text) from public, anon, authenticated;
  revoke all on function public.whatsapp_load_pending_action_state(uuid,uuid,text) from public, anon, authenticated;
  revoke all on function public.whatsapp_store_pending_action(uuid,uuid,text,jsonb,text,bigint,bigint,bigint) from public, anon, authenticated;
  revoke all on function public.whatsapp_claim_pending_action(bigint,uuid,uuid,text) from public, anon, authenticated;
  revoke all on function public.whatsapp_load_invoice_review(uuid,uuid,text) from public, anon, authenticated;
  revoke all on function public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb) from public, anon, authenticated;
  grant select, insert, update on public.whatsapp_pending_actions to service_role;
  grant usage, select on sequence public.whatsapp_pending_actions_id_seq to service_role;
  grant execute on function public.whatsapp_begin_invoice_review(uuid,uuid,text) to service_role;
  grant execute on function public.whatsapp_load_pending_action_state(uuid,uuid,text) to service_role;
  grant execute on function public.whatsapp_store_pending_action(uuid,uuid,text,jsonb,text,bigint,bigint,bigint) to service_role;
  grant execute on function public.whatsapp_claim_pending_action(bigint,uuid,uuid,text) to service_role;
  grant execute on function public.whatsapp_load_invoice_review(uuid,uuid,text) to service_role;
  grant execute on function public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb) to service_role;
end
$migration$;
