-- Plan Tally imports without writes; confirmation rechecks that exact plan.
create function app.tally_import_plan(p_workspace_id uuid,p_customers jsonb,p_invoices jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 r jsonb; prior jsonb; row_plan jsonb; customers jsonb:='[]'; invoices jsonb:='[]';
 customer_ref text; existing_id uuid; matches int; row_index int:=0; action text; reason text;
 workspace_currency text; normalized_currency text; issue_date date; due_date date;
begin
 if jsonb_typeof(p_customers) is distinct from 'array' or jsonb_typeof(p_invoices) is distinct from 'array'
  or jsonb_array_length(p_customers)>4000 or jsonb_array_length(p_invoices)>2000
  or octet_length(p_customers::text)+octet_length(p_invoices::text)>4194304 then
  raise exception 'Invalid Tally import size' using errcode='22023';
 end if;
 select default_currency into workspace_currency from public.workspace_settings where workspace_id=p_workspace_id;
 workspace_currency:=coalesce(workspace_currency,'INR');
 for r in select value from jsonb_array_elements(p_customers) loop
  row_index:=row_index+1;action:='create';reason:=null;customer_ref:=null;existing_id:=null;prior:=null;
  r:=r||jsonb_build_object('name',btrim(r->>'name'));
  if jsonb_typeof(r) is distinct from 'object' or coalesce(length(r->>'name'),0) not between 1 and 200
    or coalesce(r->>'name','') ~ '[[:cntrl:]]'
    or (nullif(r->>'email','') is not null and r->>'email' !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$') then
   action:='fail';reason:='Invalid customer name or email.';
  else
   -- Prefer an exact GUID over a coincidentally equal name, including file duplicates.
   if nullif(r->>'guid','') is not null then
    select value into prior from jsonb_array_elements(customers) where value->>'action'<>'fail' and value->>'guid'=r->>'guid' limit 1;
    if prior is null then
     select count(*),min(id::text)::uuid into matches,existing_id from public.customers
      where workspace_id=p_workspace_id and metadata->'tally'->>'guid'=r->>'guid';
     if matches>1 then action:='fail';reason:='Tally GUID matches multiple customers.';end if;
    end if;
   end if;
   if prior is null and existing_id is null and action<>'fail' then
    select value into prior from jsonb_array_elements(customers) where value->>'action'<>'fail'
     and lower(btrim(value->>'name'))=lower(r->>'name') limit 1;
    if prior is null then
     select count(*),min(id::text)::uuid into matches,existing_id from public.customers
      where workspace_id=p_workspace_id and lower(btrim(name))=lower(r->>'name');
     if matches>1 then action:='fail';reason:='Customer name is ambiguous; supply a matching Tally GUID.';end if;
    end if;
   end if;
   if action<>'fail' then
    if prior is not null then action:='skip';reason:='Duplicate customer in this file.';customer_ref:=prior->>'customerRef';
    elsif existing_id is not null then action:='skip';reason:='Customer already exists.';customer_ref:=existing_id::text;
    elsif nullif(r->>'email','') is not null and (
      exists(select 1 from public.customers where workspace_id=p_workspace_id and lower(email)=lower(r->>'email'))
      or exists(select 1 from jsonb_array_elements(customers) where value->>'action'='create' and lower(value->>'email')=lower(r->>'email'))) then
     action:='fail';reason:='Email belongs to another customer; correct the name, GUID or email.';
    else customer_ref:='new:'||row_index::text;
    end if;
   end if;
  end if;
  customers:=customers||jsonb_build_array(r||jsonb_build_object('action',action,'reason',reason,'customerRef',customer_ref));
 end loop;
 for r in select value from jsonb_array_elements(p_invoices) loop
  action:='create';reason:=null;customer_ref:=null;existing_id:=null;prior:=null;
  normalized_currency:=upper(coalesce(nullif(btrim(r->>'currency'),''),workspace_currency));
  r:=r||jsonb_build_object('currency',normalized_currency);
  begin
   issue_date:=(r->>'issueDate')::date;due_date:=(r->>'dueDate')::date;
   if jsonb_typeof(r) is distinct from 'object' or coalesce(length(btrim(r->>'customer')),0) not between 1 and 200
    or coalesce(length(btrim(r->>'number')),0) not between 1 and 100 or coalesce(r->>'number','') ~ '[[:cntrl:]]'
    or issue_date is null or due_date is null or issue_date<date '2000-01-01' or extract(year from issue_date)>9999 or due_date<issue_date
    or not app.currency_uses_two_decimal_precision(normalized_currency)
    or coalesce(r->>'total','') !~ '^[0-9]{1,12}([.][0-9]{1,2})?$' or (r->>'total')::numeric<=0 then
    raise exception 'invalid invoice';
   end if;
  exception when others then action:='fail';reason:='Invalid invoice customer, number, dates, amount or unsupported currency.';
  end;
  if action<>'fail' then
   select count(distinct value->>'customerRef'),min(value->>'customerRef') into matches,customer_ref from jsonb_array_elements(customers)
    where value->>'action'<>'fail' and lower(btrim(value->>'name'))=lower(btrim(r->>'customer'));
   if matches>1 then customer_ref:=null;
   elsif matches=0 then
    select count(*),min(id::text)::uuid into matches,existing_id from public.customers
     where workspace_id=p_workspace_id and lower(btrim(name))=lower(btrim(r->>'customer'));
    if matches=1 then customer_ref:=existing_id::text;end if;
   end if;
   -- A voucher GUID is sufficient to recognize an already imported invoice.
   existing_id:=null;
   if nullif(r->>'guid','') is not null then
    select id into existing_id from public.invoices where workspace_id=p_workspace_id and metadata->'tally'->>'guid'=r->>'guid' order by created_at,id limit 1;
    select value into prior from jsonb_array_elements(invoices) where value->>'action'<>'fail' and value->>'guid'=r->>'guid' limit 1;
   end if;
   if existing_id is null and prior is null and customer_ref is not null then
    select value into prior from jsonb_array_elements(invoices) where value->>'action'<>'fail'
     and value->>'customerRef'=customer_ref and value->>'number'=r->>'number' limit 1;
    if prior is null and customer_ref not like 'new:%' then
     select id into existing_id from public.invoices where workspace_id=p_workspace_id and customer_id=customer_ref::uuid
      and (invoice_number=r->>'number' or metadata->>'source_invoice_number'=r->>'number' or metadata->>'printed_invoice_number'=r->>'number') order by created_at,id limit 1;
    end if;
   end if;
   if existing_id is not null then action:='skip';reason:='Invoice already exists.';
   elsif prior is not null then action:='skip';reason:='Duplicate invoice in this file.';
   elsif customer_ref is null then action:='fail';reason:='Customer could not be resolved; correct its customer row first.';
   end if;
  end if;
  invoices:=invoices||jsonb_build_array(r||jsonb_build_object('action',action,'reason',reason,'customerRef',customer_ref));
 end loop;
 return jsonb_build_object('workspaceCurrency',workspace_currency,'customers',customers,'invoices',invoices,'counts',jsonb_build_object(
  'customers',(select jsonb_build_object('created',count(*) filter(where value->>'action'='create'),'skipped',count(*) filter(where value->>'action'='skip'),'failed',count(*) filter(where value->>'action'='fail')) from jsonb_array_elements(customers)),
  'invoices',(select jsonb_build_object('created',count(*) filter(where value->>'action'='create'),'skipped',count(*) filter(where value->>'action'='skip'),'failed',count(*) filter(where value->>'action'='fail')) from jsonb_array_elements(invoices))));
end;$$;
revoke all on function app.tally_import_plan(uuid,jsonb,jsonb) from public,anon,authenticated,service_role;

create function public.preview_tally(p_workspace_id uuid,p_customers jsonb,p_invoices jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare plan jsonb;
begin
 if auth.uid() is null or not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=auth.uid()) then
  raise exception 'Only the workspace owner can import Tally data' using errcode='42501';
 end if;
 plan:=app.tally_import_plan(p_workspace_id,p_customers,p_invoices);
 return plan||jsonb_build_object('planHash',md5(plan::text));
end;$$;
revoke all on function public.preview_tally(uuid,jsonb,jsonb) from public,anon,service_role;
grant execute on function public.preview_tally(uuid,jsonb,jsonb) to authenticated;

create function public.import_tally(p_workspace_id uuid,p_customers jsonb,p_invoices jsonb,p_expected_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 plan jsonb;r jsonb;customer_ids jsonb:='{}';cid uuid;
 created_c int:=0;skipped_c int;failed_c int;created_i int:=0;skipped_i int;failed_i int;failures jsonb:='[]';
begin
 if auth.uid() is null or not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=auth.uid()) then
  raise exception 'Only the workspace owner can import Tally data' using errcode='42501';
 end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text,92741));
 plan:=app.tally_import_plan(p_workspace_id,p_customers,p_invoices);
 if p_expected_hash is null or md5(plan::text) is distinct from p_expected_hash then
  raise exception 'Import preview is stale. Preview the file again before confirming.' using errcode='40001';
 end if;
 skipped_c:=(plan->'counts'->'customers'->>'skipped')::int;failed_c:=(plan->'counts'->'customers'->>'failed')::int;
 skipped_i:=(plan->'counts'->'invoices'->>'skipped')::int;failed_i:=(plan->'counts'->'invoices'->>'failed')::int;
 for r in select value from jsonb_array_elements(plan->'customers') loop
  if r->>'action'='fail' then failures:=failures||jsonb_build_array(jsonb_build_object('type','customer','name',r->>'name','error',r->>'reason'));
  elsif r->>'action'='create' then
   begin
    insert into public.customers(workspace_id,name,email,phone,metadata)
     values(p_workspace_id,r->>'name',nullif(r->>'email',''),nullif(r->>'phone',''),jsonb_build_object('source','tally','tally',jsonb_build_object('guid',r->>'guid','original_id',r->>'originalId','ledger_name',r->>'name')))
     returning id into cid;
    customer_ids:=customer_ids||jsonb_build_object(r->>'customerRef',cid::text);created_c:=created_c+1;
   exception when others then
    failed_c:=failed_c+1;failures:=failures||jsonb_build_array(jsonb_build_object('type','customer','name',r->>'name','error','Customer could not be imported. Retry after correcting the conflicting record.'));
   end;
  end if;
 end loop;
 for r in select value from jsonb_array_elements(plan->'invoices') loop
  if r->>'action'='fail' then failures:=failures||jsonb_build_array(jsonb_build_object('type','invoice','number',r->>'number','error',r->>'reason'));
  elsif r->>'action'='create' then
   begin
    cid:=case when r->>'customerRef' like 'new:%' then (customer_ids->>(r->>'customerRef'))::uuid else (r->>'customerRef')::uuid end;
    if cid is null then raise exception 'customer was not created';end if;
    insert into public.invoices(workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,metadata)
     values(p_workspace_id,cid,r->>'number',(r->>'issueDate')::date,(r->>'dueDate')::date,r->>'currency',(r->>'total')::numeric,
      jsonb_build_object('source','tally','bookkeeping_origin','tally','bookkeeping_sync_status','not_configured','invoice_direction','receivable',
       'followup_state','draft','next_follow_up_at',null,'outstanding_amount',(r->>'total')::numeric,'source_invoice_number',r->>'number',
       'tally',jsonb_build_object('guid',r->>'guid','original_id',r->>'originalId','voucher_number',r->>'number','ledger_name',r->>'customer')));
    created_i:=created_i+1;
   exception when others then
    failed_i:=failed_i+1;failures:=failures||jsonb_build_array(jsonb_build_object('type','invoice','number',r->>'number','error','Invoice could not be imported. Retry after correcting the conflicting record.'));
   end;
  end if;
 end loop;
 return jsonb_build_object('customers',jsonb_build_object('created',created_c,'skipped',skipped_c,'failed',failed_c),
  'invoices',jsonb_build_object('created',created_i,'skipped',skipped_i,'failed',failed_i),'failures',failures);
end;$$;
revoke all on function public.import_tally(uuid,jsonb,jsonb,text) from public,anon,service_role;
grant execute on function public.import_tally(uuid,jsonb,jsonb,text) to authenticated;
