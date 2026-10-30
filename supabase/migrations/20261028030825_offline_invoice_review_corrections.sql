-- Offline candidates remain immutable printed evidence. This correction RPC
-- changes only a versioned review, never a ledger row or a save-stage rule.
begin;
-- Monotonic business provenance survives bounded histories, contact replies,
-- expired reviews, recovery and transport changes. No text phrase grants it.
create table app.offline_invoice_businesses (
  workspace_id uuid primary key references public.workspaces(id) on delete cascade
);
alter table app.offline_invoice_businesses enable row level security;
revoke all on app.offline_invoice_businesses from public,anon,authenticated,service_role;
insert into app.offline_invoice_businesses(workspace_id)
  select distinct workspace_id from public.whatsapp_pending_actions
  where action->>'extractionRoute'='offline' on conflict do nothing;
-- Persist provenance atomically with every offline review, including stores
-- invoked directly and recovery paths that do not append a conversation turn.
create function app.retain_offline_invoice_provenance() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.action->>'extractionRoute'='offline' then
    insert into app.offline_invoice_businesses values(new.workspace_id) on conflict do nothing;
  end if;
  return new;
end $$;
revoke all on function app.retain_offline_invoice_provenance() from public,anon,authenticated,service_role;
create trigger retain_offline_invoice_provenance after insert or update of action on public.whatsapp_pending_actions
  for each row execute function app.retain_offline_invoice_provenance();
create function public.owner_assistant_offline_provenance(p_workspace_id uuid,p_owner_id uuid default null,p_mark boolean default false)
returns boolean language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' and
    not (auth.role()='authenticated' and exists(select 1 from public.workspace_members where workspace_id=p_workspace_id and user_id=auth.uid())) then
    raise exception 'owner required' using errcode='42501';
  end if;
  if p_mark then
    if auth.role() is distinct from 'service_role' then raise exception 'service role required' using errcode='42501'; end if;
    insert into app.offline_invoice_businesses values(p_workspace_id) on conflict do nothing;
  end if;
  return exists(select 1 from app.offline_invoice_businesses where workspace_id=p_workspace_id);
end $$;
revoke all on function public.owner_assistant_offline_provenance(uuid,uuid,boolean) from public,anon;
grant execute on function public.owner_assistant_offline_provenance(uuid,uuid,boolean) to authenticated,service_role;

create function app.offline_review_date(v text) returns boolean language plpgsql immutable set search_path='' as $$
begin
  return v ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and to_char(v::date,'YYYY-MM-DD')=v;
exception when others then return false;
end $$;
create function app.offline_review_display(v jsonb) returns text language sql immutable set search_path='' as $$
select case when v is null or v='null'::jsonb then 'not shown'
 when jsonb_typeof(v)='array' then coalesce((select string_agg((x->>'description')||': quantity '||coalesce(x->>'quantity','?')||', rate '||coalesce(x->>'unitPrice','?')||', amount '||coalesce(x->>'amount','?'),'; ') from jsonb_array_elements(v) x),'none')
 else v#>>'{}' end;
$$;
create function app.offline_review_render_length(a jsonb,missing jsonb,issues jsonb) returns integer language plpgsql set search_path='' as $$
declare
  rendered text:='Local invoice review. Check every value against the original:';
  field text; key text; label text; value jsonb; printed jsonb; provenance text; corrected boolean; details text;
  labels jsonb:='{"invoiceNumber":"invoice number","customerName":"customer","invoiceDate":"invoice date","dueDate":"due date","subtotal":"subtotal","tax":"tax","total":"total","outstandingAmount":"balance","currency":"currency","direction":"direction","clientEmail":"email","clientPhone":"phone","clientPhoneRaw":"local phone","notes":"notes","lineItems":"line items"}';
  explanations jsonb:='{"PAYMENT_RECORD_REQUIRES_REVIEW":"printed payment status needs review; no payment can be inferred","PARTIAL_BALANCE_REQUIRES_PAYMENT_RECORD":"printed balance differs from the total and needs payment review","INVOICE_TOTAL_DOES_NOT_MATCH_SUBTOTAL_AND_TAX":"subtotal plus tax does not match the total","LINE_ITEMS_DO_NOT_MATCH_SUBTOTAL":"line items do not match the subtotal"}';
begin
  foreach field in array array['invoiceNumber','customerName','invoiceDate','dueDate','subtotal','tax','total','outstandingAmount','currency','clientEmail','clientPhone','clientPhoneRaw','notes','direction','lineItems'] loop
    key:=case field when 'customerName' then 'clientName' when 'outstandingAmount' then 'outstanding' else field end;
    value:=a->'invoice'->key;printed:=a->'printedEvidence'->field;corrected:=a->'ownerProvidedFacts' ? field;
    if (value is null or value='null'::jsonb) and printed is null and field not in ('invoiceNumber','customerName','invoiceDate','total','currency','direction','dueDate') then continue; end if;
    provenance:='';
    if printed is not null then
      if printed->'value' is not distinct from value then
        provenance:=case when (printed->'value' is null or printed->'value'='null'::jsonb) and printed->>'text' is not null
          then ' (printed: '||replace(printed->>'text',E'\n','; ')||')' else ' (printed)' end;
      else provenance:=' (printed: '||case when (printed->'value' is null or printed->'value'='null'::jsonb) and printed->>'text' is not null then replace(printed->>'text',E'\n','; ') else app.offline_review_display(printed->'value') end||')'; end if;
    end if;
    if a->'unresolvedFields' ? field and not corrected and printed->>'text' is not null then provenance:=provenance||'; unresolved printed evidence: '||replace(printed->>'text',E'\n','; '); end if;
    if corrected then provenance:=provenance||' (owner supplied)'; end if;
    if jsonb_array_length(coalesce(printed->'candidates','[]'))>1 then
      provenance:=provenance||'; conflicting printed values: '||(select string_agg(x,', ') from jsonb_array_elements_text(printed->'candidates') x);
    end if;
    if field='currency' and (printed->'value' is null or printed->'value'='null'::jsonb) and printed->>'text' is not null then provenance:=provenance||'; printed evidence: '||replace(printed->>'text',E'\n','; '); end if;
    rendered:=rendered||E'\n'||(labels->>field)||': '||app.offline_review_display(value)||provenance||'.';
  end loop;
  if a->'paymentEvidence' is not null then rendered:=rendered||E'\nPrinted payment evidence: '||coalesce(nullif(a->'paymentEvidence'->>'text',''),a->'paymentEvidence'->>'status')||'. No payment is recorded.'; end if;
  rendered:=rendered||E'\nAssumptions: '||coalesce((select string_agg(x,'; ') from jsonb_array_elements_text(a->'assumptions') x),'none')||'.';
  if missing ? 'direction' then rendered:=rendered||E'\nTell me explicitly that your business issued this invoice, for example "We issued this invoice".'; end if;
  if missing ? 'lineItems' then rendered:=rendered||E'\nSome printed line items could not be read. Send a clearer photo or corrected invoice.'; end if;
  select string_agg(coalesce(labels->>x,x),', ') into details from jsonb_array_elements_text(missing) x where x not in ('direction','lineItems');
  if details is not null then rendered:=rendered||E'\nSend the missing or ambiguous '||details||' using a correction, for example "set invoice date to 2026-10-20".'; end if;
  if issues<>'[]'::jsonb then
    select string_agg(coalesce(explanations->>x,lower(replace(x,'_',' '))),'; ') into details from jsonb_array_elements_text(issues) x;
    rendered:=rendered||E'\nCheck the original: '||details||'. Send a corrected invoice or clearer photo.';
  end if;
  rendered:=rendered||E'\n'||case when missing='[]'::jsonb and issues='[]'::jsonb then 'Confirm accepts exactly all the values shown above. Reply yes to confirm, or cancel.'
    else 'Confirmation is unavailable until the missing or ambiguous details are resolved. Reply cancel to discard.' end||E'\nNothing was saved.';
  -- JavaScript limits UTF-16 code units; supplementary characters use two.
  return length(rendered)+(select count(*)::integer from regexp_split_to_table(rendered,'') c where ascii(c)>65535);
end $$;
revoke all on function app.offline_review_display(jsonb),app.offline_review_render_length(jsonb,jsonb,jsonb) from public,anon,authenticated,service_role;

create function app.offline_review_gates(a jsonb) returns jsonb language plpgsql set search_path='' as $$
declare
  i jsonb:=a->'invoice';
  missing jsonb:='[]'; issues jsonb:='[]';
  field text; key text; code text; value text;
  total numeric; subtotal numeric; tax numeric; outstanding numeric;
begin
  foreach field in array array['invoiceNumber','customerName','invoiceDate','total','currency','direction'] loop
    key:=case when field='customerName' then 'clientName' else field end;
    value:=i->>key;
    if nullif(value,'') is null or (field='currency' and value not in ('INR','USD','EUR','GBP','AED','SGD','AUD','CAD','CHF'))
      or (field='direction' and value<>'receivable') or (field='total' and value::numeric<=0) then
      missing:=missing||jsonb_build_array(field);
    end if;
  end loop;
  for field in select jsonb_array_elements_text(coalesce(a->'conflictingFields','[]')||coalesce(a->'unresolvedFields','[]')) loop
    if not (a->'ownerProvidedFacts' ? field) and not (missing ? field) then missing:=missing||jsonb_build_array(field); end if;
  end loop;
  if length(i->>'notes')>2000 then issues:=issues||'"NOTES_TOO_LONG"'::jsonb; end if;
  if a->'paymentEvidence'->>'status' is not null and a->'paymentEvidence'->>'status'<>'unpaid' then issues:=issues||'"PAYMENT_RECORD_REQUIRES_REVIEW"'::jsonb; end if;
  if i->>'subtotal' is not null and jsonb_array_length(coalesce(i->'lineItems','[]'))>0
    and not exists(select 1 from jsonb_array_elements(i->'lineItems') x where x->>'amount' is null)
    and abs((select round(sum((x->>'amount')::numeric)*100) from jsonb_array_elements(i->'lineItems') x)-round((i->>'subtotal')::numeric*100))>1 then
    issues:=issues||'"LINE_ITEMS_DO_NOT_MATCH_SUBTOTAL"'::jsonb;
  end if;
  -- Mirror the candidate validator's first structural/monetary error. Immutable
  -- line items/contact fields were validated at intake and cannot be corrected.
  if nullif(trim(i->>'invoiceNumber'),'') is null or length(i->>'invoiceNumber')>100 then field:='invoiceNumber';
  elsif i->>'invoiceNumber' like 'CETLD-TEST-%' then code:='TEST_INVOICE_CREATION_REQUIRED';
  elsif nullif(trim(i->>'clientName'),'') is null or length(i->>'clientName')>255 then field:='customerName';
  elsif app.offline_review_date(i->>'invoiceDate') is not true then field:='invoiceDate';
  elsif nullif(i->>'dueDate','') is not null and (app.offline_review_date(i->>'dueDate') is not true or i->>'dueDate'<i->>'invoiceDate') then field:='dueDate';
  elsif coalesce(i->>'currency','') not in ('INR','USD','EUR','GBP','AED','SGD','AUD','CAD','CHF') then field:='currency';
  else
    field:=null;
    foreach key in array array['total','subtotal','tax','outstanding'] loop
      value:=i->>key;
      if key='total' and nullif(value,'') is null then field:='total';exit; end if;
      if nullif(value,'') is null then continue; end if;
      if value !~ '^[0-9]+([.][0-9]+)?$' then code:='INVALID_INVOICE_AMOUNT';exit;
      elsif value ~ '[.][0-9]{3,}$' then code:='AMOUNT_PRECISION_UNSUPPORTED';exit;
      elsif round(value::numeric*100)>9007199254740991 then code:='INVALID_INVOICE_AMOUNT';exit;
      elsif key='total' and value::numeric=0 then field:='total';exit; end if;
    end loop;
    if code is null and field is null then
      total:=(i->>'total')::numeric;subtotal:=(i->>'subtotal')::numeric;tax:=(i->>'tax')::numeric;outstanding:=(i->>'outstanding')::numeric;
      if outstanding>total then code:='INVALID_OUTSTANDING_AMOUNT';
      elsif subtotal>total then code:='INVALID_SUBTOTAL';
      elsif tax>total then code:='INVALID_TAX';
      elsif subtotal is not null and tax is not null and abs(round(total*100)-round(subtotal*100)-round(tax*100))>100 then code:='INVOICE_TOTAL_DOES_NOT_MATCH_SUBTOTAL_AND_TAX';
      elsif i->>'clientEmail' is not null and i->>'clientEmail'<>'' and (i->>'clientEmail' !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' or length(i->>'clientEmail')>320) then code:='INVALID_CLIENT_EMAIL';
      elsif length(i->>'clientPhone')>40 or length(i->>'clientPhoneRaw')>80 then code:='INVALID_CLIENT_PHONE';
      elsif exists(select 1 from jsonb_array_elements(coalesce(i->'lineItems','[]')) x
        where jsonb_typeof(x)<>'object' or x-array['description','quantity','unitPrice','amount','confidence']<>'{}'::jsonb
          or nullif(trim(x->>'description'),'') is null or length(x->>'description')>500
          or exists(select 1 from jsonb_each(x) f where f.key in ('quantity','unitPrice','amount','confidence') and f.value<>'null'::jsonb
            and (jsonb_typeof(f.value)<>'number' or (f.value#>>'{}')::numeric<0
              or f.key='confidence' and (f.value#>>'{}')::numeric>1
              or f.key in ('unitPrice','amount') and (round((f.value#>>'{}')::numeric*100)>9007199254740991
                or abs((f.value#>>'{}')::numeric*100-round((f.value#>>'{}')::numeric*100))>0.0000001))))
        or jsonb_array_length(coalesce(i->'lineItems','[]'))>100 then code:='INVALID_INVOICE_LINE_ITEMS';
      elsif coalesce((i->>'alreadyPaid')::boolean,false) and outstanding<>0 then code:='PAID_INVOICE_HAS_OUTSTANDING_BALANCE';
      elsif not coalesce((i->>'alreadyPaid')::boolean,false) and outstanding<>total then code:='PARTIAL_BALANCE_REQUIRES_PAYMENT_RECORD'; end if;
    end if;
  end if;
  if field is not null and not (missing ? field) then missing:=missing||jsonb_build_array(field); end if;
  if code is not null then issues:=issues||jsonb_build_array(code); end if;
  -- Derive the complete rendered size from evidence and verified candidates.
  if app.offline_review_render_length(a,missing,issues)>3790 then issues:=issues||'"OFFLINE_REVIEW_TOO_LONG"'::jsonb; end if;
  return jsonb_build_object('missingFields',missing,'validationIssues',issues,'stage',case when missing='[]'::jsonb and issues='[]'::jsonb then 'proposal' else 'incomplete' end);
end $$;
revoke all on function app.offline_review_date(text),app.offline_review_gates(jsonb) from public,anon,authenticated,service_role;

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
  v_match text[];
  v_supported boolean;
  v_gates jsonb;
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
  v_message:=trim(v_message);
  if coalesce(v_row.action->'appliedCorrectionSources','[]'::jsonb) @> jsonb_build_array(p_source_message_id)
    or exists(select 1 from jsonb_each(coalesce(v_row.action->'ownerProvidedFacts','{}'::jsonb)) f
      where f.value->>'sourceMessageId'=p_source_message_id) then
    raise exception 'offline correction source already applied';
  end if;

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
      v_supported := false;
      if v_field='total' then
        v_match:=regexp_match(v_message,'^(?:change|make|set|update|edit|modify|fix) (?:the )?(?:total|amount|amt|price|value) (?:to )?([0-9][0-9,]*(?:[.][0-9]{1,2})?)(?: [A-Za-z]{3})?[.!]?$','i');
        v_supported:=v_match is not null and replace(v_match[1],',','')::numeric=(v_fact->>'value')::numeric;
      elsif v_field in ('invoiceDate','dueDate') then
        v_match:=regexp_match(v_message,case when v_field='dueDate' then '^(?:change|make|set) (?:the )?due date (?:to )?([0-9]{4}-[0-9]{2}-[0-9]{2})$'
          else '^(?:change|make|set) (?:the )?(?:invoice|issue) date (?:to )?([0-9]{4}-[0-9]{2}-[0-9]{2})$' end,'i');
        v_supported:=v_match is not null and v_match[1]=v_fact->>'value';
      elsif v_field='customerName' then
        v_match:=regexp_match(v_message,'^(?:change|set) (?:the )?customer (?:to )?(.+)$','i');
        v_supported:=v_match is not null and trim(v_match[1])=v_fact->>'value';
      elsif v_field='notes' then
        v_match:=regexp_match(v_message,'^(?:change|set) (?:the )?notes? (?:to )?(.+)$','i');
        v_supported:=v_match is not null and trim(v_match[1])=v_fact->>'value';
      elsif v_field='invoiceNumber' then
        v_match:=regexp_match(v_message,'^(?:set|change) invoice number (?:to )?([A-Za-z0-9][A-Za-z0-9/_.-]{0,99})$','i');
        v_supported:=v_match is not null and v_match[1]=v_fact->>'value';
      elsif v_field='currency' then
        v_match:=regexp_match(trim(v_message),'^(?:currency (?:should be|to|is) )?([A-Za-z]{3})[.!]?$','i');
        if v_match is null then v_match:=regexp_match(v_message,'^(?:change|make|set|update|edit|modify|fix) (?:the )?(?:total|amount|amt|price|value) (?:to )?[0-9][0-9,]*(?:[.][0-9]{1,2})? ([A-Za-z]{3})[.!]?$','i'); end if;
        v_supported:=v_match is not null and upper(v_match[1])=v_fact->>'value';
      elsif v_field='direction' then v_supported:=true;
      end if;
      if v_supported is not true then raise exception 'offline fact value is unsupported by owner source'; end if;
      if v_field='direction' and (
        (v_fact->>'value'='receivable' and v_message !~* '^[[:space:]]*((we|i|our business|my business)[[:space:]]+(have[[:space:]]+)?(issued|sent|created|made)[[:space:]]+(it|((this|that|the)[[:space:]]+)?invoice)|issued by (us|me|our business))[.!]?[[:space:]]*((please )?(log|save|record) (it|this invoice)[.!]?)?[[:space:]]*$')
        or (v_fact->>'value'='uncertain' and v_row.action->'invoice'->>'direction' is distinct from 'receivable')
        or coalesce(v_fact->>'value','') not in ('receivable','uncertain')) then
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
  v_gates:=app.offline_review_gates(p_action);
  if p_action->>'stage' is distinct from v_gates->>'stage'
    or not ((p_action->'missingFields') @> (v_gates->'missingFields') and (v_gates->'missingFields') @> (p_action->'missingFields'))
    or not ((p_action->'validationIssues') @> (v_gates->'validationIssues') and (v_gates->'validationIssues') @> (p_action->'validationIssues')) then
    raise exception 'offline correction gates do not match verified evidence';
  end if;
  return query update public.whatsapp_pending_actions p set action=p_action || jsonb_build_object('appliedCorrectionSources',coalesce(v_row.action->'appliedCorrectionSources','[]'::jsonb)||jsonb_build_array(p_source_message_id)),version=p.version+1
    where p.id=v_row.id and p.version=v_row.version returning p.id,p.version,p.generation,p.action,p.created_at,p.expires_at;
end
$function$;
revoke all on function public.whatsapp_correct_offline_invoice_review(bigint,bigint,uuid,uuid,text,jsonb,text) from public,anon,authenticated;
grant execute on function public.whatsapp_correct_offline_invoice_review(bigint,bigint,uuid,uuid,text,jsonb,text) to service_role;
commit;

