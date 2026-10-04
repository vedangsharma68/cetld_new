-- LOCAL REVIEW PROPOSAL. No existing business row changes on installation.
begin;
create table public.invoice_correction_audits (
  id uuid primary key default gen_random_uuid(), workspace_id uuid not null,
  owner_id uuid not null, invoice_id uuid not null, source_kind text not null check(source_kind in ('whatsapp','dashboard')), source_event_id text not null,
  unique(workspace_id,owner_id,source_kind,source_event_id),
  values jsonb not null, before_snapshot jsonb not null, after_snapshot jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_id,owner_id) references public.workspaces(id,owner_id),
  foreign key(workspace_id,invoice_id) references public.invoices(workspace_id,id)
);
alter table public.invoice_correction_audits enable row level security;
alter table public.invoice_correction_audits force row level security;
revoke all on public.invoice_correction_audits from public,anon,authenticated,service_role;
grant select on public.invoice_correction_audits to service_role;
create function app.guard_invoice_correction_audit() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'invoice correction history is immutable' using errcode='42501'; end; $$;
revoke all on function app.guard_invoice_correction_audit() from public,anon,authenticated,service_role;
create trigger immutable_invoice_correction before update or delete on public.invoice_correction_audits
for each row execute function app.guard_invoice_correction_audit();

-- Validation is shared for incoming item replacements and existing saved
-- itemization, so a scalar-only edit cannot quietly break the document math.
create function app.invoice_correction_line_sum(items jsonb) returns numeric
language plpgsql set search_path='' as $$
declare x jsonb;total numeric:=0;
begin
 if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items)>100 then raise exception 'invalid itemization' using errcode='22023';end if;
 for x in select value from jsonb_array_elements(items) loop
  if jsonb_typeof(x)<>'object' or not x ?& array['description','amount']
   or exists(select 1 from jsonb_object_keys(x) a(key) where key not in ('description','quantity','unitPrice','amount','confidence'))
   or jsonb_typeof(x->'description')<>'string' or length(btrim(x->>'description')) not between 1 and 500 or x->>'description' ~ '[[:cntrl:]]'
   or jsonb_typeof(x->'amount')<>'number'
   or x?'quantity' and jsonb_typeof(x->'quantity') not in ('number','null')
   or x?'unitPrice' and jsonb_typeof(x->'unitPrice') not in ('number','null')
   or x?'confidence' and (jsonb_typeof(x->'confidence') not in ('number','null') or (x->>'confidence')::numeric not between 0 and 1) then raise exception 'invalid itemization' using errcode='22023';end if;
  if (x->>'quantity')::numeric<=0 or (x->>'quantity')::numeric>1000000 or scale((x->>'quantity')::numeric)>4
    or (x->>'unitPrice')::numeric<0 or (x->>'unitPrice')::numeric>=10000000000000000 or scale((x->>'unitPrice')::numeric)>2
    or (x->>'amount')::numeric<0 or (x->>'amount')::numeric>=10000000000000000 or scale((x->>'amount')::numeric)>2
    or round((x->>'quantity')::numeric*(x->>'unitPrice')::numeric,2)<>(x->>'amount')::numeric then raise exception 'invalid itemization' using errcode='22023';end if;
  total:=total+(x->>'amount')::numeric;
 end loop;
 return total;
end; $$;
revoke all on function app.invoice_correction_line_sum(jsonb) from public,anon,authenticated,service_role;

create function app.apply_owner_invoice_correction(
 p_workspace_id uuid,p_owner_id uuid,p_invoice_id uuid,p_expected_updated_at timestamptz,p_values jsonb,p_source_kind text,p_source_event_id text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.invoices%rowtype;before_row jsonb;result jsonb;
 m jsonb;k text;x jsonb;v numeric;item_sum numeric:=0;subtotal numeric;tax numeric;discount numeric;total numeric;
 customer uuid;contact_phone text;issue date;due date;cur text;financial boolean;correction uuid;history public.invoice_correction_audits%rowtype;label text;
begin
 if p_workspace_id is null or p_owner_id is null or p_invoice_id is null or p_expected_updated_at is null
  or p_source_kind not in ('whatsapp','dashboard') or p_source_event_id is null or length(p_source_event_id) not between 1 and 256
  or not exists(select 1 from public.workspaces w where w.id=p_workspace_id and w.owner_id=p_owner_id)
  or p_values is null or jsonb_typeof(p_values) is distinct from 'object' or p_values='{}'::jsonb or octet_length(p_values::text)>32768 then
  return jsonb_build_object('ok',false,'code','INVALID');end if;
 perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||':'||p_source_kind||':'||p_source_event_id,0));
 select * into history from public.invoice_correction_audits c where c.workspace_id=p_workspace_id and c.owner_id=p_owner_id and c.source_kind=p_source_kind and c.source_event_id=p_source_event_id;
 if found then
  if history.invoice_id is distinct from p_invoice_id or history.values is distinct from p_values or (history.before_snapshot->>'updated_at')::timestamptz is distinct from p_expected_updated_at then return jsonb_build_object('ok',false,'code','REPLAY_MISMATCH');end if;
  return jsonb_build_object('ok',true,'completed',true,'replayed',true,'action','invoice.updated','entityType','invoice','entityId',history.invoice_id,'updatedAt',history.after_snapshot->'updated_at','record',history.after_snapshot,'correctionAuditId',history.id);
 end if;
 select * into i from public.invoices x where x.workspace_id=p_workspace_id and x.id=p_invoice_id for update;
 if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND');end if;
 if i.updated_at is distinct from p_expected_updated_at then return jsonb_build_object('ok',false,'code','STALE');end if;
 if i.deleted_at is not null or i.status::text in ('void','cancelled') then return jsonb_build_object('ok',false,'code','TERMINAL');end if;
 -- A sender may already be using the old facts; unknown outcomes must be
 -- reconciled before an owner changes the recipient or reminder content.
 perform 1 from public.cetld_core_automation_delivery_claims c where c.workspace_id=p_workspace_id and c.invoice_id=i.id and c.status in ('sending','quarantined') for update;
 if found then return jsonb_build_object('ok',false,'code','DELIVERY_IN_FLIGHT');end if;
 if exists(select 1 from jsonb_object_keys(p_values) x(key) where key not in
  ('invoice_number','custom_fields','customer_id','line_items','subtotal','tax','discount','total_amount','currency','issue_date','due_date','notes','invoice_direction','seller_name','buyer_name','payment_information')) then
  return jsonb_build_object('ok',false,'code','INVALID_FIELDS');end if;
 financial:=p_values ?| array['invoice_number','customer_id','line_items','subtotal','tax','discount','total_amount','currency','invoice_direction'];
 if financial and (i.amount_paid>0 or i.status::text='paid' or exists(select 1 from public.payments p where p.workspace_id=p_workspace_id and p.invoice_id=i.id)
   or exists(select 1 from public.payment_reversals p where p.workspace_id=p_workspace_id and p.invoice_id=i.id)) then
  return jsonb_build_object('ok',false,'code','PAYMENT_GUARD');end if;
 if p_values?'custom_fields' and not app.business_custom_fields_valid(p_values->'custom_fields') then return jsonb_build_object('ok',false,'code','INVALID');end if;
 label:=i.invoice_number;
 if p_values?'invoice_number' then
  if jsonb_typeof(p_values->'invoice_number')<>'string' or length(btrim(p_values->>'invoice_number')) not between 1 and 100 then return jsonb_build_object('ok',false,'code','INVALID');end if;
  label:=btrim(p_values->>'invoice_number');
 end if;
 before_row:=to_jsonb(i);m:=i.metadata;customer:=i.customer_id;contact_phone:=i.customer_phone;issue:=i.issue_date;due:=i.due_date;cur:=i.currency;total:=i.total_amount;
 if p_values?'customer_id' then
  if jsonb_typeof(p_values->'customer_id')<>'string' then return jsonb_build_object('ok',false,'code','INVALID');end if;
  customer:=(p_values->>'customer_id')::uuid;
  select c.phone into contact_phone from public.customers c where c.workspace_id=p_workspace_id and c.id=customer for share;
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND');end if;
 end if;
 if p_values?'currency' then cur:=p_values->>'currency';if jsonb_typeof(p_values->'currency')<>'string' or not app.currency_uses_two_decimal_precision(cur) then return jsonb_build_object('ok',false,'code','INVALID');end if;end if;
 foreach k in array array['subtotal','tax','discount','total_amount'] loop
  if p_values?k then
   if jsonb_typeof(p_values->k)<>'number' then return jsonb_build_object('ok',false,'code','INVALID');end if;
   v:=(p_values->>k)::numeric;
   if v<0 or v>=10000000000000000 or scale(v)>2 then return jsonb_build_object('ok',false,'code','INVALID');end if;
   if k='total_amount' then total:=v;else m:=m||jsonb_build_object(k,v);end if;
  end if;
 end loop;
 if p_values?'line_items' then m:=m||jsonb_build_object('line_items',p_values->'line_items');end if;
 if financial and p_values ?| array['line_items','subtotal','tax','discount','total_amount'] then
  if m?'line_items' then
   if jsonb_typeof(m->'line_items')<>'array' then return jsonb_build_object('ok',false,'code','INVALID');end if;
   item_sum:=app.invoice_correction_line_sum(m->'line_items');
  end if;
  if p_values?'line_items' and not p_values?'subtotal' then m:=m||jsonb_build_object('subtotal',item_sum);end if;
  if m->>'tax' is null and m->>'tax_minor' is not null and (m->>'tax_minor')::numeric<>trunc((m->>'tax_minor')::numeric)
    or m->>'discount' is null and m->>'discount_minor' is not null and (m->>'discount_minor')::numeric<>trunc((m->>'discount_minor')::numeric) then return jsonb_build_object('ok',false,'code','INVALID_TOTAL');end if;
  tax:=coalesce((m->>'tax')::numeric,round((m->>'tax_minor')::numeric/100,2),0);
  discount:=coalesce((m->>'discount')::numeric,round((m->>'discount_minor')::numeric/100,2),0);
  subtotal:=coalesce((m->>'subtotal')::numeric,case when m?'line_items' and jsonb_array_length(m->'line_items')>0 then item_sum else total-tax+discount end);
  if subtotal<0 or tax<0 or discount<0 or subtotal>=10000000000000000 or tax>=10000000000000000 or discount>=10000000000000000 or scale(subtotal)>2 or scale(tax)>2 or scale(discount)>2
    or subtotal+tax-discount<>total
    or (m?'line_items' and jsonb_array_length(m->'line_items')>0 and item_sum<>subtotal) then return jsonb_build_object('ok',false,'code','INVALID_TOTAL');end if;
 end if;
 foreach k in array array['notes','seller_name','buyer_name','payment_information'] loop
  if p_values?k then
   if jsonb_typeof(p_values->k) not in ('string','null') or length(p_values->>k)>(case k when 'seller_name' then 255 when 'buyer_name' then 255 when 'payment_information' then 2000 else 4000 end) then return jsonb_build_object('ok',false,'code','INVALID');end if;
   if k in ('seller_name','buyer_name') and (p_values->>k) ~ '[[:cntrl:]]'
     or k in ('notes','payment_information') and replace(replace(replace(p_values->>k,chr(9),''),chr(10),''),chr(13),'') ~ '[[:cntrl:]]' then return jsonb_build_object('ok',false,'code','INVALID');end if;
   if k<>'notes' then m:=m||jsonb_build_object(k,p_values->k);end if;
  end if;
 end loop;
 if p_values?'invoice_direction' then
  if jsonb_typeof(p_values->'invoice_direction')<>'string' or p_values->>'invoice_direction' not in ('receivable','payable') then return jsonb_build_object('ok',false,'code','INVALID');end if;
  m:=m||jsonb_build_object('invoice_direction',p_values->'invoice_direction');end if;
 if p_values?'issue_date' then
  if jsonb_typeof(p_values->'issue_date')<>'string' or p_values->>'issue_date'!~'^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok',false,'code','INVALID');end if;
  issue:=(p_values->>'issue_date')::date;end if;
 if p_values?'due_date' then
  if jsonb_typeof(p_values->'due_date') not in ('string','null') or jsonb_typeof(p_values->'due_date')='string' and p_values->>'due_date'!~'^\d{4}-\d{2}-\d{2}$' then return jsonb_build_object('ok',false,'code','INVALID');end if;
  due:=(p_values->>'due_date')::date;end if;
 if due<issue then return jsonb_build_object('ok',false,'code','INVALID');end if;
 m:=m||jsonb_build_object('outstanding_amount',total-i.amount_paid,'followup_state','paused','next_follow_up_at',null,'approved_reminder_text',null,'approved_preferences_updated_at',null,'bookkeeping_sync_status','pending');
 update public.invoices set invoice_number=label,custom_fields=case when p_values?'custom_fields' then i.custom_fields||p_values->'custom_fields' else i.custom_fields end,customer_id=customer,customer_phone=contact_phone,issue_date=issue,due_date=due,currency=cur,total_amount=total,
  notes=case when p_values?'notes' then p_values->>'notes' else i.notes end,metadata=m,followup_state='paused',next_follow_up_at=null
  where workspace_id=p_workspace_id and id=p_invoice_id returning * into i;
 update public.invoice_lifecycle_proposals set state='stale' where workspace_id=p_workspace_id and owner_id=p_owner_id and invoice_id=i.id and state='pending';
 update public.invoice_reopening_proposals set state='stale' where workspace_id=p_workspace_id and owner_id=p_owner_id and invoice_id=i.id and state='pending';
 insert into public.invoice_correction_audits(workspace_id,owner_id,invoice_id,source_kind,source_event_id,values,before_snapshot,after_snapshot)
  values(p_workspace_id,p_owner_id,i.id,p_source_kind,p_source_event_id,p_values,before_row,to_jsonb(i)) returning id into correction;
 result:=jsonb_build_object('ok',true,'completed',true,'action','invoice.updated','entityType','invoice','entityId',i.id,'updatedAt',i.updated_at,'record',to_jsonb(i),'correctionAuditId',correction);
 return result;
exception when others then return jsonb_build_object('ok',false,'code','INVALID');
end; $$;
revoke all on function app.apply_owner_invoice_correction(uuid,uuid,uuid,timestamptz,jsonb,text,text) from public,anon,authenticated,service_role;

create function public.whatsapp_correct_owner_invoice(
 p_workspace_id uuid,p_owner_id uuid,p_phone text,p_provider_message_id text,p_user_message text,
 p_idempotency_key text,p_invoice_id uuid,p_expected_updated_at timestamptz,p_values jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare o record;e public.whatsapp_inbound_events%rowtype;i public.invoices%rowtype;
 r public.whatsapp_direct_write_receipts%rowtype;before_row jsonb;request jsonb;result jsonb;
 m jsonb;k text;x jsonb;v numeric;item_sum numeric:=0;subtotal numeric;tax numeric;discount numeric;total numeric;
 customer uuid;issue date;due date;cur text;financial boolean;correction uuid;
begin
 if auth.role() is distinct from 'service_role' then return jsonb_build_object('ok',false,'code','DENIED');end if;
 if p_workspace_id is null or p_owner_id is null or p_invoice_id is null or p_expected_updated_at is null
  or p_phone is null or p_phone!~'^\+[1-9][0-9]{7,14}$' or p_provider_message_id is null or length(p_provider_message_id) not between 1 and 256
  or p_user_message is null or length(p_user_message) not between 1 and 4000
  or p_idempotency_key is null or p_idempotency_key!~'^[A-Za-z0-9_-]{12,120}$'
  or p_values is null or jsonb_typeof(p_values) is distinct from 'object' or p_values='{}'::jsonb or octet_length(p_values::text)>32768 then
  return jsonb_build_object('ok',false,'code','INVALID');end if;
 if (select count(*) from public.whatsapp_resolve_verified_owner(p_phone) x where x.workspace_id=p_workspace_id and x.owner_id=p_owner_id)<>1 then
  return jsonb_build_object('ok',false,'code','DENIED');end if;
 select * into o from public.whatsapp_resolve_verified_owner(p_phone) x where x.workspace_id=p_workspace_id and x.owner_id=p_owner_id;
 perform pg_advisory_xact_lock(hashtextextended(p_phone,0));
 if (select count(*) from public.whatsapp_resolve_verified_owner(p_phone) x where x.workspace_id=p_workspace_id and x.owner_id=p_owner_id and x.customer_id=o.customer_id)<>1 then
  return jsonb_build_object('ok',false,'code','DENIED');end if;
 select * into e from public.whatsapp_inbound_events x where x.provider_message_id=p_provider_message_id and x.sender_phone=p_phone
  and x.message_text=p_user_message and x.status in ('processing','done') for update;
 if not found then return jsonb_build_object('ok',false,'code','INVALID_AUTHORIZATION');end if;
 request:=jsonb_build_object('operation','invoice.correct','targetId',p_invoice_id,'expectedUpdatedAt',p_expected_updated_at,'authorizationQuote',p_user_message,'payload',p_values);
 select * into r from public.whatsapp_direct_write_receipts x where x.provider_message_id=p_provider_message_id for update;
 if found then
  if r.workspace_id is distinct from p_workspace_id or r.owner_id is distinct from p_owner_id or r.phone is distinct from p_phone
    or r.idempotency_key is distinct from p_idempotency_key or r.request is distinct from request then return jsonb_build_object('ok',false,'code','REPLAY_MISMATCH');end if;
  return r.result||jsonb_build_object('replayed',true);end if;
 if e.status<>'processing' or e.received_at<clock_timestamp()-interval '24 hours'
   or e.provider_timestamp is not null and e.provider_timestamp<clock_timestamp()-interval '24 hours' then return jsonb_build_object('ok',false,'code','STALE_EVENT');end if;
 if coalesce((select s.owner_bot_preferences->>'confirmationMode' from public.workspace_settings s where s.workspace_id=p_workspace_id),'direct')<>'direct' then
  return jsonb_build_object('ok',false,'code','CONFIRMATION_REQUIRED');end if;
 result:=app.apply_owner_invoice_correction(p_workspace_id,p_owner_id,p_invoice_id,p_expected_updated_at,p_values,'whatsapp',p_provider_message_id);
 if result->>'ok'='true' then
  insert into public.whatsapp_direct_write_receipts(provider_message_id,workspace_id,owner_id,phone,idempotency_key,request,result)
   values(p_provider_message_id,p_workspace_id,p_owner_id,p_phone,p_idempotency_key,request,result);
 end if;
 return result;
exception when others then return jsonb_build_object('ok',false,'code','INVALID');
end; $$;
revoke all on function public.whatsapp_correct_owner_invoice(uuid,uuid,text,text,text,text,uuid,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.whatsapp_correct_owner_invoice(uuid,uuid,text,text,text,text,uuid,timestamptz,jsonb) to service_role;

create function public.owner_correct_invoice(p_workspace_id uuid,p_invoice_id uuid,p_expected_updated_at timestamptz,p_request_id uuid,p_values jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();
begin
 if auth.role() is distinct from 'authenticated' or actor is null or p_request_id is null
  or not exists(select 1 from public.workspaces w where w.id=p_workspace_id and w.owner_id=actor) then return jsonb_build_object('ok',false,'code','DENIED');end if;
 return app.apply_owner_invoice_correction(p_workspace_id,actor,p_invoice_id,p_expected_updated_at,p_values,'dashboard',p_request_id::text);
end; $$;
revoke all on function public.owner_correct_invoice(uuid,uuid,timestamptz,uuid,jsonb) from public,anon,service_role;
grant execute on function public.owner_correct_invoice(uuid,uuid,timestamptz,uuid,jsonb) to authenticated;
commit;
