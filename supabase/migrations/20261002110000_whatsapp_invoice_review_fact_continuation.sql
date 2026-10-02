-- Allow the verified owner model to persist explicit facts into an incomplete
-- attachment review without replacing facts extracted from the source document.
-- The operation remains a scoped, versioned compare-and-set on one pending row.
begin;

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
  v_current_action jsonb;
  v_created_at timestamptz;
  v_field text;
  v_invoice_key text;
  v_fact jsonb;
  v_resolved_fields text[] := array[]::text[];
  v_resolved_invoice_keys text[] := array[]::text[];
  v_missing_count integer;
  v_distinct_missing_count integer;
  v_message_exists boolean;
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
      or (p_from_stage = 'incomplete' and v_to_stage in ('incomplete','proposal','canceled'))
      or (p_from_stage = 'proposal' and v_to_stage in ('saving','canceled'))
      or (p_from_stage = 'saving' and v_to_stage in ('saved','proposal','failed'))
      or (p_from_stage = 'failed' and v_to_stage = 'canceled')) then
    raise exception 'invalid invoice review transition';
  end if;

  select p.action, p.created_at into v_current_action, v_created_at
    from public.whatsapp_pending_actions p
    where p.id = p_id and p.version = p_version
      and p.workspace_id = p_workspace_id and p.customer_id = p_customer_id and p.phone = p_phone
      and p.consumed_at is null
      and (p.expires_at > pg_catalog.clock_timestamp() or p_from_stage = 'saving')
      and p.action->>'type' = 'invoice_review_draft' and p.action->>'stage' = p_from_stage
    for update;
  if not found then return; end if;

  if p_from_stage = 'incomplete' and v_to_stage in ('incomplete','proposal') then
    if pg_catalog.jsonb_typeof(v_current_action->'missingFields') is distinct from 'array'
      or pg_catalog.jsonb_typeof(p_action->'missingFields') is distinct from 'array'
      or pg_catalog.jsonb_typeof(v_current_action->'invoice') is distinct from 'object'
      or pg_catalog.jsonb_typeof(p_action->'invoice') is distinct from 'object'
      or pg_catalog.jsonb_typeof(coalesce(v_current_action->'ownerProvidedFacts','{}'::jsonb)) is distinct from 'object'
      or pg_catalog.jsonb_typeof(coalesce(p_action->'ownerProvidedFacts','{}'::jsonb)) is distinct from 'object'
      or (p_action - array['stage','invoice','missingFields','ownerProvidedFacts','currencySource'])
        is distinct from (v_current_action - array['stage','invoice','missingFields','ownerProvidedFacts','currencySource']) then
      raise exception 'invalid invoice review fact update';
    end if;

    v_missing_count := pg_catalog.jsonb_array_length(p_action->'missingFields');
    select count(distinct field.value)::integer
      into v_distinct_missing_count
      from pg_catalog.jsonb_array_elements_text(p_action->'missingFields') as field(value);
    if v_missing_count is distinct from v_distinct_missing_count
      or exists (
        select 1 from pg_catalog.jsonb_array_elements_text(p_action->'missingFields') as next_field(value)
        where next_field.value not in ('invoiceNumber','customerName','invoiceDate','dueDate','total','currency','direction')
          or not (v_current_action->'missingFields' @> pg_catalog.to_jsonb(next_field.value))
      ) then
      raise exception 'invalid invoice review missing fields';
    end if;

    for v_field in select pg_catalog.jsonb_array_elements_text(v_current_action->'missingFields') loop
      if not (p_action->'missingFields' @> pg_catalog.to_jsonb(v_field)) then
        v_invoice_key := case when v_field = 'customerName' then 'clientName' else v_field end;
        v_fact := p_action->'ownerProvidedFacts'->v_field;
        if pg_catalog.jsonb_typeof(v_fact) is distinct from 'object'
          or (v_fact - array['value','sourceMessageId']) <> '{}'::jsonb
          or v_fact->'value' is null or v_fact->'value' = 'null'::jsonb
          or p_action->'invoice'->v_invoice_key is null
          or p_action->'invoice'->v_invoice_key is distinct from v_fact->'value'
          or nullif(v_fact->>'sourceMessageId','') is null then
          raise exception 'invoice review fact lacks owner evidence';
        end if;
        if v_field = 'direction' and v_fact->>'value' is distinct from 'receivable' then
          raise exception 'invoice review direction must be explicitly receivable';
        end if;
        select exists (
          select 1 from public.whatsapp_messages m
          where m.provider_message_id = v_fact->>'sourceMessageId'
            and m.workspace_id = p_workspace_id and m.phone = p_phone
            and m.audience = 'owner' and m.direction = 'inbound'
            and m.status in ('received','accepted') and m.created_at >= v_created_at
        ) into v_message_exists;
        if not v_message_exists then raise exception 'invoice review fact source is outside owner scope'; end if;
        v_resolved_fields := pg_catalog.array_append(v_resolved_fields, v_field);
        v_resolved_invoice_keys := pg_catalog.array_append(v_resolved_invoice_keys, v_invoice_key);
      end if;
    end loop;

    if cardinality(v_resolved_fields) = 0
      or (p_action->'ownerProvidedFacts' - v_resolved_fields)
        is distinct from (coalesce(v_current_action->'ownerProvidedFacts','{}'::jsonb) - v_resolved_fields)
      or (p_action->'invoice' - v_resolved_invoice_keys)
        is distinct from (v_current_action->'invoice' - v_resolved_invoice_keys) then
      raise exception 'invoice review update cannot overwrite existing facts';
    end if;

    if v_to_stage = 'incomplete' and v_missing_count = 0 then
      raise exception 'complete invoice review must become a proposal';
    end if;
    if v_to_stage = 'proposal' and v_missing_count <> 0 then
      raise exception 'incomplete invoice review cannot become a proposal';
    end if;
    if 'currency' = any(v_resolved_fields) then
      if p_action->>'currencySource' is distinct from 'user' then
        raise exception 'owner-provided currency must retain its source';
      end if;
    elsif p_action->'currencySource' is distinct from v_current_action->'currencySource' then
      -- Legacy reviewDraft stored null provenance for confident extracted
      -- currencies. Its missingFields list preserves that confidence result.
      -- The invoice currency remains protected by the fixed-fact check above.
      if (v_current_action->>'currencySource' is null
        and p_action->>'currencySource' = 'photo'
        and v_current_action->'invoice'->>'currency' ~ '^[A-Za-z]{3}$'
        and not (v_current_action->'missingFields' @> pg_catalog.to_jsonb('currency'::text))) is not true then
        raise exception 'invoice review currency source is immutable';
      end if;
    end if;
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
$function$;

revoke all on function public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb) to service_role;

commit;
