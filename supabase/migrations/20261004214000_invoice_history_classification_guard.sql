-- LOCAL PROPOSAL. Adds a guard only; no existing rows or grants are changed.
begin;
create function app.protect_invoice_history_classification() returns trigger
language plpgsql security definer set search_path='' as $$
declare financial_changed boolean;money_changed boolean;k text;subtotal numeric;tax numeric;discount numeric;item_sum numeric:=0;
begin
 financial_changed:=new.customer_id is distinct from old.customer_id or new.invoice_number is distinct from old.invoice_number;
 foreach k in array array['line_items','subtotal','subtotal_minor','tax','tax_minor','discount','discount_minor','invoice_direction'] loop
  financial_changed:=financial_changed or new.metadata->k is distinct from old.metadata->k;
 end loop;
 -- The UPDATE has already locked this invoice. Payment insertion and the
 -- reopening workflow take the same invoice lock before altering the ledger.
 if financial_changed and (old.amount_paid>0 or old.status::text='paid'
  or exists(select 1 from public.payments p where p.workspace_id=old.workspace_id and p.invoice_id=old.id)
  or exists(select 1 from public.payment_reversals r where r.workspace_id=old.workspace_id and r.invoice_id=old.id)) then
  raise exception 'invoice customer, number, itemization and financial classification are immutable after payment history; use a separately reviewed financial correction workflow' using errcode='22023';
 end if;
 money_changed:=new.total_amount is distinct from old.total_amount;
 foreach k in array array['line_items','subtotal','subtotal_minor','tax','tax_minor','discount','discount_minor'] loop
  money_changed:=money_changed or new.metadata->k is distinct from old.metadata->k;
 end loop;
 if money_changed then
  -- Benign corrections to legacy invoices do not revalidate unrelated old
  -- extraction. Monetary changes must form one coherent UPDATE everywhere.
  if new.metadata?'line_items' then item_sum:=app.invoice_correction_line_sum(new.metadata->'line_items');end if;
  foreach k in array array['subtotal','tax','discount'] loop
   if new.metadata->>k is null and new.metadata->>(k||'_minor') is not null
    and (new.metadata->>(k||'_minor'))::numeric<>trunc((new.metadata->>(k||'_minor'))::numeric) then
    raise exception 'invoice financial components must reconcile with the total' using errcode='22023';end if;
  end loop;
  tax:=coalesce((new.metadata->>'tax')::numeric,round((new.metadata->>'tax_minor')::numeric/100,2),0);
  discount:=coalesce((new.metadata->>'discount')::numeric,round((new.metadata->>'discount_minor')::numeric/100,2),0);
  subtotal:=coalesce((new.metadata->>'subtotal')::numeric,round((new.metadata->>'subtotal_minor')::numeric/100,2),
   case when new.metadata?'line_items' and jsonb_array_length(new.metadata->'line_items')>0 then item_sum else new.total_amount-tax+discount end);
  if subtotal<0 or tax<0 or discount<0 or subtotal>=10000000000000000 or tax>=10000000000000000 or discount>=10000000000000000
   or scale(subtotal)>2 or scale(tax)>2 or scale(discount)>2 or subtotal+tax-discount<>new.total_amount
   or (new.metadata?'line_items' and jsonb_array_length(new.metadata->'line_items')>0 and item_sum<>subtotal) then
   raise exception 'invoice financial components must reconcile with the total' using errcode='22023';end if;
 end if;
 return new;
end; $$;
revoke all on function app.protect_invoice_history_classification() from public,anon,authenticated,service_role;
create trigger invoices_history_classification_guard before update on public.invoices
for each row execute function app.protect_invoice_history_classification();
commit;
