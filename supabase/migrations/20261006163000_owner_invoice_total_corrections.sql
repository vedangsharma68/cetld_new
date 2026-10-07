-- REVIEW ONLY. Installation requires separate production approval.
-- No business rows, receipts, reversals, grants or external ledgers are changed.
begin;

-- The existing correction RPC invalidates a pending reopening as stale. Match
-- that existing behavior so a reviewed correction cannot fail its state CHECK.
alter table public.invoice_reopening_proposals drop constraint invoice_reopening_proposals_state_check;
alter table public.invoice_reopening_proposals add constraint invoice_reopening_proposals_state_check
 check(state in ('pending','confirmed','cancelled','expired','stale'));

-- Private transaction context, following invoice_lifecycle_write_context.
-- Custom session settings are client-settable and cannot authorize repricing.
create table app.invoice_total_correction_context (
 backend_pid integer not null,transaction_id bigint not null,invoice_id uuid not null,
 primary key(backend_pid,transaction_id,invoice_id)
);
revoke all on app.invoice_total_correction_context from public,anon,authenticated,service_role;

create function app.has_invoice_total_correction_context(invoice_id uuid) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from app.invoice_total_correction_context c
  where c.backend_pid=pg_backend_pid() and c.transaction_id=txid_current() and c.invoice_id=$1);
$$;
revoke all on function app.has_invoice_total_correction_context(uuid) from public,anon,authenticated,service_role;

-- Existing overpayments may survive benign edits. New excess paid must arise
-- only from the owner RPC's verified, audited correction of the locked invoice.
create function app.guard_invoice_overpayment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.amount_paid>new.total_amount then
  if tg_op='INSERT' then raise exception 'overpayment requires an audited invoice correction' using errcode='22023';end if;
  if (new.amount_paid is distinct from old.amount_paid or new.total_amount is distinct from old.total_amount)
   and not app.has_invoice_total_correction_context(old.id) then
   raise exception 'overpayment requires an audited invoice correction' using errcode='22023';end if;
 end if;
 if tg_op='UPDATE' and not app.invoice_has_external_ledger(new)
  and (new.amount_paid is distinct from old.amount_paid or new.total_amount is distinct from old.total_amount) then
  new.metadata:=new.metadata||jsonb_build_object('outstanding_amount',greatest(new.total_amount-new.amount_paid,0),
   'overpayment_amount',greatest(new.amount_paid-new.total_amount,0));
 end if;
 return new;
end; $$;
revoke all on function app.guard_invoice_overpayment() from public,anon,authenticated,service_role;
create trigger a1_invoices_overpayment_guard before insert or update of total_amount,amount_paid on public.invoices
for each row execute function app.guard_invoice_overpayment();
alter table public.invoices drop constraint invoices_check;
alter table public.invoices add constraint invoices_amount_paid_check check(amount_paid>=0);
alter table public.invoices add constraint invoices_overpayment_projection_check check(
 amount_paid<=total_amount or (status='paid' and metadata->>'outstanding_amount' is not null
  and (metadata->>'outstanding_amount')::numeric=0 and metadata->>'overpayment_amount' is not null
  and (metadata->>'overpayment_amount')::numeric=amount_paid-total_amount)
);

create or replace function app.protect_settled_invoice_amounts() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if not app.currency_uses_two_decimal_precision(old.currency)
  and (new.total_amount is distinct from old.total_amount or new.currency is distinct from old.currency) then
  raise exception 'This legacy invoice uses unsupported currency precision. Keep its saved amount unchanged and create a corrected invoice in a supported currency.' using errcode='22023';end if;
 if (old.amount_paid>0 or old.status::text in ('paid','void','cancelled')
   or exists(select 1 from public.payments p where p.workspace_id=old.workspace_id and p.invoice_id=old.id)
   or exists(select 1 from public.payment_reversals r where r.workspace_id=old.workspace_id and r.invoice_id=old.id))
  and (new.total_amount is distinct from old.total_amount or new.currency is distinct from old.currency) then
  if new.currency is distinct from old.currency or new.amount_paid is distinct from old.amount_paid
   or old.status::text in ('void','cancelled') or old.deleted_at is not null or app.invoice_has_external_ledger(old)
   or not app.has_invoice_total_correction_context(old.id) then
   raise exception 'An invoice amount or currency cannot change after a payment is recorded or the invoice becomes terminal.' using errcode='22023';end if;
 end if;
 return new;
end; $$;

-- Preserve installed validation and external-accounting guards, fail closed if
-- their exact reviewed insertion points differ, and retain every function ACL.
do $correction$
declare target regprocedure;original text;marker text;replacement text;old_acl aclitem[];
begin
 target:='app.protect_invoice_history_classification()'::regprocedure;
 original:=replace(pg_get_functiondef(target),chr(13),'');select proacl into old_acl from pg_proc where oid=target;
 marker:='  financial_changed:=financial_changed or new.metadata->k is distinct from old.metadata->k;';
 replacement:='  if k=''invoice_direction'' or not app.has_invoice_total_correction_context(old.id) then'||chr(10)||marker||chr(10)||'  end if;';
 if (length(original)-length(replace(original,marker,'')))/length(marker)<>1 then raise exception 'history classification correction marker mismatch';end if;
 execute replace(original,marker,replacement);
 if (select proacl from pg_proc where oid=target) is distinct from old_acl then raise exception 'classification guard ACL changed';end if;

 target:='app.apply_owner_invoice_correction(uuid,uuid,uuid,timestamptz,jsonb,text,text)'::regprocedure;
 original:=replace(pg_get_functiondef(target),chr(13),'');select proacl into old_acl from pg_proc where oid=target;
 marker:=' if financial and (i.amount_paid>0';
 if (length(original)-length(replace(original,marker,'')))/length(marker)<>1 then raise exception 'paid correction guard marker mismatch';end if;
 original:=replace(original,marker,' if (p_values ?| array[''invoice_number'',''customer_id'',''invoice_direction''] or p_values?''currency'' and p_values->>''currency'' is distinct from i.currency) and (i.amount_paid>0');
 marker:=' if p_values?''custom_fields'' and not app.business_custom_fields_valid';
 replacement:=' if p_values ?| array[''line_items'',''subtotal'',''tax'',''discount'',''total_amount''] then
  perform 1 from public.payments p where p.workspace_id=p_workspace_id and p.invoice_id=i.id for update;
  if exists(select 1 from public.payments p where p.workspace_id=p_workspace_id and p.invoice_id=i.id
   and (nullif(btrim(p.external_provider),'''') is not null or nullif(btrim(p.external_payment_id),'''') is not null
    or nullif(btrim(p.metadata->>''accounting_provider''),'''') is not null)) then
   return jsonb_build_object(''ok'',false,''code'',''EXTERNAL_ACCOUNTING'');end if;
  if i.amount_paid<>(select coalesce(sum(p.amount) filter(where r.payment_id is null),0) from public.payments p
   left join public.payment_reversals r on r.workspace_id=p.workspace_id and r.payment_id=p.id
   where p.workspace_id=p_workspace_id and p.invoice_id=i.id) then
   return jsonb_build_object(''ok'',false,''code'',''LEDGER_MISMATCH'');end if;
 end if;
'||marker;
 if (length(original)-length(replace(original,marker,'')))/length(marker)<>1 then raise exception 'correction ledger verification marker mismatch';end if;
 original:=replace(original,marker,replacement);
 marker:=' m:=m||jsonb_build_object(''outstanding_amount'',total-i.amount_paid,';
 replacement:=' if total<=0 then return jsonb_build_object(''ok'',false,''code'',''INVALID_TOTAL'');end if;
 insert into app.invoice_total_correction_context(backend_pid,transaction_id,invoice_id) values(pg_backend_pid(),txid_current(),i.id);
 m:=m||jsonb_build_object(''outstanding_amount'',greatest(total-i.amount_paid,0),''overpayment_amount'',greatest(i.amount_paid-total,0),';
 if (length(original)-length(replace(original,marker,'')))/length(marker)<>1 then raise exception 'correction balance projection marker mismatch';end if;
 original:=replace(original,marker,replacement);
 marker:=' update public.invoices set invoice_number=label,';
 replacement:=' update public.invoices set status=case
  when p_values ?| array[''line_items'',''subtotal'',''tax'',''discount'',''total_amount''] and i.amount_paid>=total then ''paid''::public.invoice_status
  when p_values ?| array[''line_items'',''subtotal'',''tax'',''discount'',''total_amount''] and i.status::text=''paid'' then
   case when due<(clock_timestamp() at time zone coalesce((select s.default_timezone from public.workspace_settings s where s.workspace_id=p_workspace_id),''UTC''))::date then ''overdue''::public.invoice_status else ''sent''::public.invoice_status end
  else i.status end,invoice_number=label,';
 if (length(original)-length(replace(original,marker,'')))/length(marker)<>1 then raise exception 'correction status marker mismatch';end if;
 original:=replace(original,marker,replacement);
 marker:=' update public.invoice_lifecycle_proposals set state=''stale''';
 replacement:=' delete from app.invoice_total_correction_context where backend_pid=pg_backend_pid() and transaction_id=txid_current() and invoice_id=i.id;'||chr(10)||marker;
 if (length(original)-length(replace(original,marker,'')))/length(marker)<>1 then raise exception 'correction context cleanup marker mismatch';end if;
 execute replace(original,marker,replacement);
 if (select proacl from pg_proc where oid=target) is distinct from old_acl then raise exception 'correction function ACL changed';end if;
end; $correction$;
commit;
