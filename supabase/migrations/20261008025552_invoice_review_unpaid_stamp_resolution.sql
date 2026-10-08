-- Proposed forward migration: awaiting separate approval before production apply.
-- Updates one routine only; no data, table, invoice, payment or message is changed.
begin;

-- Refuse unknown installed source before replacing anything. The allowed
-- bodies are the approved PR88 continuation and this exact forward fix,
-- each with either all LF or all CRLF line endings. Unknown source fails closed.
do $source_guard$
declare
  v_source text;
begin
  select p.prosrc into strict v_source from pg_catalog.pg_proc p
    where p.oid='public.whatsapp_transition_invoice_review(bigint,bigint,uuid,uuid,text,text,jsonb)'::regprocedure;
  if pg_catalog.md5(v_source) not in (
    '3073ffde75cc1168a4f74688a52fa30b', -- approved predecessor, LF
    'be56f8a9d0344bea9c74b425846d015e', -- approved predecessor, CRLF
    'f39fc6258f46e3fe933f87b77aadea2a', -- exact forward fix, LF
    'e037e6cdba625a819dd0293d0706140d'  -- exact forward fix, CRLF
  ) then
    raise exception 'Unexpected invoice review source; no changes applied';
  end if;
end
$source_guard$;

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
  v_unpaid_resolution boolean := false;
  v_resolution jsonb;
  v_owner_quote text;
  v_balance_match text[];
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
      or (p_action - array['stage','invoice','missingFields','ownerProvidedFacts','currencySource','validationIssues','paymentStatusResolution'])
        is distinct from (v_current_action - array['stage','invoice','missingFields','ownerProvidedFacts','currencySource','validationIssues','paymentStatusResolution']) then
      raise exception 'invalid invoice review fact update';
    end if;


    -- A false PAID stamp may be resolved only by a current persisted owner's
    -- explicit issuer/unpaid/full-balance instruction. Source facts stay fixed.
    if p_action->'validationIssues' is distinct from v_current_action->'validationIssues'
      or p_action->'paymentStatusResolution' is distinct from v_current_action->'paymentStatusResolution' then
      v_resolution := p_action->'paymentStatusResolution';
      v_owner_quote := v_resolution->>'ownerInstruction';
      if v_current_action->'validationIssues' is distinct from '["PAYMENT_STATUS_CONFLICT"]'::jsonb
        or p_action->'validationIssues' is distinct from '[]'::jsonb
        or v_current_action ? 'paymentStatusResolution'
        or jsonb_typeof(v_resolution) is distinct from 'object'
        or v_resolution - array['status','outstanding','currency','sourceMessageId','ownerInstruction'] <> '{}'::jsonb
        or v_resolution->>'status' is distinct from 'unpaid'
        or v_resolution->'outstanding' is distinct from v_current_action->'invoice'->'total'
        or v_resolution->>'currency' is distinct from p_action->'invoice'->>'currency'
        or p_action->'invoice'->>'direction' is distinct from 'receivable'
        or v_current_action->'invoice'->'alreadyPaid' is distinct from 'false'::jsonb
        or jsonb_typeof(v_current_action->'invoice'->'total') is distinct from 'number'
        or (v_current_action->'invoice'->>'total')::numeric <= 0
        or v_current_action->'invoice'->'outstanding' is distinct from v_current_action->'invoice'->'total'
        or coalesce(v_current_action->'paymentEvidence'->>'status','') not in ('paid','conflicting')
        or coalesce(v_current_action->'paymentEvidence'->>'text','') !~* '\mPAID\M'
        or v_owner_quote is null or length(v_owner_quote) not between 1 and 4000
        or nullif(v_resolution->>'sourceMessageId','') is null
        or v_resolution->>'sourceMessageId' = v_current_action->>'sourceMessageId'
        or v_owner_quote ~ '[?"“”`]' or replace(replace(v_owner_quote,'’',''''),'‘','''') ~ '(^|[[:space:]])'''
        or replace(replace(v_owner_quote,'’',''''),'‘','''') ~* '\m(not|never|isn''t|wasn''t|aren''t|don''t|didn''t|cannot|can''t|maybe|perhaps|might|could|would|if|whether|later|tomorrow|next|someone|says|said|quoted)\M'
        or v_owner_quote !~* '\m(my business|our business|we|i)[[:space:]]+(have[[:space:]]+)?issued\M'
        or v_owner_quote !~* '\m(it|this( invoice)?|the invoice)[[:space:]]+is[[:space:]]+unpaid\M'
        or v_owner_quote !~* '\m(the[[:space:]]+)?PAID[[:space:]]+(stamp|marking|watermark)[[:space:]]+is[[:space:]]+(incorrect|wrong|false)\M'
        or v_owner_quote ~* '\m(it|this( invoice)?|the invoice)[[:space:]]+is[[:space:]]+(already[[:space:]]+)?paid\M'
        or v_owner_quote ~* '\mPAID[[:space:]]+(stamp|marking|watermark)[[:space:]]+is[[:space:]]+(correct|right|true)\M' then
        raise exception 'invoice review unpaid resolution lacks explicit evidence';
      end if;
      v_balance_match := regexp_match(v_owner_quote,
        '\m(the[[:space:]]+)?full[[:space:]]+([A-Za-z]{3})[[:space:]]+([0-9]+([.][0-9]{1,2})?)[[:space:]]+(is[[:space:]]+)?still[[:space:]]+due\M','i');
      if v_balance_match is null or upper(v_balance_match[2]) is distinct from v_resolution->>'currency'
        or v_balance_match[3]::numeric is distinct from (v_current_action->'invoice'->>'total')::numeric
        or (select count(*) from regexp_matches(v_owner_quote,'\mfull[[:space:]]+[A-Za-z]{3}[[:space:]]+[0-9]+([.][0-9]{1,2})?[[:space:]]+(is[[:space:]]+)?still[[:space:]]+due\M','gi')) <> 1
        or (select count(*) from public.whatsapp_resolve_verified_owner(p_phone) r
          where r.workspace_id=p_workspace_id and r.customer_id=p_customer_id) <> 1
        or not exists (select 1 from public.whatsapp_inbound_events e
          where e.provider_message_id=v_resolution->>'sourceMessageId' and e.sender_phone=p_phone
            and e.status='processing' and e.message_text=v_owner_quote and e.received_at>=v_created_at)
        or not exists (select 1 from public.whatsapp_messages m
          where m.provider_message_id=v_resolution->>'sourceMessageId'
            and m.workspace_id=p_workspace_id and m.phone=p_phone and m.customer_id=p_customer_id
            and m.audience='owner' and m.direction='inbound' and m.status in ('received','accepted')
            and m.body=v_owner_quote and m.created_at>=v_created_at) then
        raise exception 'invoice review unpaid resolution source is outside current owner scope';
      end if;
      v_unpaid_resolution := true;
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

    if (cardinality(v_resolved_fields) = 0 and not v_unpaid_resolution)
      or ((p_action->'ownerProvidedFacts') - v_resolved_fields)
        is distinct from (coalesce(v_current_action->'ownerProvidedFacts','{}'::jsonb) - v_resolved_fields)
      or ((p_action->'invoice') - v_resolved_invoice_keys)
        is distinct from ((v_current_action->'invoice') - v_resolved_invoice_keys) then
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
      or coalesce(p_action->'validationIssues','[]'::jsonb) is distinct from '[]'::jsonb
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


commit;
