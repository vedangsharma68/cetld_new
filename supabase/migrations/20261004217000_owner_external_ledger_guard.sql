-- FORWARD LOCAL REVIEW PROPOSAL. No remote writeback or production application.
begin;
-- The source chain already explicitly grants selected app helper EXECUTE to the
-- backend (01110000). USAGE permits those existing invoker-trigger calls, not
-- schema CREATE, table access or blanket helper execution. Private guards below
-- retain explicit EXECUTE revocations. Live production grants are not inferred.
grant usage on schema app to service_role;
create function app.invoice_has_external_ledger(i public.invoices) returns boolean
language sql immutable set search_path='' as $$
 select nullif(btrim(i.external_provider),'') is not null
   or nullif(btrim(i.external_invoice_id),'') is not null
   or nullif(btrim(i.metadata->>'accounting_provider'),'') is not null
   or nullif(btrim(i.metadata->>'bookkeeping_record_id'),'') is not null;
$$;
revoke all on function app.invoice_has_external_ledger(public.invoices) from public,anon,authenticated,service_role;

create function app.aligned_authoritative_provider_payment(i public.invoices,p public.payments) returns boolean
language sql stable set search_path='' as $$
 select coalesce(auth.role()='service_role' and i.external_provider in ('zoho_books','quickbooks')
   and nullif(btrim(i.external_invoice_id),'') is not null and p.external_provider=i.external_provider
   and nullif(btrim(p.external_payment_id),'') is not null
   and p.metadata->>'external_invoice_id'=i.external_invoice_id,false);
$$;
revoke all on function app.aligned_authoritative_provider_payment(public.invoices,public.payments) from public,anon,authenticated,service_role;

-- Owner entrypoints enforce the actual scoped row independently of model/UI
-- preflight. CREATE OR REPLACE retains the installed function ACLs and bodies.
do $owner_guard$
declare target regprocedure;original text;marker text;addition text;old_acl aclitem[];
begin
 for target in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where (n.nspname='app' and p.proname='apply_owner_invoice_correction')
     or (n.nspname='public' and p.proname='whatsapp_apply_direct_owner_write')
     or (n.nspname='app' and p.proname='whatsapp_apply_owner_batch_operation')
 loop
  original:=replace(pg_get_functiondef(target),chr(13),'');select proacl into old_acl from pg_proc where oid=target;
  if strpos(original,' financial:=p_values ?| array[')>0 then
   marker:=' if financial and (i.amount_paid>0';
   addition:=' if financial and app.invoice_has_external_ledger(i) then return jsonb_build_object(''ok'',false,''code'',''EXTERNAL_ACCOUNTING'');end if;'||chr(10);
  else
   marker:='      elsif v_payload ? ''status'' then';
   addition:='      elsif app.invoice_has_external_ledger(v_invoice) and v_payload ?| array[''invoice_number'',''customer_id'',''line_items'',''subtotal'',''tax'',''discount'',''total_amount'',''currency'',''invoice_direction'',''status''] then return pg_catalog.jsonb_build_object(''ok'',false,''code'',''EXTERNAL_ACCOUNTING'');'||chr(10);
  end if;
  if (length(original)-length(replace(original,marker,'')))/length(marker)<>1 or strpos(original,'EXTERNAL_ACCOUNTING')>0 then raise exception 'owner external ledger insertion marker mismatch: %',target;end if;
  execute replace(original,marker,addition||marker);
  if strpos(original,'v_pending_type in (''owner_invoice_update'',''owner_invoice_payment'')')>0 then
   original:=replace(pg_get_functiondef(target),chr(13),'');
   marker:='when ''settled'' then ''PAYMENT_GUARD'' else ''NO_PENDING_ACTION'' end);';
   if (length(original)-length(replace(original,marker,'')))/length(marker)<>1 then raise exception 'legacy refusal mapping marker mismatch';end if;
   execute replace(original,marker,'when ''settled'' then ''PAYMENT_GUARD'' when ''external_accounting'' then ''EXTERNAL_ACCOUNTING'' else ''NO_PENDING_ACTION'' end);');
  end if;
  if (select proacl from pg_proc where oid=target) is distinct from old_acl then raise exception 'owner ledger guard ACL changed';end if;
 end loop;
 if (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where (n.nspname='app' and p.proname in ('apply_owner_invoice_correction','whatsapp_apply_owner_batch_operation')) or (n.nspname='public' and p.proname='whatsapp_apply_direct_owner_write'))<>3 then raise exception 'owner ledger functions missing';end if;
 -- Place AFTER the deployed exact historical receipt replay, before a new write.
 target:='public.record_invoice_payment(uuid,uuid,numeric,text,text,boolean)'::regprocedure;
 original:=replace(pg_get_functiondef(target),chr(13),'');select proacl into old_acl from pg_proc where oid=target;
 marker:='  if invoice_row.metadata->>''invoice_direction'' is distinct from ''receivable'' then';
 if (length(original)-length(replace(original,marker,'')))/length(marker)<>1 then raise exception 'local payment ledger marker mismatch';end if;
 execute replace(original,marker,'  if app.invoice_has_external_ledger(invoice_row) then raise exception ''EXTERNAL_ACCOUNTING: record this payment in the connected ledger and sync'' using errcode=''22023'';end if;'||chr(10)||marker);
 if (select proacl from pg_proc where oid=target) is distinct from old_acl then raise exception 'payment guard ACL changed';end if;
 target:='public.whatsapp_confirm_owner_invoice_action(uuid,uuid,text,bigint,bigint,text,boolean)'::regprocedure;
 original:=replace(pg_get_functiondef(target),chr(13),'');select proacl into old_acl from pg_proc where oid=target;
 marker:=' change:=pending.action->''changes'';';
 if (length(original)-length(replace(original,marker,'')))/length(marker)<>1 then raise exception 'legacy owner invoice marker mismatch';end if;
 execute replace(original,marker,marker||chr(10)||' if app.invoice_has_external_ledger(invoice) and change ?| array[''invoice_number'',''customer_id'',''total_amount'',''currency'',''status'',''line_items'',''subtotal'',''tax'',''discount'',''invoice_direction''] then return jsonb_build_object(''ok'',false,''reason'',''external_accounting'',''completed'',false,''requiresConfirmation'',false);end if;');
 if (select proacl from pg_proc where oid=target) is distinct from old_acl then raise exception 'legacy owner ACL changed';end if;
 target:='public.whatsapp_invoice_reopening(uuid,uuid,text,text,text,text,uuid,uuid,bigint,bigint,text)'::regprocedure;
 original:=replace(pg_get_functiondef(target),chr(13),'');select proacl into old_acl from pg_proc where oid=target;
 marker:='  if coalesce(to_jsonb(i)->>''external_provider'',i.metadata->>''accounting_provider'','''')<>''''';
 if (length(original)-length(replace(original,marker,'')))/length(marker)<>1 then raise exception 'reopening external invoice marker mismatch';end if;
 execute replace(original,marker,'  if app.invoice_has_external_ledger(i)');
 if (select proacl from pg_proc where oid=target) is distinct from old_acl then raise exception 'reopening owner ACL changed';end if;
end; $owner_guard$;

-- Unknown historical provider Invoice direction stays unchanged. Only a scoped
-- authoritative incoming receipt bypasses unknown; explicit payable stays blocked.
do $import_direction$
declare target regprocedure:='app.guard_incoming_payment_direction()'::regprocedure;original text;marker text:=' if i.metadata->>''invoice_direction''=''receivable'' then return new;end if;';old_acl aclitem[];
begin
 original:=replace(pg_get_functiondef(target),chr(13),'');select proacl into old_acl from pg_proc where oid=target;
 if (length(original)-length(replace(original,marker,'')))/length(marker)<>1 then raise exception 'incoming import direction marker mismatch';end if;
 execute replace(original,marker,marker||chr(10)||' if i.metadata->>''invoice_direction'' is distinct from ''payable'' and app.aligned_authoritative_provider_payment(i,new) then return new;end if;');
 if (select proacl from pg_proc where oid=target) is distinct from old_acl then raise exception 'incoming payment ACL changed';end if;
end; $import_direction$;

create function app.guard_external_invoice_local_payment() returns trigger
language plpgsql security definer set search_path='' as $$
declare i public.invoices%rowtype;p public.payments%rowtype;
begin
 select * into i from public.invoices where workspace_id=new.workspace_id and id=new.invoice_id for update;
 if not found then raise exception 'payment invoice scope mismatch' using errcode='42501';end if;
 if not app.invoice_has_external_ledger(i) and new.external_provider is null and new.external_payment_id is null then return new;end if;
 -- Exact old local receipts may conflict without creating another financial row.
 if new.idempotency_key is not null then
  select * into p from public.payments where workspace_id=new.workspace_id and idempotency_key=new.idempotency_key for update;
  if found and p.invoice_id is not distinct from new.invoice_id and p.amount is not distinct from new.amount
    and p.reference is not distinct from new.reference and p.settle_remaining is not distinct from new.settle_remaining
    and p.external_provider is not distinct from new.external_provider and p.external_payment_id is not distinct from new.external_payment_id then return new;end if;
 end if;
 if app.aligned_authoritative_provider_payment(i,new) then return new;end if;
 raise exception 'EXTERNAL_ACCOUNTING: linked invoice requires an aligned authoritative provider receipt' using errcode='22023';
end; $$;
revoke all on function app.guard_external_invoice_local_payment() from public,anon,authenticated,service_role;
create trigger payments_external_ledger_guard before insert on public.payments for each row execute function app.guard_external_invoice_local_payment();

-- Authenticated raw dashboard updates cannot bypass the typed owner guard or
-- erase linkage. Trusted accounting sync keeps its separate service PATCH path.
create function app.guard_external_invoice_owner_update() returns trigger
language plpgsql security definer set search_path='' as $$
declare changed boolean;k text;
begin
 if auth.role() is distinct from 'authenticated' then return new;end if;
 if new.external_provider is distinct from old.external_provider or new.external_invoice_id is distinct from old.external_invoice_id
   or new.metadata->'accounting_provider' is distinct from old.metadata->'accounting_provider'
   or new.metadata->'bookkeeping_record_id' is distinct from old.metadata->'bookkeeping_record_id' then raise exception 'external ledger linkage is protected' using errcode='42501';end if;
 if not app.invoice_has_external_ledger(old) then return new;end if;
 changed:=new.invoice_number is distinct from old.invoice_number or new.customer_id is distinct from old.customer_id
   or new.total_amount is distinct from old.total_amount or new.currency is distinct from old.currency
   or new.amount_paid is distinct from old.amount_paid or (new.status is distinct from old.status and new.status='paid');
 foreach k in array array['line_items','subtotal','subtotal_minor','tax','tax_minor','discount','discount_minor','invoice_direction'] loop changed:=changed or new.metadata->k is distinct from old.metadata->k;end loop;
 if changed then raise exception 'EXTERNAL_ACCOUNTING: financial correction requires the connected ledger' using errcode='22023';end if;
 return new;
end; $$;
revoke all on function app.guard_external_invoice_owner_update() from public,anon,authenticated,service_role;
create trigger invoices_owner_external_ledger_guard before update on public.invoices for each row execute function app.guard_external_invoice_owner_update();
commit;
