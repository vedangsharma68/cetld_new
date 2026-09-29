-- Assign every newly created invoice a human-friendly number. Existing rows are
-- deliberately untouched, including legacy numbers that do not match this format.
create table if not exists public.invoice_number_sequences (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  invoice_year integer not null check (invoice_year between 2000 and 9999),
  last_value bigint not null check (last_value > 0),
  primary key (workspace_id, invoice_year)
);

alter table public.invoice_number_sequences enable row level security;
revoke all on public.invoice_number_sequences from anon, authenticated;

create or replace function public.assign_consistent_invoice_number()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  number_year integer := extract(year from coalesce(new.issue_date, current_date))::integer;
  next_value bigint;
  existing_number text;
  source_number text := nullif(btrim(new.invoice_number), '');
begin
  -- Assistant retries must resolve to the first invoice rather than consume a
  -- second number. The existing unique invoice-number constraint then makes the
  -- retry's INSERT a no-op.
  if new.metadata->>'assistant_idempotency_key' is not null then
    select invoice_number into existing_number
    from public.invoices
    where workspace_id = new.workspace_id
      and metadata->>'assistant_idempotency_key' = new.metadata->>'assistant_idempotency_key'
    limit 1;
    if existing_number is not null then
      new.invoice_number := existing_number;
      return new;
    end if;
  end if;

  insert into public.invoice_number_sequences(workspace_id, invoice_year, last_value)
  values (
    new.workspace_id,
    number_year,
    coalesce((
      select max(substring(invoice_number from 10)::bigint)
      from public.invoices
      where workspace_id = new.workspace_id
        and invoice_number ~ ('^INV-' || number_year::text || '-[0-9]{4,}$')
    ), 0) + 1
  )
  on conflict (workspace_id, invoice_year) do update
    set last_value = public.invoice_number_sequences.last_value + 1
  returning last_value into next_value;

  if source_number is not null and source_number <> 'AUTO' then
    new.metadata := coalesce(new.metadata, '{}'::jsonb)
      || jsonb_build_object('source_invoice_number', source_number);
  end if;
  new.invoice_number := 'INV-' || number_year::text || '-' || lpad(next_value::text, 4, '0');
  return new;
end;
$$;

revoke all on function public.assign_consistent_invoice_number() from public;

drop trigger if exists assign_consistent_invoice_number on public.invoices;
create trigger assign_consistent_invoice_number
before insert on public.invoices
for each row execute function public.assign_consistent_invoice_number();


-- Keep the paid-invoice RPC idempotent after generated numbers replace source numbers.
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

  select * into invoice_row
  from public.invoices
  where workspace_id = p_workspace_id
    and (metadata->>'assistant_idempotency_key' = p_idempotency_key
      or metadata->>'source_invoice_number' = p_invoice_number
      or invoice_number = p_invoice_number)
  for update;
  inserted_invoice := found;

  if not inserted_invoice then
    insert into public.invoices(workspace_id, customer_id, invoice_number, issue_date, due_date, currency, total_amount, amount_paid, status, notes, metadata)
    values (
      p_workspace_id, p_customer_id, p_invoice_number, p_issue_date, p_due_date, p_currency,
      p_total_amount, 0, 'draft'::public.invoice_status, p_notes,
      p_metadata || jsonb_build_object('assistant_idempotency_key', p_idempotency_key)
    )
    returning * into invoice_row;
    inserted_invoice := true;
  else
    inserted_invoice := false;
  end if;

  if not inserted_invoice then
    select * into invoice_row
    from public.invoices
    where workspace_id = p_workspace_id
      and (metadata->>'assistant_idempotency_key' = p_idempotency_key
        or metadata->>'source_invoice_number' = p_invoice_number
        or invoice_number = p_invoice_number)
    for update;
    if not found then
      raise exception 'Assistant invoice idempotency key was reused for a different invoice request' using errcode = '22023';
    end if;

    if invoice_row.customer_id <> p_customer_id then
      raise exception 'Assistant invoice idempotency key was reused for a different customer' using errcode = '22023';
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
