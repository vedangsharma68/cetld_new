-- Preserve submitted scale as unconstrained NUMERIC, then reject unsupported
-- precision explicitly. NUMERIC(18,2) rounds before CHECK constraints can see it.
drop trigger if exists invoices_settlement_amount_guard on public.invoices;

alter table public.invoices
  alter column total_amount type numeric using total_amount::numeric,
  alter column amount_paid type numeric using amount_paid::numeric;

alter table public.payments
  alter column amount type numeric using amount::numeric;

alter table public.invoices
  add constraint invoices_total_amount_two_decimal_check
    check (scale(total_amount) <= 2 and total_amount < 10000000000000000),
  add constraint invoices_amount_paid_two_decimal_check
    check (scale(amount_paid) <= 2 and amount_paid < 10000000000000000);

alter table public.payments
  add constraint payments_amount_two_decimal_check
    check (scale(amount) <= 2 and amount < 10000000000000000);

-- Invoice rows and payment history are a single financial record. Authenticated
-- clients retain reads and safe column edits, but cannot delete invoice rows.
revoke delete on public.invoices from authenticated;

-- Use payment history as the source of truth for locking repricing, including
-- legacy invoices whose amount_paid/status snapshot does not match their ledger.
create or replace function app.protect_settled_invoice_amounts()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, app
as $$
begin
  if not app.currency_uses_two_decimal_precision(OLD.currency)
     and (NEW.total_amount is distinct from OLD.total_amount or NEW.currency is distinct from OLD.currency) then
    raise exception 'This legacy invoice uses unsupported currency precision. Keep its saved amount unchanged and create a corrected invoice in a supported currency.'
      using errcode = '22023';
  end if;
  if (OLD.amount_paid > 0
      or OLD.status::text in ('paid', 'void', 'cancelled')
      or exists (
        select 1 from public.payments p
        where p.workspace_id = OLD.workspace_id and p.invoice_id = OLD.id
      ))
     and (NEW.total_amount is distinct from OLD.total_amount or NEW.currency is distinct from OLD.currency) then
    raise exception 'An invoice amount or currency cannot change after a payment is recorded or the invoice becomes terminal.'
      using errcode = '22023';
  end if;
  return NEW;
end;
$$;

create trigger invoices_settlement_amount_guard
  before update of total_amount, currency on public.invoices
  for each row execute function app.protect_settled_invoice_amounts();

-- Preserve the scale-free payment input through RPC validation as well; the
-- table CHECKs alone cannot see it after assignment to a local value.
create or replace function public.record_invoice_payment(
  p_workspace_id uuid,
  p_invoice_id uuid,
  p_amount numeric,
  p_idempotency_key text,
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
  balance numeric;
  applied_amount numeric;
  normalized_reference text := nullif(btrim(p_reference), '');
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_workspace_id is null or not app.is_workspace_member(p_workspace_id, caller) then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 200 then
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
    if p_settle_remaining is null
       or (p_settle_remaining and p_amount is not null)
       or existing_payment.settle_remaining is distinct from p_settle_remaining
       or existing_payment.reference is distinct from normalized_reference
       or (not p_settle_remaining and existing_payment.amount is distinct from p_amount) then
      raise exception 'idempotency key was reused with a different payment request' using errcode = '22023';
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
    if p_amount is null or p_amount <= 0 or scale(p_amount) > 2 then
      raise exception 'payment amount must be positive with at most two decimal places' using errcode = '22023';
    end if;
    if p_amount > balance then
      raise exception 'payment cannot exceed the invoice balance' using errcode = '22023';
    end if;
    applied_amount := p_amount;
  end if;

  insert into public.payments(workspace_id, invoice_id, amount, reference, idempotency_key, settle_remaining)
  values (p_workspace_id, p_invoice_id, applied_amount, normalized_reference, p_idempotency_key, p_settle_remaining)
  on conflict (workspace_id, idempotency_key) where idempotency_key is not null do nothing
  returning * into created_payment;

  if not found then
    select * into existing_payment
    from public.payments
    where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
    if p_settle_remaining is null
       or (p_settle_remaining and p_amount is not null)
       or existing_payment.invoice_id <> p_invoice_id
       or existing_payment.settle_remaining is distinct from p_settle_remaining
       or existing_payment.reference is distinct from normalized_reference
       or (not p_settle_remaining and existing_payment.amount is distinct from p_amount) then
      raise exception 'idempotency key was reused with a different payment request' using errcode = '22023';
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

revoke all on function public.record_invoice_payment(uuid, uuid, numeric, text, text, boolean) from public, anon, authenticated;
grant execute on function public.record_invoice_payment(uuid, uuid, numeric, text, text, boolean) to authenticated;

-- The RPC already validates the payment argument before assigning it to a
-- fixed-scale local variable. This explicit RPC check prevents the other
-- invoice monetary input from being rounded by the former column typemod.
create or replace function public.create_paid_assistant_invoice(
  p_workspace_id uuid,
  p_customer_id uuid,
  p_invoice_number text,
  p_issue_date date,
  p_due_date date,
  p_currency text,
  p_total_amount numeric,
  p_notes text,
  p_metadata jsonb,
  p_idempotency_key text,
  p_reference text
) returns public.invoices
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  caller uuid := auth.uid();
  invoice_row public.invoices;
  created_payment public.payments;
  inserted_invoice boolean;
  payment_count integer;
begin
  if caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_workspace_id is null or not app.is_workspace_member(p_workspace_id, caller) then
    raise exception 'workspace access denied' using errcode = '42501';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 100
     or p_metadata is null or jsonb_typeof(p_metadata) <> 'object'
     or p_metadata->>'assistant_idempotency_key' is distinct from p_idempotency_key then
    raise exception 'invalid Assistant invoice idempotency request' using errcode = '22023';
  end if;
  if p_total_amount is null or p_total_amount <= 0 then
    raise exception 'already-paid invoice requires a positive balance' using errcode = '22023';
  end if;
  if scale(p_total_amount) > 2 or p_total_amount >= 10000000000000000 then
    raise exception 'invoice amount must use at most two decimal places and fit the supported amount range' using errcode = '22023';
  end if;
  if not exists (select 1 from public.customers where workspace_id = p_workspace_id and id = p_customer_id) then
    raise exception 'customer not found in this workspace' using errcode = '42501';
  end if;

  insert into public.invoices(workspace_id, customer_id, invoice_number, issue_date, due_date, currency, total_amount, amount_paid, status, notes, metadata)
  values (
    p_workspace_id, p_customer_id, p_invoice_number, p_issue_date, p_due_date, p_currency,
    p_total_amount, 0, 'draft'::public.invoice_status, p_notes,
    p_metadata || jsonb_build_object('assistant_idempotency_key', p_idempotency_key)
  )
  on conflict (workspace_id, invoice_number) do nothing
  returning * into invoice_row;
  inserted_invoice := found;

  if not inserted_invoice then
    select * into invoice_row
    from public.invoices
    where workspace_id = p_workspace_id and invoice_number = p_invoice_number
    for update;
    if not found
       or invoice_row.metadata->>'assistant_idempotency_key' is distinct from p_idempotency_key
       or invoice_row.customer_id <> p_customer_id
       or invoice_row.issue_date <> p_issue_date
       or invoice_row.due_date is distinct from p_due_date
       or invoice_row.currency <> p_currency
       or invoice_row.total_amount <> p_total_amount
       or invoice_row.notes is distinct from p_notes then
      raise exception 'Assistant invoice idempotency key was reused for a different invoice request' using errcode = '22023';
    end if;

    select count(*)::integer into payment_count
    from public.payments
    where workspace_id = p_workspace_id and invoice_id = invoice_row.id;
    if invoice_row.status = 'paid'::public.invoice_status
       and invoice_row.amount_paid = invoice_row.total_amount
       and payment_count = 0 then
      insert into public.payments(workspace_id, invoice_id, amount, reference, idempotency_key, settle_remaining)
      values (p_workspace_id, invoice_row.id, invoice_row.total_amount, nullif(btrim(p_reference), ''), p_idempotency_key, true)
      returning * into created_payment;
      update public.invoices
      set metadata = metadata || jsonb_build_object('followup_state', 'cancelled', 'next_follow_up_at', null)
      where id = invoice_row.id and workspace_id = p_workspace_id
      returning * into invoice_row;
      return invoice_row;
    end if;
  end if;

  perform public.record_invoice_payment(p_workspace_id, invoice_row.id, null, p_idempotency_key, p_reference, true);
  select * into invoice_row
  from public.invoices
  where workspace_id = p_workspace_id and id = invoice_row.id;
  return invoice_row;
end;
$$;

revoke all on function public.create_paid_assistant_invoice(uuid, uuid, text, date, date, text, numeric, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function public.create_paid_assistant_invoice(uuid, uuid, text, date, date, text, numeric, text, jsonb, text, text) to authenticated;
