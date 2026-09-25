-- Settlement fields are owned by the atomic payment RPCs. Ordinary invoice
-- creation, editing, metadata, and bookkeeping synchronization remain writable.
revoke insert, update on public.invoices from authenticated;
grant insert (workspace_id, customer_id, invoice_number, issue_date, due_date, currency, total_amount, notes, metadata)
  on public.invoices to authenticated;
grant update (customer_id, invoice_number, issue_date, due_date, currency, total_amount, notes, metadata,
  external_provider, external_invoice_id, last_synced_at, sync_status, last_sync_error)
  on public.invoices to authenticated;

create or replace function app.currency_uses_two_decimal_precision(p_currency text)
returns boolean
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select coalesce(p_currency = any (array['INR','USD','EUR','GBP','AED','SGD','AUD','CAD','CHF']::text[]), false)
$$;

grant execute on function app.currency_uses_two_decimal_precision(text) to authenticated;

create or replace function app.reject_unsupported_invoice_currency()
returns trigger
language plpgsql
set search_path = pg_catalog, public, app
as $$
declare
  requested_currency text;
  old_currency text;
begin
  requested_currency := to_jsonb(NEW)->>TG_ARGV[0];
  if TG_OP = 'UPDATE' then
    old_currency := to_jsonb(OLD)->>TG_ARGV[0];
    if requested_currency is not distinct from old_currency then
      return NEW;
    end if;
  end if;
  if not app.currency_uses_two_decimal_precision(requested_currency) then
    raise exception 'CETLD supports only two-decimal currencies: INR, USD, EUR, GBP, AED, SGD, AUD, CAD, and CHF. Currencies such as JPY, KWD, and BHD are not supported.'
      using errcode = '22023';
  end if;
  return NEW;
end;
$$;

create trigger invoices_currency_precision_guard
  before insert or update of currency on public.invoices
  for each row execute function app.reject_unsupported_invoice_currency('currency');

create trigger workspace_default_currency_precision_guard
  before insert or update of default_currency on public.workspace_settings
  for each row execute function app.reject_unsupported_invoice_currency('default_currency');

create or replace function app.protect_settled_invoice_amounts()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if not app.currency_uses_two_decimal_precision(OLD.currency)
     and (NEW.total_amount is distinct from OLD.total_amount or NEW.currency is distinct from OLD.currency) then
    raise exception 'This legacy invoice uses unsupported currency precision. Keep its saved amount unchanged and create a corrected invoice in a supported currency.'
      using errcode = '22023';
  end if;
  if (OLD.amount_paid > 0 or OLD.status::text in ('paid', 'void', 'cancelled'))
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

create or replace function app.reject_payment_for_unsupported_invoice_currency()
returns trigger
language plpgsql
set search_path = pg_catalog, public, app
as $$
declare
  invoice_currency text;
begin
  select currency into invoice_currency
  from public.invoices
  where workspace_id = NEW.workspace_id and id = NEW.invoice_id;
  if invoice_currency is not null and not app.currency_uses_two_decimal_precision(invoice_currency) then
    raise exception 'Payments cannot be recorded on this legacy invoice because CETLD supports only two-decimal currencies. Convert its saved balance to a supported currency first.'
      using errcode = '22023';
  end if;
  return NEW;
end;
$$;

create trigger payments_invoice_currency_precision_guard
  before insert on public.payments
  for each row execute function app.reject_payment_for_unsupported_invoice_currency();
