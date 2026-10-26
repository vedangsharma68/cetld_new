begin;
-- Refuse a drifted deployed body rather than overwrite unrelated hotfixes.
do $drift$
begin
 if (select md5(prosrc) from pg_proc where oid='public.whatsapp_owner_save_phone(uuid,uuid,text,uuid,uuid,text,text,text)'::regprocedure) is distinct from '7627fff07f418024d07dc0722b5cccc2'
 or (select md5(prosrc) from pg_proc where oid='public.whatsapp_owner_record_consent(uuid,uuid,text,uuid,text,text,text)'::regprocedure) is distinct from 'e5364b8b1a42d345d89c9a5e22c7f031'
 then raise exception 'quoted consent predecessor body drifted; review before applying'; end if;
end $drift$;
-- Authenticated ingress persists only the provider's bounded reply ID. Duplicate
-- delivery already uses insert-ignore, so a retry cannot replace this evidence.
alter table public.whatsapp_inbound_events add column reply_context_id text
  check (reply_context_id is null or octet_length(reply_context_id) between 1 and 256);
alter table public.whatsapp_messages add column owner_receipt_ref jsonb
  check (owner_receipt_ref is null or (jsonb_typeof(owner_receipt_ref)='object'
    and audience='owner' and direction='outbound' and kind='normal'
    and owner_receipt_ref->>'kind'='customer_phone_saved'));

-- Deliberately bounded mixed grammar: a consent clause, then an immediate
-- reminder request, optionally an owner-reported relative due date. Keep the
-- original text in the inbox and write receipt; never synthesize an agreement.
create function app.owner_consent_parts(p_text text) returns jsonb
language plpgsql immutable set search_path='' as $$
declare parts text[];
begin
 parts:=regexp_match(btrim(p_text),
  '^(.+?)[,.][[:space:]]*send[[:space:]]+(them|him|her|the customer)[[:space:]]+(a[[:space:]]+)?reminder[[:space:]]*(\([[:space:]]*(the[[:space:]]+)?invoice[[:space:]]+is[[:space:]]+due[[:space:]]+(tomorrow|tommrow)[[:space:]]*\))?[.!]?$', 'i');
 return jsonb_build_object('clause',case when parts is null then p_text else parts[1] end,
  'reminderRequested',parts is not null,'relativeDue',parts[6] is not null);
end $$;
revoke all on function app.owner_consent_parts(text) from public,anon,authenticated,service_role;

-- No model- or caller-supplied customer ID participates in this resolution.
-- Only an accepted bot phone-save receipt with an explicit stable binding can
-- resolve a quote. Old receipts without binding require one clarification.
create function public.whatsapp_owner_resolve_quote(
 p_workspace_id uuid,p_owner_id uuid,p_phone text,p_message_id text,p_user_message text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare e public.whatsapp_inbound_events%rowtype; r public.whatsapp_messages%rowtype;
 c public.customers%rowtype; i public.invoices%rowtype; ref jsonb; parts jsonb; source_time timestamptz;
begin
 if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.role(),'')<>'service_role'
 or (select count(*) from public.whatsapp_resolve_verified_owner(p_phone) b
   where b.workspace_id=p_workspace_id and b.owner_id=p_owner_id)<>1
 then return jsonb_build_object('ok',false,'code','DENIED'); end if;
 select * into e from public.whatsapp_inbound_events where provider_message_id=p_message_id
   and sender_phone=p_phone and message_type='text' and message_text=p_user_message
   and status in ('processing','done');
 if not found then return jsonb_build_object('ok',false,'code','DENIED'); end if;
 if e.reply_context_id is null then return jsonb_build_object('ok',false,'code','MISSING_QUOTE_BINDING'); end if;
 source_time:=coalesce(e.provider_timestamp,e.received_at);
 if (select count(*) from public.whatsapp_messages where workspace_id=p_workspace_id
   and phone=p_phone and provider_message_id=e.reply_context_id and audience='owner'
   and direction='outbound' and kind='normal' and status in ('accepted','sent','delivered','read'))<>1
 then return jsonb_build_object('ok',false,'code','MISSING_QUOTE_BINDING'); end if;
 select * into r from public.whatsapp_messages where workspace_id=p_workspace_id
   and phone=p_phone and provider_message_id=e.reply_context_id and audience='owner'
   and direction='outbound' and kind='normal' and status in ('accepted','sent','delivered','read');
 ref:=r.owner_receipt_ref;
 if r.id is null or ref is null or ref->>'kind' is distinct from 'customer_phone_saved'
   or ref->>'ownerId' is distinct from p_owner_id::text
   or r.customer_id is not null or r.invoice_id is not null
   or r.idempotency_key is distinct from 'reply:'||(ref->>'sourceMessageId')
   or r.created_at>source_time+interval '1 second' or r.created_at<source_time-interval '24 hours'
   or source_time<clock_timestamp()-interval '24 hours' or source_time>clock_timestamp()+interval '5 minutes'
   or not exists(select 1 from public.whatsapp_inbound_events s
     where s.provider_message_id=ref->>'sourceMessageId' and s.sender_phone=p_phone)
 then return jsonb_build_object('ok',false,'code','MISSING_QUOTE_BINDING'); end if;
 select * into c from public.customers where workspace_id=p_workspace_id and id=(ref->>'customerId')::uuid;
 if not found or c.phone is distinct from ref->>'phone'
   or c.updated_at is distinct from (ref->>'customerUpdatedAt')::timestamptz
   or coalesce(c.metadata->>'whatsapp_owner','false')='true'
 then return jsonb_build_object('ok',false,'code','STALE_QUOTE_BINDING'); end if;
 if ref->>'invoiceId' is not null then
   select * into i from public.invoices where workspace_id=p_workspace_id and id=(ref->>'invoiceId')::uuid
     and customer_id=c.id and deleted_at is null;
   if not found or i.updated_at is distinct from (ref->>'invoiceUpdatedAt')::timestamptz
   then return jsonb_build_object('ok',false,'code','STALE_QUOTE_BINDING'); end if;
 end if;
 parts:=app.owner_consent_parts(p_user_message);
 return jsonb_build_object('ok',true,'customerId',c.id,'customerName',c.name,'phone',c.phone,
   'invoiceId',i.id,'invoiceNumber',i.invoice_number,'dueDate',i.due_date,
   'messageTimestamp',e.provider_timestamp,'relativeDue',parts->'relativeDue','reminderRequested',parts->'reminderRequested');
exception when invalid_text_representation or datetime_field_overflow then
 return jsonb_build_object('ok',false,'code','MISSING_QUOTE_BINDING');
end $$;
revoke all on function public.whatsapp_owner_resolve_quote(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.whatsapp_owner_resolve_quote(uuid,uuid,text,text,text) to service_role;

-- Emit the binding inside the existing verified save, after both contact and
-- invoice updates. No backfill or alteration of existing invoices/receipts.
do $$
declare definition text; old_return text;
begin
 select pg_get_functiondef('public.whatsapp_owner_save_phone(uuid,uuid,text,uuid,uuid,text,text,text)'::regprocedure) into definition;
 old_return:=$old$return jsonb_build_object('ok',true,'completed',true,'customerId',c.id,'customerName',c.name,'phone',c.phone);$old$;
 if position(old_return in definition)=0 then raise exception 'phone save result shape changed'; end if;
 definition:=replace(definition,old_return,$new$
 if p_invoice_id is not null then select * into i from public.invoices where workspace_id=p_workspace_id and id=p_invoice_id; end if;
 return jsonb_build_object('ok',true,'completed',true,'customerId',c.id,'customerName',c.name,'phone',c.phone,
   'ownerReceiptRef',jsonb_build_object('kind','customer_phone_saved','ownerId',p_owner_id,
     'customerId',c.id,'customerUpdatedAt',c.updated_at,'phone',c.phone,'invoiceId',i.id,
     'invoiceUpdatedAt',i.updated_at,'sourceMessageId',p_message_id));$new$);
 execute definition;
end $$;

-- Consent storage remains UNIQUE(workspace_id,phone). Separate grants for
-- customers sharing a phone need the coordinated model change in the design.
-- This patch adds source-bound evidence only; STOP locks and collision guards
-- remain, and consent never approves or dispatches any reminder.
create or replace function public.whatsapp_owner_record_consent(
 p_workspace_id uuid,p_owner_id uuid,p_phone text,p_customer_id uuid,
 p_contact_phone text,p_message_id text,p_user_message text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
 c public.customers%rowtype; existing public.whatsapp_consents%rowtype;
 receipt public.whatsapp_direct_write_receipts%rowtype;
 request jsonb; result jsonb; lock_phone text; consent_id uuid;
 quoted jsonb; parts jsonb; approved boolean:=false; evidence_match text[]; subject text; invoice_subject text;
 statement text:=lower(replace(coalesce(p_user_message,''),'’',''''));
begin
 if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.role(),'')<>'service_role'
 then return jsonb_build_object('ok',false,'code','DENIED'); end if;
 -- Use the same phone-wide locks as STOP. A stable order also handles two
 -- verified owners recording consent for one another without a lock cycle.
 for lock_phone in select distinct v from unnest(array[p_phone,p_contact_phone]) v where v is not null order by v loop
   perform pg_advisory_xact_lock(hashtextextended(lock_phone,0));
 end loop;
 if (select count(*) from public.whatsapp_resolve_verified_owner(p_phone) b
     where b.workspace_id=p_workspace_id and b.owner_id=p_owner_id)<>1
 or not exists(select 1 from public.whatsapp_inbound_events e where e.provider_message_id=p_message_id
   and e.sender_phone=p_phone and e.message_type='text' and e.message_text=p_user_message)
 then return jsonb_build_object('ok',false,'code','DENIED'); end if;
 parts:=app.owner_consent_parts(p_user_message);
 statement:=lower(replace(coalesce(parts->>'clause',''),'’',''''));
 if exists(select 1 from public.whatsapp_inbound_events e where e.provider_message_id=p_message_id and e.reply_context_id is not null) then
   quoted:=public.whatsapp_owner_resolve_quote(p_workspace_id,p_owner_id,p_phone,p_message_id,p_user_message);
   if quoted->>'ok' is distinct from 'true' then return quoted; end if;
   if quoted->>'customerId' is distinct from p_customer_id::text or quoted->>'phone' is distinct from p_contact_phone
   then return jsonb_build_object('ok',false,'code','STALE'); end if;
   if quoted->>'invoiceId' is not null then
     perform 1 from public.invoices where workspace_id=p_workspace_id and id=(quoted->>'invoiceId')::uuid for share;
   end if;
   approved:=btrim(statement) ~ '^(they approve|he approves|she approves|the customer approves)$'
     and parts->>'reminderRequested'='true';
 end if;
 select * into c from public.customers where workspace_id=p_workspace_id and id=p_customer_id for update;
 if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;
 if quoted is not null then
   quoted:=public.whatsapp_owner_resolve_quote(p_workspace_id,p_owner_id,p_phone,p_message_id,p_user_message);
   if quoted->>'ok' is distinct from 'true' then return quoted; end if;
 end if;
 -- Match the entire affirmative clause. Exact subjects prevent external,
 -- historical or hypothetical prose surrounding a valid-looking phrase from
 -- becoming consent, including a different customer naming this same phone.
 if not approved then
   evidence_match:=regexp_match(btrim(statement),
     '^(.+?)[[:space:]]+((has|have)[[:space:]]+)?(agreed|consented)[[:space:]]+(to|for)[[:space:]]+((receive|get)[[:space:]]+)?(whatsapp[[:space:]]+)?(invoice[[:space:]]+)?reminders?([[:space:]]+on[[:space:]]+(\+?[0-9][0-9 -]{6,}[0-9]|(this|their|the)[[:space:]]+number))?[.!]?$');
   if evidence_match is null then return jsonb_build_object('ok',false,'code','INVALID'); end if;
   subject:=btrim(regexp_replace(evidence_match[1],
     '^(record|save)[[:space:]]+((the|reminder)[[:space:]]+)?consent([[:space:]]+for|[[:space:]]*:)?[[:space:]]*',''));
   invoice_subject:=(regexp_match(subject,'^(.+?):[[:space:]]*(they|he|she|the customer)$'))[1];
   if btrim(regexp_replace(subject,'[[:space:]]+',' ','g')) is distinct from btrim(regexp_replace(lower(replace(c.name,'’','''')),'[[:space:]]+',' ','g'))
     and subject !~ '^(yes,[[:space:]]*)?(they|he|she|the customer|this customer)$'
     and not exists(select 1 from public.invoices i where i.workspace_id=p_workspace_id and i.customer_id=c.id and i.deleted_at is null
       and lower(i.invoice_number) in (subject,invoice_subject))
   then return jsonb_build_object('ok',false,'code','INVALID'); end if;
 end if;
 if c.phone is distinct from p_contact_phone then return jsonb_build_object('ok',false,'code','STALE'); end if;
 if c.phone is null or c.phone !~ '^\+[1-9][0-9]{7,14}$'
 then return jsonb_build_object('ok',false,'code','INVALID'); end if;
 if c.phone=p_phone or coalesce(c.metadata->>'whatsapp_owner','false')='true'
 or exists(select 1 from public.workspace_settings s where s.workspace_id=p_workspace_id and s.whatsapp_owner_phone=c.phone)
 then return jsonb_build_object('ok',false,'code','OWNER_PHONE'); end if;
 if exists(select 1 from public.whatsapp_global_suppressions where phone=c.phone)
 then return jsonb_build_object('ok',false,'code','globally_suppressed'); end if;
 if exists(select 1 from public.whatsapp_suppressions where workspace_id=p_workspace_id and phone=c.phone)
 then return jsonb_build_object('ok',false,'code','suppressed'); end if;
 select * into existing from public.whatsapp_consents where workspace_id=p_workspace_id and phone=c.phone for update;
 if found and existing.customer_id is distinct from c.id
 then return jsonb_build_object('ok',false,'code','CONFLICT','customerName',c.name,'phone',c.phone,
   'consentCustomerName',(select name from public.customers where workspace_id=p_workspace_id and id=existing.customer_id)); end if;
 if existing.revoked_at is not null then return jsonb_build_object('ok',false,'code','revoked'); end if;
 if exists(select 1 from regexp_matches(statement,'\+[0-9][0-9 -]*[0-9]|\m[6-9][0-9]{9}\M','g') m
   where regexp_replace(m[1],'[^0-9]','','g') not in
     (regexp_replace(c.phone,'[^0-9]','','g'),case when c.phone ~ '^\+91' then substring(c.phone from 4) else '' end))
 then return jsonb_build_object('ok',false,'code','STALE'); end if;
 -- Current owner evidence must be affirmative and identify this exact customer
 -- or phone. A model-supplied target, a question or a bare YES is not consent.
 if p_user_message ~ '[?;\n\"“”]' or p_user_message ~ $quote$(^|[[:space:]])'|'([[:space:]]|$)$quote$ or p_user_message ~* '\m(yesterday|previously|historically|formerly|said|says|told|quoted|used|last|ago|back|unless)[[:space:]]' or statement ~ '[?;\n]' or btrim(statement) ~ '^(has|have|had|did|does|do|is|are|was|were|why|how|what|which|who|where)\M'
 or statement ~ '\m(not|never|no|without|refused|declined|maybe|tomorrow|later|stop|stopped|withdraw|withdrawn|revoke|revoked|if|when|once|whether|can|could|would|will|should)\M'
 or statement ~ '\m(hasn''t|haven''t|didn''t|doesn''t|don''t|isn''t|wasn''t|won''t|can''t)\M'
 or not approved and statement !~ '\m(agreed|consented)[[:space:]]+(to|for)[[:space:]]+((receive|get)[[:space:]]+)?(whatsapp[[:space:]]+)?(invoice[[:space:]]+)?reminders?\M'
 or not (approved or (quoted->>'ok' is not distinct from 'true' and btrim(statement) ~ '^(they|he|she|the customer)[[:space:]]+((has|have)[[:space:]]+)?(agreed|consented)[[:space:]]+(to|for)[[:space:]]+((receive|get)[[:space:]]+)?(whatsapp[[:space:]]+)?(invoice[[:space:]]+)?reminders?[.!]?$') or position(' '||lower(regexp_replace(c.name,'[^[:alnum:] ]',' ','g'))||' '
     in ' '||regexp_replace(statement,'[^[:alnum:] ]',' ','g')||' ')>0
   or exists(select 1 from public.invoices i where i.workspace_id=p_workspace_id and i.customer_id=c.id and i.deleted_at is null
     and position(' '||lower(regexp_replace(i.invoice_number,'[^[:alnum:] ]',' ','g'))||' '
       in ' '||regexp_replace(statement,'[^[:alnum:] ]',' ','g')||' ')>0)
   or exists(select 1 from regexp_matches(statement,'\+?[0-9][0-9 -]{6,}[0-9]','g') m
     where regexp_replace(m[1],'[^0-9]','','g') in
       (regexp_replace(c.phone,'[^0-9]','','g'),case when c.phone ~ '^\+91' then substring(c.phone from 4) end)))
 then return jsonb_build_object('ok',false,'code','INVALID'); end if;
 request:=jsonb_build_object('operation','consent.record','customerId',c.id,'phone',c.phone,'message',p_user_message);
 -- Serialize receipt reuse even if an SDK retry supplies a different target.
 perform pg_advisory_xact_lock(hashtextextended(p_message_id,7));
 select * into receipt from public.whatsapp_direct_write_receipts where provider_message_id=p_message_id;
 if found then
   if receipt.workspace_id<>p_workspace_id or receipt.owner_id<>p_owner_id or receipt.phone<>p_phone or receipt.request<>request
   then return jsonb_build_object('ok',false,'code','REPLAY_MISMATCH'); end if;
   return receipt.result||jsonb_build_object('replayed',true);
 end if;
 insert into public.whatsapp_consents(workspace_id,customer_id,phone,categories,consent_text_version,source,consented_by)
 values(p_workspace_id,c.id,c.phone,array['invoice_updates'],'owner_confirmed_v1','verbal',p_owner_id)
 on conflict(workspace_id,phone) do update set
   categories=case when 'invoice_updates'=any(whatsapp_consents.categories) then whatsapp_consents.categories
     else array_append(whatsapp_consents.categories,'invoice_updates') end,
   consent_text_version='owner_confirmed_v1',source='verbal',consented_by=p_owner_id,consented_at=now()
 where whatsapp_consents.customer_id=c.id and whatsapp_consents.revoked_at is null
 returning id into consent_id;
 if consent_id is null then return jsonb_build_object('ok',false,'code','CONFLICT'); end if;
 result:=jsonb_build_object('ok',true,'completed',true,'action','consent.recorded','customerName',c.name,'phone',c.phone);
 insert into public.whatsapp_direct_write_receipts(provider_message_id,workspace_id,owner_id,phone,idempotency_key,request,result)
 values(p_message_id,p_workspace_id,p_owner_id,p_phone,'consent_'||md5(p_message_id),request,result);
 return result;
end $$;
revoke all on function public.whatsapp_owner_record_consent(uuid,uuid,text,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.whatsapp_owner_record_consent(uuid,uuid,text,uuid,text,text,text) to service_role;

commit;
