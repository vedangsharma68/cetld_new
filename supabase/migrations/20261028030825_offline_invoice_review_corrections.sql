-- Offline candidates remain immutable printed evidence. This correction RPC
-- changes only a versioned review, never a ledger row or a save-stage rule.
begin;
create function public.whatsapp_correct_offline_invoice_review(
  p_id bigint, p_version bigint, p_workspace_id uuid, p_customer_id uuid, p_phone text,
  p_action jsonb, p_source_message_id text
) returns table(id bigint, version bigint, generation bigint, action jsonb,
  created_at timestamptz, expires_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, public
as $function$
declare
  v_row public.whatsapp_pending_actions%rowtype;
  v_key text;
  v_field text;
  v_fact jsonb;
  v_changed boolean := false;
  v_message text;
begin
  if p_id is null or p_version is null or p_workspace_id is null or p_customer_id is null
    or p_phone is null or p_phone !~ '^\+[1-9][0-9]{6,14}$'
    or nullif(p_source_message_id,'') is null or jsonb_typeof(p_action) is distinct from 'object' then
    raise exception 'invalid offline review correction';
  end if;
  select p.* into v_row from public.whatsapp_pending_actions p
    where p.id=p_id and p.version=p_version and p.workspace_id=p_workspace_id
      and p.customer_id=p_customer_id and p.phone=p_phone and p.consumed_at is null
      and p.expires_at>clock_timestamp() and p.action->>'type'='invoice_review_draft'
      and p.action->>'extractionRoute'='offline' and p.action->>'stage' in ('incomplete','proposal')
    for update;
  if not found then return; end if;
  select m.body into v_message from public.whatsapp_messages m
    where m.provider_message_id=p_source_message_id and m.workspace_id=p_workspace_id and m.phone=p_phone
      and (m.customer_id is null or m.customer_id=p_customer_id) and m.audience='owner'
      and m.direction='inbound' and m.status in ('received','accepted') and m.created_at>=v_row.created_at;
  if v_message is null then raise exception 'offline correction lacks scoped owner source'; end if;
  if coalesce(p_action->>'stage','') not in ('incomplete','proposal')
    or jsonb_typeof(p_action->'invoice') is distinct from 'object'
    or jsonb_typeof(p_action->'ownerProvidedFacts') is distinct from 'object'
    or jsonb_typeof(p_action->'missingFields') is distinct from 'array'
    or jsonb_typeof(p_action->'validationIssues') is distinct from 'array'
    or (p_action-array['stage','invoice','missingFields','ownerProvidedFacts','currencySource','validationIssues'])
      is distinct from (v_row.action-array['stage','invoice','missingFields','ownerProvidedFacts','currencySource','validationIssues']) then
    raise exception 'offline printed evidence is immutable';
  end if;
  -- Every changed candidate is sourced to this inbound owner turn. Other
  -- invoices, history, planner arguments and unsigned buttons grant no authority.
  for v_key in select jsonb_object_keys((p_action->'invoice') || (v_row.action->'invoice')) loop
    if p_action->'invoice'->v_key is distinct from v_row.action->'invoice'->v_key then
      if v_key not in ('invoiceNumber','clientName','invoiceDate','dueDate','total','currency','notes','direction','outstanding') then
        raise exception 'unsupported offline candidate correction';
      end if;
      if v_key='outstanding' then
        if v_row.action->'printedEvidence' ? 'outstandingAmount'
          or v_row.action->'invoice'->'outstanding' is distinct from v_row.action->'invoice'->'total'
          or p_action->'invoice'->'outstanding' is distinct from p_action->'invoice'->'total'
          or p_action->'invoice'->'total' is not distinct from v_row.action->'invoice'->'total' then
          raise exception 'printed balance requires payment review';
        end if;
        continue;
      end if;
      v_field := case when v_key='clientName' then 'customerName' else v_key end;
      v_fact := p_action->'ownerProvidedFacts'->v_field;
      if jsonb_typeof(v_fact) is distinct from 'object' or v_fact-array['value','sourceMessageId']<>'{}'::jsonb
        or v_fact->'value' is distinct from p_action->'invoice'->v_key
        or v_fact->>'sourceMessageId' is distinct from p_source_message_id then
        raise exception 'offline candidate lacks owner evidence';
      end if;
      v_changed := true;
    end if;
  end loop;
  -- Resolving a conflicting printed value may retain the same candidate value.
  for v_field in select jsonb_object_keys(p_action->'ownerProvidedFacts') loop
    v_fact := p_action->'ownerProvidedFacts'->v_field;
    if v_fact is distinct from v_row.action->'ownerProvidedFacts'->v_field then
      v_key := case when v_field='customerName' then 'clientName' else v_field end;
      if v_field not in ('invoiceNumber','customerName','invoiceDate','dueDate','total','currency','notes','direction')
        or jsonb_typeof(v_fact) is distinct from 'object' or v_fact-array['value','sourceMessageId']<>'{}'::jsonb
        or v_fact->'value' is distinct from p_action->'invoice'->v_key
        or v_fact->>'sourceMessageId' is distinct from p_source_message_id then
        raise exception 'invalid offline owner fact';
      end if;
      if v_field='direction' and (v_fact->>'value' is distinct from 'receivable'
        or v_message ~ '[?''"“”`]' or v_message ~* '\m(not|never|didn''t|don''t|if|maybe|whether|wasn''t|could|would|someone|says|said|quoted|perhaps|might|later|tomorrow|next)\M'
        or v_message !~* '\m(we|i|our business|my business)[[:space:]]+(have[[:space:]]+)?(issued|sent|created|made)[[:space:]]+(it|((this|that|the)[[:space:]]+)?invoice)\M|\missued by (us|me|our business)\M') then
        raise exception 'offline direction requires explicit issuance';
      end if;
      v_changed := true;
    end if;
  end loop;
  if not v_changed or exists(select 1 from jsonb_object_keys(coalesce(v_row.action->'ownerProvidedFacts','{}'::jsonb)) k
    where not (p_action->'ownerProvidedFacts' ? k)) then raise exception 'invalid offline fact update'; end if;
  if p_action->'ownerProvidedFacts'->'currency' is distinct from v_row.action->'ownerProvidedFacts'->'currency' then
    if p_action->>'currencySource' is distinct from 'user' then raise exception 'corrected currency requires user source'; end if;
  elsif p_action->'currencySource' is distinct from v_row.action->'currencySource' then
    raise exception 'offline currency provenance is immutable';
  end if;
  if v_row.action->'paymentEvidence'->>'status' in ('paid','partial','conflicting')
    and not (p_action->'validationIssues' @> '["PAYMENT_RECORD_REQUIRES_REVIEW"]'::jsonb) then
    raise exception 'offline correction cannot erase payment review';
  end if;
  if p_action->>'stage'='proposal' and (p_action->'missingFields'<>'[]'::jsonb
    or p_action->'validationIssues'<>'[]'::jsonb or p_action->'invoice'->>'direction' is distinct from 'receivable'
    or coalesce(p_action->>'currencySource','') not in ('photo','user')
    or coalesce(p_action->'invoice'->>'currency','') not in ('INR','USD','EUR','GBP','AED','SGD','AUD','CAD','CHF')
    or nullif(p_action->'invoice'->>'invoiceNumber','') is null or nullif(p_action->'invoice'->>'clientName','') is null
    or p_action->'invoice'->>'invoiceDate' is null or (p_action->'invoice'->>'total')::numeric<=0) then
    raise exception 'incomplete offline review cannot become proposal';
  end if;
  return query update public.whatsapp_pending_actions p set action=p_action,version=p.version+1
    where p.id=v_row.id and p.version=v_row.version returning p.id,p.version,p.generation,p.action,p.created_at,p.expires_at;
end
$function$;
revoke all on function public.whatsapp_correct_offline_invoice_review(bigint,bigint,uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.whatsapp_correct_offline_invoice_review(bigint,bigint,uuid,uuid,text,jsonb,text) to service_role;
commit;
