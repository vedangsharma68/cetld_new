-- Keep payment history and invoice balances consistent across retries and concurrent requests.
alter table public.payments add column idempotency_key uuid;

create unique index payments_workspace_idempotency_key_unique
  on public.payments (workspace_id, idempotency_key)
  where idempotency_key is not null;

create or replace function public.record_invoice_payment(
  p_workspace_id uuid,
  p_invoice_id uuid,
  p_amount numeric,
  p_idempotency_key uuid,
  p_reference text,
  p_settle_remaining boolean
) returns public.payments
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  caller uuid := auth.uid();
  invoice_row public.invoices;
  existing_payment public.payments;
  created_payment public.payments;
  balance numeric(18,2);
  applied_amount numeric(18,2);
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_workspace_id is null or not app.is_workspace_member(p_workspace_id, caller) then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;
  if p_idempotency_key is null then
    raise exception 'idempotency key is required' using errcode = '22023';
  end if;

  select * into invoice_row
  from public.invoices
  where workspace_id = p_workspace_id and id = p_invoice_id
  for update;
  if not found then
    raise exception 'invoice not found in this workspace' using errcode = '42501';
  end if;

  select * into existing_payment
  from public.payments
  where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
  if found then
    if existing_payment.invoice_id <> p_invoice_id then
      raise exception 'idempotency key was already used for another invoice' using errcode = '22023';
    end if;
    return existing_payment;
  end if;

  if invoice_row.status in ('void'::public.invoice_status, 'cancelled'::public.invoice_status) then
    raise exception 'cannot record payment for a void or cancelled invoice' using errcode = '22023';
  end if;
  balance := invoice_row.total_amount - invoice_row.amount_paid;
  if balance <= 0 or invoice_row.status = 'paid'::public.invoice_status then
    raise exception 'invoice is already paid' using errcode = '22023';
  end if;

  if p_settle_remaining then
    if p_amount is not null then
      raise exception 'settling the remaining balance does not accept an amount' using errcode = '22023';
    end if;
    applied_amount := balance;
  else
    if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) then
      raise exception 'payment amount must be positive with at most two decimal places' using errcode = '22023';
    end if;
    if p_amount > balance then
      raise exception 'payment cannot exceed the invoice balance' using errcode = '22023';
    end if;
    applied_amount := p_amount;
  end if;

  insert into public.payments(workspace_id, invoice_id, amount, reference, idempotency_key)
  values (p_workspace_id, p_invoice_id, applied_amount, nullif(btrim(p_reference), ''), p_idempotency_key)
  on conflict (workspace_id, idempotency_key) where idempotency_key is not null do nothing
  returning * into created_payment;

  if not found then
    select * into existing_payment
    from public.payments
    where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
    if existing_payment.invoice_id <> p_invoice_id then
      raise exception 'idempotency key was already used for another invoice' using errcode = '22023';
    end if;
    return existing_payment;
  end if;

  update public.invoices
  set amount_paid = amount_paid + applied_amount,
      status = case when amount_paid + applied_amount = total_amount then 'paid'::public.invoice_status else status end,
      metadata = case when amount_paid + applied_amount = total_amount
        then metadata || jsonb_build_object('followup_state', 'cancelled', 'next_follow_up_at', null)
        else metadata end
  where workspace_id = p_workspace_id and id = p_invoice_id;

  return created_payment;
end;
$$;

revoke all on function public.record_invoice_payment(uuid, uuid, numeric, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.record_invoice_payment(uuid, uuid, numeric, uuid, text, boolean) to authenticated;

-- Payment history must only be changed with the invoice balance in the RPC transaction.
revoke insert, update, delete on public.payments from authenticated;
grant select on public.payments to authenticated;
