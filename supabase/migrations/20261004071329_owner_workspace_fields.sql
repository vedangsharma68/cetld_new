-- Add business extension data without exposing DDL, metadata or ledger fields.
-- Existing workspace RLS and owner RPC authorization remain authoritative.
create or replace function app.business_custom_fields_valid(value jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
begin
  if value is null or jsonb_typeof(value)<>'object' or octet_length(value::text)>8192 then return false; end if;
  if (select count(*) from jsonb_object_keys(value))>50 then return false; end if;
  return not exists(select 1 from jsonb_each(value) e where
    e.key !~ '^[a-z][a-z0-9_]{0,63}$'
    or e.key ~* '^(id|.*_id|name|company_name|email|phone|invoice_number|issue_date|due_date|status|amount_paid|total_amount|subtotal|tax|currency|notes|invoice_direction|business_name|default_currency|default_timezone|follow_up_preferences|owner_bot_preferences|primary_model|fallback_model|followup_state|next_follow_up_at|metadata|custom_fields|created_at|updated_at|deleted_at|deleted_by|role|permissions|whatsapp_owner|workspace|tenant|owner|user)$'
    or e.key ~* '(token|secret|password|api.?key|credential|authorization|cookie|storage.?path|code.?hash|private.?key)'
    or jsonb_typeof(e.value) not in ('string','number','boolean','null')
    or jsonb_typeof(e.value)='string' and (length(e.value#>>'{}')>1000 or (e.value#>>'{}')~'[[:cntrl:]]'));
end;
$$;
revoke all on function app.business_custom_fields_valid(jsonb) from public,anon;
grant execute on function app.business_custom_fields_valid(jsonb) to authenticated,service_role;
alter table public.customers add column custom_fields jsonb not null default '{}'::jsonb
  check(app.business_custom_fields_valid(custom_fields));
alter table public.invoices add column custom_fields jsonb not null default '{}'::jsonb
  check(app.business_custom_fields_valid(custom_fields));
alter table public.whatsapp_workspace_data_proposals drop constraint whatsapp_workspace_data_proposals_table_name_check;
alter table public.whatsapp_workspace_data_proposals add constraint whatsapp_workspace_data_proposals_table_name_check
  check(table_name in ('customers','invoices','business_records','workspace_settings','workspace_ai_settings'));

create table public.business_records(
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null references public.workspaces(id) on delete cascade,
  record_type text not null check(record_type ~ '^[a-z][a-z0-9_]{0,63}$'),
  name text not null check(length(btrim(name)) between 1 and 200 and name !~ '[[:cntrl:]]'),
  custom_fields jsonb not null default '{}'::jsonb check(app.business_custom_fields_valid(custom_fields)),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now());
create index business_records_workspace_category_idx on public.business_records(workspace_id,record_type,name);
create trigger business_records_updated_at before update on public.business_records for each row execute function app.set_updated_at();
alter table public.business_records enable row level security;
alter table public.business_records force row level security;
revoke all on public.business_records from public,anon,authenticated,service_role;
grant select on public.business_records to authenticated;
grant select,insert,update on public.business_records to service_role;
create policy business_records_owner_read on public.business_records for select to authenticated
using(exists(select 1 from public.workspaces w where w.id=workspace_id and w.owner_id=(select auth.uid())));
create or replace function app.business_record_values_valid(op text,value jsonb) returns boolean
language plpgsql immutable set search_path='' as $$
begin
  if op not in ('create','update') or jsonb_typeof(value) is distinct from 'object' or value='{}'::jsonb
    or exists(select 1 from jsonb_object_keys(value) k where k not in ('name','record_type','custom_fields')) then return false; end if;
  if op='create' and not(value ? 'name' and value ? 'record_type') then return false; end if;
  if value ? 'name' and (jsonb_typeof(value->'name') is distinct from 'string' or length(btrim(value->>'name')) not between 1 and 200 or value->>'name'~'[[:cntrl:]]') then return false; end if;
  if value ? 'record_type' and (jsonb_typeof(value->'record_type') is distinct from 'string' or value->>'record_type'!~'^[a-z][a-z0-9_]{0,63}$') then return false; end if;
  return not(value ? 'custom_fields') or app.business_custom_fields_valid(value->'custom_fields');
end;
$$;
create or replace function app.apply_business_record(ws uuid,op text,target uuid,expected timestamptz,value jsonb) returns jsonb
language plpgsql set search_path='' as $$
declare r public.business_records%rowtype;
begin
  if not app.business_record_values_valid(op,value) then return jsonb_build_object('ok',false,'code','INVALID'); end if;
  if op='create' then
    if target is not null or expected is not null then return jsonb_build_object('ok',false,'code','INVALID'); end if;
    insert into public.business_records(workspace_id,record_type,name,custom_fields)
      values(ws,value->>'record_type',btrim(value->>'name'),coalesce(value->'custom_fields','{}'::jsonb)) returning * into r;
  else
    select * into r from public.business_records b where b.workspace_id=ws and b.id=target for update;
    if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND'); end if;
    if expected is null or r.updated_at is distinct from expected then return jsonb_build_object('ok',false,'code','STALE'); end if;
    update public.business_records b set name=case when value ? 'name' then btrim(value->>'name') else b.name end,
      record_type=case when value ? 'record_type' then value->>'record_type' else b.record_type end,
      custom_fields=b.custom_fields||coalesce(value->'custom_fields','{}'::jsonb)
      where b.workspace_id=ws and b.id=target returning * into r;
  end if;
  return jsonb_build_object('ok',true,'record',to_jsonb(r));
end;
$$;
revoke all on function app.business_record_values_valid(text,jsonb) from public,anon,authenticated,service_role;
revoke all on function app.apply_business_record(uuid,text,uuid,timestamptz,jsonb) from public,anon,authenticated,service_role;

do $upgrade$
declare v_def text; v_before text;
begin
  v_def:=replace(pg_get_functiondef('public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)'::regprocedure),chr(13),'');
  v_before:=v_def;
  v_def:=replace(v_def,$old$('name','company_name','email','phone')$old$,$new$('name','company_name','email','phone','custom_fields')$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$('invoice_number','issue_date','due_date','total_amount','currency','notes','status')$old$,$new$('invoice_number','issue_date','due_date','total_amount','currency','notes','status','custom_fields')$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$'total_amount','subtotal','tax','currency','notes')$old$,$new$'total_amount','subtotal','tax','currency','notes','custom_fields')$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$if p_operation='invoice.create' then$old$,$new$if v_payload ? 'custom_fields' and not app.business_custom_fields_valid(v_payload->'custom_fields') then
      return jsonb_build_object('ok',false,'code','INVALID'); end if;
    if p_operation='invoice.create' then$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$insert into public.customers(workspace_id,name,company_name,email,phone)$old$,$new$insert into public.customers(workspace_id,name,company_name,email,phone,custom_fields)$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$values(p_workspace_id,v_customer_name,nullif(pg_catalog.btrim(v_payload->>'company_name'),''),v_customer_email,v_customer_phone)$old$,$new$values(p_workspace_id,v_customer_name,nullif(pg_catalog.btrim(v_payload->>'company_name'),''),v_customer_email,v_customer_phone,coalesce(v_payload->'custom_fields','{}'::jsonb))$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$email=v_customer_email,phone=v_customer_phone$old$,$new$email=v_customer_email,phone=v_customer_phone,custom_fields=c.custom_fields||coalesce(v_payload->'custom_fields','{}'::jsonb)$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$insert into public.invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,notes,metadata)$old$,$new$insert into public.invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,notes,metadata,custom_fields)$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$values(p_workspace_id,v_customer.id,v_invoice_number,v_issue_date,v_due_date,v_currency,v_total,v_notes,v_record)$old$,$new$values(p_workspace_id,v_customer.id,v_invoice_number,v_issue_date,v_due_date,v_currency,v_total,v_notes,v_record,coalesce(v_payload->'custom_fields','{}'::jsonb))$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$if v_payload ? 'status' then$old$,$new$if v_payload ? 'custom_fields' and (select count(*) from jsonb_object_keys(v_payload))=1 then
        update public.invoices i set custom_fields=i.custom_fields||(v_payload->'custom_fields')
          where i.workspace_id=p_workspace_id and i.id=p_target_id returning * into v_invoice;
        v_action:='invoice.updated';
      elsif v_payload ? 'status' then$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$total_amount=v_total,currency=v_currency,notes=v_notes,$old$,$new$total_amount=v_total,currency=v_currency,notes=v_notes,custom_fields=i.custom_fields||coalesce(v_payload->'custom_fields','{}'::jsonb),$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$'metadata',v_customer.metadata$old$,$new$'custom_fields',v_customer.custom_fields,'metadata',v_customer.metadata$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$'metadata',v_invoice.metadata$old$,$new$'custom_fields',v_invoice.custom_fields,'metadata',v_invoice.metadata$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$elsif v_proposal.table_name='workspace_settings' then$old$,$new$elsif v_proposal.table_name='invoices' then
        select * into v_invoice from public.invoices i where i.workspace_id=p_workspace_id and i.id=v_proposal.target_id and i.deleted_at is null;
        if not found then raise exception using errcode='Z0002',message='write outcome could not be verified'; end if;
        v_entity_id:=v_invoice.id::text;v_entity_type:='invoice';v_action:='invoice.updated';v_updated_at:=v_invoice.updated_at;
        v_record:=to_jsonb(v_invoice);
      elsif v_proposal.table_name='workspace_settings' then$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  execute v_def;
end;
$upgrade$;
do $upgrade$
declare v_def text; v_before text;
begin
  v_def:=replace(pg_get_functiondef('public.whatsapp_workspace_data_propose(uuid,uuid,text,text,text,text,uuid,timestamptz,jsonb,text,bigint,bigint,bigint)'::regprocedure),chr(13),'');
  v_before:=v_def;
  v_def:=replace(v_def,$old$('customers','workspace_settings','workspace_ai_settings')$old$,$new$('customers','invoices','business_records','workspace_settings','workspace_ai_settings')$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$if p_table = 'customers' then$old$,$new$if p_values ? 'custom_fields' and not app.business_custom_fields_valid(p_values->'custom_fields') then
    return jsonb_build_object('ok',false,'reason','invalid'); end if;
  if p_table = 'customers' then$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$e.key not in ('name','company_name','email','phone')$old$,$new$e.key not in ('name','company_name','email','phone','custom_fields')$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$or pg_catalog.jsonb_typeof(e.value) not in ('string','null'))$old$,$new$or e.key<>'custom_fields' and pg_catalog.jsonb_typeof(e.value) not in ('string','null'))$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$elsif p_table = 'workspace_settings' then$old$,$new$elsif p_table = 'invoices' then
    if p_operation<>'update' or p_expected_updated_at is null or p_target_id is null
      or not(p_values ? 'custom_fields') or (select count(*) from jsonb_object_keys(p_values))<>1 then
      return jsonb_build_object('ok',false,'reason','invalid'); end if;
    select i.updated_at into v_row_updated_at from public.invoices i where i.workspace_id=p_workspace_id and i.id=p_target_id and i.deleted_at is null;
    if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
    if v_row_updated_at is distinct from p_expected_updated_at then return jsonb_build_object('ok',false,'reason','stale'); end if;
  elsif p_table = 'workspace_settings' then$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  execute v_def;
end;
$upgrade$;
do $upgrade$
declare v_def text; v_before text;
begin
  v_def:=replace(pg_get_functiondef('public.whatsapp_workspace_data_decide(uuid,uuid,text,bigint,bigint,uuid,text,text,text,boolean)'::regprocedure),chr(13),'');
  v_before:=v_def;
  v_def:=replace(v_def,$old$insert into public.customers(workspace_id,name,company_name,email,phone)$old$,$new$insert into public.customers(workspace_id,name,company_name,email,phone,custom_fields)$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$v_proposal.values->>'email',v_proposal.values->>'phone');$old$,$new$v_proposal.values->>'email',v_proposal.values->>'phone',coalesce(v_proposal.values->'custom_fields','{}'::jsonb));$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$phone=case when v_proposal.values ? 'phone' then v_proposal.values->>'phone' else c.phone end$old$,$new$phone=case when v_proposal.values ? 'phone' then v_proposal.values->>'phone' else c.phone end,
        custom_fields=c.custom_fields||coalesce(v_proposal.values->'custom_fields','{}'::jsonb)$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$elsif v_proposal.table_name='workspace_settings' then$old$,$new$elsif v_proposal.table_name='invoices' then
    if v_proposal.operation<>'update' or not app.business_custom_fields_valid(v_proposal.values->'custom_fields')
      or (select count(*) from jsonb_object_keys(v_proposal.values))<>1 then return jsonb_build_object('ok',false,'reason','invalid'); end if;
    perform 1 from public.invoices i where i.workspace_id=p_workspace_id and i.id=v_proposal.target_id and i.deleted_at is null
      and i.updated_at=v_proposal.expected_updated_at for update;
    if not found then return jsonb_build_object('ok',false,'reason','stale'); end if;
    update public.invoices i set custom_fields=i.custom_fields||(v_proposal.values->'custom_fields')
      where i.workspace_id=p_workspace_id and i.id=v_proposal.target_id;
  elsif v_proposal.table_name='workspace_settings' then$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  execute v_def;
end;
$upgrade$;
do $upgrade$
declare v_def text; v_before text;
begin
  v_def:=replace(pg_get_functiondef('public.whatsapp_apply_direct_owner_write(uuid,uuid,text,text,text,text,text,uuid,timestamptz,text,text,text,bigint,bigint,jsonb)'::regprocedure),chr(13),'');
  v_before:=v_def;
  v_def:=replace(v_def,$old$'customer.create','customer.update','customer.delete','settings.update','ai_settings.update')$old$,$new$'customer.create','customer.update','customer.delete','settings.update','ai_settings.update','business_record.create','business_record.update')$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$if p_operation='invoice.create' then$old$,$new$if p_operation in ('business_record.create','business_record.update') then
      v_record:=app.apply_business_record(p_workspace_id,split_part(p_operation,'.',2),p_target_id,p_expected_updated_at,v_payload);
      if v_record->>'ok'<>'true' then return v_record; end if;
      v_record:=v_record->'record';v_entity_type:='business_record';v_entity_id:=v_record->>'id';v_updated_at:=(v_record->>'updated_at')::timestamptz;
      v_action:=case when p_operation='business_record.create' then 'business_record.created' else 'business_record.updated' end;
    elsif p_operation='invoice.create' then$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  v_before:=v_def;
  v_def:=replace(v_def,$old$elsif v_proposal.table_name='invoices' then$old$,$new$elsif v_proposal.table_name='business_records' then
        select to_jsonb(b) into v_record from public.business_records b where b.workspace_id=p_workspace_id
          and (b.id=v_proposal.target_id or v_proposal.operation='create' and b.created_at>=v_pending.created_at and b.name=v_proposal.values->>'name' and b.record_type=v_proposal.values->>'record_type') order by b.created_at desc limit 1;
        if not found then raise exception using errcode='Z0002',message='write outcome could not be verified'; end if;
        v_entity_type:='business_record';v_entity_id:=v_record->>'id';v_updated_at:=(v_record->>'updated_at')::timestamptz;
        v_action:=case when v_proposal.operation='create' then 'business_record.created' else 'business_record.updated' end;
      elsif v_proposal.table_name='invoices' then$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  execute v_def;
end;
$upgrade$;
do $upgrade$
declare v_def text; v_before text;
begin
  v_def:=replace(pg_get_functiondef('public.whatsapp_workspace_data_propose(uuid,uuid,text,text,text,text,uuid,timestamptz,jsonb,text,bigint,bigint,bigint)'::regprocedure),chr(13),'');
  v_before:=v_def;
  v_def:=replace(v_def,$old$elsif p_table = 'invoices' then$old$,$new$elsif p_table = 'business_records' then
    if not app.business_record_values_valid(p_operation,p_values) then return jsonb_build_object('ok',false,'reason','invalid'); end if;
    if p_operation='create' then
      if p_target_id is not null or p_expected_updated_at is not null then return jsonb_build_object('ok',false,'reason','invalid'); end if;
    else
      select b.updated_at into v_row_updated_at from public.business_records b where b.workspace_id=p_workspace_id and b.id=p_target_id;
      if not found then return jsonb_build_object('ok',false,'reason','not_found'); end if;
      if v_row_updated_at is distinct from p_expected_updated_at then return jsonb_build_object('ok',false,'reason','stale'); end if;
    end if;
  elsif p_table = 'invoices' then$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  execute v_def;
end;
$upgrade$;
do $upgrade$
declare v_def text; v_before text;
begin
  v_def:=replace(pg_get_functiondef('public.whatsapp_workspace_data_decide(uuid,uuid,text,bigint,bigint,uuid,text,text,text,boolean)'::regprocedure),chr(13),'');
  v_before:=v_def;
  v_def:=replace(v_def,$old$elsif v_proposal.table_name='invoices' then$old$,$new$elsif v_proposal.table_name='business_records' then
    v_result:=app.apply_business_record(p_workspace_id,v_proposal.operation,v_proposal.target_id,v_proposal.expected_updated_at,v_proposal.values);
    if v_result->>'ok'<>'true' then return jsonb_build_object('ok',false,'reason',lower(v_result->>'code')); end if;
  elsif v_proposal.table_name='invoices' then$new$);
  if v_def=v_before then raise exception 'Owner workspace upgrade patch point missing'; end if;
  execute v_def;
end;
$upgrade$;
