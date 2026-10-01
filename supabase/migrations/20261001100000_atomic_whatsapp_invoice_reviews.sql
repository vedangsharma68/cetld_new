do $migration$
begin
  alter table public.whatsapp_pending_actions
    add column if not exists version bigint not null default 1,
    add column if not exists generation bigint not null default 1,
    add column if not exists expires_at timestamptz;

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
    begin
      if p_phone is null or p_phone !~ '^\+[1-9][0-9]{6,14}$' then
        raise exception 'invalid review scope';
      end if;
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        p_workspace_id::text || ':' || p_customer_id::text || ':' || p_phone, 0));
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
      update public.whatsapp_pending_actions p set consumed_at = pg_catalog.clock_timestamp()
        where p.workspace_id = p_workspace_id and p.customer_id = p_customer_id and p.phone = p_phone
          and p.consumed_at is null and p.action->>'type' = 'invoice_review_draft'
          and (p.expires_at is null or p.expires_at <= pg_catalog.clock_timestamp());
      return query select p.id, p.version, p.generation, p.action, p.created_at, p.expires_at
        from public.whatsapp_pending_actions p
        where p.workspace_id = p_workspace_id and p.customer_id = p_customer_id and p.phone = p_phone
          and p.consumed_at is null and p.action->>'type' = 'invoice_review_draft'
          and p.expires_at > pg_catalog.clock_timestamp()
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
      v_to_stage text := p_action->>'stage';
    begin
      if p_action->>'type' <> 'invoice_review_draft'
        or p_from_stage not in ('extracting','incomplete','proposal','saving')
        or not ((p_from_stage = 'extracting' and v_to_stage in ('incomplete','proposal','canceled'))
          or (p_from_stage = 'incomplete' and v_to_stage in ('proposal','canceled'))
          or (p_from_stage = 'proposal' and v_to_stage in ('saving','canceled'))
          or (p_from_stage = 'saving' and v_to_stage in ('saved','proposal'))) then
        raise exception 'invalid invoice review transition';
      end if;
      if v_to_stage in ('proposal','saving','saved') and
        (p_action->'invoice' is null or p_action->'missingFields' <> '[]'::jsonb
          or p_action->>'currencySource' is null
          or p_action->>'currencySource' not in ('photo','user')) then
        raise exception 'incomplete invoice review proposal';
      end if;
      return query
        update public.whatsapp_pending_actions p
          set action = p_action, version = p.version + 1
          where p.id = p_id and p.version = p_version
            and p.workspace_id = p_workspace_id and p.customer_id = p_customer_id and p.phone = p_phone
            and p.consumed_at is null and p.expires_at > pg_catalog.clock_timestamp()
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
  revoke all on function public.whatsapp_load_invoice_review(uuid,uuid,text) from public, anon, authenticated;
  revoke all on function public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb) from public, anon, authenticated;
  grant select, insert, update on public.whatsapp_pending_actions to service_role;
  grant usage, select on sequence public.whatsapp_pending_actions_id_seq to service_role;
  grant execute on function public.whatsapp_begin_invoice_review(uuid,uuid,text) to service_role;
  grant execute on function public.whatsapp_load_invoice_review(uuid,uuid,text) to service_role;
  grant execute on function public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb) to service_role;
end
$migration$;
