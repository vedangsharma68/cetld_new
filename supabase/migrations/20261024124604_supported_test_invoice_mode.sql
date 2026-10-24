-- Invoice-only test mode. No reminder gates, approvals, consent, or templates
-- are replaced: these invoices use the ordinary production reminder workflow.
begin;

-- Only the owner-authenticated creation RPC can enroll an invoice. A private
-- row is the authority; client-settable GUCs and caller metadata are not.
create table app.test_invoice_creations (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  request_id uuid not null,
  invoice_id uuid not null unique,
  customer_id uuid not null,
  invoice_number text not null,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key(workspace_id,request_id),
  foreign key(workspace_id,customer_id) references public.customers(workspace_id,id) on delete restrict,
  foreign key(workspace_id,invoice_id) references public.invoices(workspace_id,id)
    on delete cascade deferrable initially deferred
);
revoke all on app.test_invoice_creations from public,anon,authenticated,service_role;

create function app.guard_test_invoice() returns trigger
language plpgsql security definer set search_path='' as $$
declare enrolled app.test_invoice_creations%rowtype;is_test boolean;was_test boolean;k text;
begin
  is_test:=coalesce(new.metadata->>'test_invoice'='true',false)
    or coalesce(new.metadata->>'source_invoice_number' like 'CETLD-TEST-%',false)
    or coalesce(new.invoice_number like 'CETLD-TEST-%',false);
  if tg_op='INSERT' then
    select * into enrolled from app.test_invoice_creations r
      where r.invoice_id=new.id and r.workspace_id=new.workspace_id;
    -- Look up enrollment even if a later BEFORE trigger erased every visible
    -- marker. The AFTER check must still reject the now-unmarked test row.
    if not found and not is_test and not (new.metadata?'test_invoice') then return new;end if;
    if not found then raise exception 'TEST_INVOICE_CREATION_REQUIRED' using errcode='42501';end if;
    -- The existing numbering trigger still runs normally. This final BEFORE
    -- phase restores the server-authored visible TEST number after it runs.
    if tg_when='BEFORE' and tg_argv[0]='final' then new.invoice_number:=enrolled.invoice_number;end if;
    if new.metadata->'test_invoice' is distinct from 'true'::jsonb
      or new.metadata->>'source_invoice_number' is distinct from enrolled.invoice_number
      or new.invoice_number is distinct from enrolled.invoice_number
      or new.customer_id is distinct from enrolled.customer_id
      or new.total_amount<>1 or new.currency<>'INR'
      or new.customer_phone is distinct from '+919818685252'
      or new.metadata->>'client_name' is distinct from 'TEST - Pappa - NO PAYMENT REQUIRED'
      or new.metadata->>'client_phone' is distinct from '+919818685252'
      or new.metadata->>'debtor_phone' is distinct from '+919818685252'
      or new.metadata->>'invoice_direction' is distinct from 'receivable' then
      raise exception 'TEST_INVOICE_IMMUTABLE' using errcode='42501';
    end if;
  else
    was_test:=coalesce(old.metadata->>'test_invoice'='true',false)
      or coalesce(old.metadata->>'source_invoice_number' like 'CETLD-TEST-%',false)
      or coalesce(old.invoice_number like 'CETLD-TEST-%',false);
    -- Reserve the complete key, including false/null/string substitutions.
    -- This runs for service writes and definer RPCs as well as raw dashboard DML.
    if new.metadata->'test_invoice' is distinct from old.metadata->'test_invoice'
      or (not was_test and is_test) then
      raise exception 'TEST_INVOICE_IMMUTABLE' using errcode='42501';
    end if;
    if not was_test then return new;end if;
    if new.invoice_number is distinct from old.invoice_number
      or new.customer_id is distinct from old.customer_id
      or new.customer_phone is distinct from old.customer_phone
      or new.total_amount is distinct from old.total_amount
      or new.currency is distinct from old.currency then
      raise exception 'TEST_INVOICE_IMMUTABLE' using errcode='42501';
    end if;
    foreach k in array array['source_invoice_number','client_name','client_phone','debtor_phone','invoice_direction'] loop
      if new.metadata->k is distinct from old.metadata->k then
        raise exception 'TEST_INVOICE_IMMUTABLE' using errcode='42501';
      end if;
    end loop;
  end if;
  -- Final database boundary: future linkage writers cannot attach a provider,
  -- even if they omit the application syncEligibility/export checks. Pending
  -- bookkeeping state is harmless (ordinary owner corrections set it); the
  -- candidate filter and syncEligibility independently exclude the invoice.
  if new.external_provider is not null or new.external_invoice_id is not null
    or new.last_synced_at is not null or new.sync_status='synced'
    or new.metadata->>'accounting_provider' is not null
    or new.metadata->>'accounting_external_invoice_id' is not null
    or new.metadata->>'bookkeeping_provider' is not null
    or new.metadata->>'bookkeeping_record_id' is not null
    or new.metadata->>'bookkeeping_synced_at' is not null
    or new.metadata->>'bookkeeping_sync_status'='synced' then
    raise exception 'INVOICE_NOT_EXPORTABLE' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function app.guard_test_invoice() from public,anon,authenticated,service_role;

-- Input guard precedes source guards; final validation follows every currently
-- installed metadata writer. AFTER validation also catches future BEFORE
-- triggers that sort later and silently strip or retrofit the protected facts.
create trigger a00_test_invoice_input before insert or update on public.invoices
  for each row execute function app.guard_test_invoice('input');
create trigger zzzz_test_invoice_final before insert or update on public.invoices
  for each row execute function app.guard_test_invoice('final');
create trigger test_invoice_persisted after insert or update on public.invoices
  for each row execute function app.guard_test_invoice('persisted');

create function app.guard_test_invoice_customer() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  -- Do not alter consent, suppression, or other customer data. Pin only the
  -- identity used by a permanent test invoice, including its soft-deleted form.
  if (new.phone is distinct from old.phone or new.name is distinct from old.name)
    and exists(select 1 from public.invoices i where i.workspace_id=old.workspace_id and i.customer_id=old.id
      and (i.metadata->>'test_invoice'='true' or i.metadata->>'source_invoice_number' like 'CETLD-TEST-%'
        or i.invoice_number like 'CETLD-TEST-%')) then
    raise exception 'TEST_INVOICE_RECIPIENT_LOCKED' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function app.guard_test_invoice_customer() from public,anon,authenticated,service_role;
create trigger test_invoice_customer_identity before update on public.customers
  for each row execute function app.guard_test_invoice_customer();
create trigger test_invoice_customer_persisted after update on public.customers
  for each row execute function app.guard_test_invoice_customer();

-- Test labels must not change the numbering convention inferred for the next
-- real invoice. Keep the installed numbering/locking behavior and ACL intact.
do $numbering_history$
declare target regprocedure:='public.assign_consistent_invoice_number()'::regprocedure;
  definition text;marker text;old_acl aclitem[];
begin
  definition:=pg_get_functiondef(target);
  select proacl into old_acl from pg_proc where oid=target;
  marker:='    where i.workspace_id = new.workspace_id'||chr(10)||'    order by i.created_at desc, i.id desc';
  if (length(definition)-length(replace(definition,marker,'')))/length(marker)<>1 then
    raise exception 'test invoice numbering history marker mismatch';
  end if;
  execute replace(definition,marker,
    '    where i.workspace_id = new.workspace_id'||chr(10)||
    '      and i.metadata->>''test_invoice'' is distinct from ''true'''||chr(10)||
    '      and coalesce(i.metadata->>''source_invoice_number'','''') not like ''CETLD-TEST-%'''||chr(10)||
    '      and i.invoice_number not like ''CETLD-TEST-%'''||chr(10)||
    '    order by i.created_at desc, i.id desc');
  if (select proacl from pg_proc where oid=target) is distinct from old_acl then
    raise exception 'test invoice numbering ACL changed';
  end if;
end $numbering_history$;

create function public.create_test_invoice(p_workspace_id uuid,p_request_id uuid)
returns public.invoices language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();customer uuid;customers uuid[];matches integer;row public.invoices%rowtype;
  enrolled app.test_invoice_creations%rowtype;label text;
begin
  if auth.role() is distinct from 'authenticated' or actor is null
    or not exists(select 1 from public.workspaces w where w.id=p_workspace_id and w.owner_id=actor) then
    raise exception 'OWNER_REQUIRED' using errcode='42501';
  end if;
  if p_request_id is null then raise exception 'INVALID_REQUEST' using errcode='22023';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text||':test-invoice:'||p_request_id::text,0));
  select * into enrolled from app.test_invoice_creations r where r.workspace_id=p_workspace_id and r.request_id=p_request_id;
  if found then
    select * into strict row from public.invoices i where i.workspace_id=p_workspace_id and i.id=enrolled.invoice_id;
    return row;
  end if;
  -- Use an existing contact only. Do not create a contact, grant consent,
  -- remove a suppression, or accept recipient/payment facts from the caller.
  select array_agg(c.id) into customers from (
    select id from public.customers
    where workspace_id=p_workspace_id and lower(btrim(name))='pappa' and phone='+919818685252' for share
  ) c;
  matches:=coalesce(cardinality(customers),0);
  if matches=0 then raise exception 'TEST_RECIPIENT_REQUIRED' using errcode='22023';end if;
  if matches<>1 then raise exception 'TEST_RECIPIENT_AMBIGUOUS' using errcode='22023';end if;
  customer:=customers[1];
  label:='CETLD-TEST-'||p_request_id::text||'-NO-PAYMENT-REQUIRED';
  insert into app.test_invoice_creations(workspace_id,request_id,invoice_id,customer_id,invoice_number,created_by)
    values(p_workspace_id,p_request_id,gen_random_uuid(),customer,label,actor) returning * into enrolled;
  insert into public.invoices(id,workspace_id,customer_id,invoice_number,issue_date,due_date,currency,total_amount,amount_paid,status,customer_phone,notes,metadata)
    values(enrolled.invoice_id,p_workspace_id,customer,label,current_date,current_date,'INR',1,0,'sent','+919818685252',
      'TEST ONLY - NO PAYMENT REQUIRED. Normal reminder preview and owner approval are still required.',
      jsonb_build_object('test_invoice',true,'source_invoice_number',label,'client_name','TEST - Pappa - NO PAYMENT REQUIRED',
        'client_phone','+919818685252','debtor_phone','+919818685252','invoice_direction','receivable',
        'followup_state','draft','bookkeeping_sync_status','excluded')) returning * into row;
  return row;
end $$;
revoke all on function public.create_test_invoice(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.create_test_invoice(uuid,uuid) to authenticated;
commit;
