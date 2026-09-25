begin;

alter table public.cetld_accounting_connections
  add column if not exists organization_name text,
  add column if not exists accounts_domain text,
  add column if not exists last_synced_at timestamptz,
  add column if not exists last_sync_status text not null default 'never',
  add column if not exists last_sync_error text,
  add column if not exists connection_problem text;

alter table public.cetld_accounting_connections
  drop constraint if exists cetld_accounting_connections_status_check,
  add constraint cetld_accounting_connections_status_check
    check (status in ('connecting','needs_organization','connected','needs_attention','disconnected')),
  add constraint cetld_accounting_connections_last_sync_status_check
    check (last_sync_status in ('never','syncing','synced','failed'));

alter table public.cetld_accounting_sync_records
  drop constraint if exists cetld_accounting_sync_records_record_type_check,
  add constraint cetld_accounting_sync_records_record_type_check
    check (record_type in ('customer','invoice','payment'));

alter table public.customers
  add column if not exists external_provider text,
  add column if not exists external_customer_id text,
  add column if not exists last_synced_at timestamptz,
  add column if not exists sync_status text not null default 'local',
  add column if not exists last_sync_error text;

alter table public.invoices
  add column if not exists external_provider text,
  add column if not exists external_invoice_id text,
  add column if not exists last_synced_at timestamptz,
  add column if not exists sync_status text not null default 'local',
  add column if not exists last_sync_error text;

alter table public.payments
  add column if not exists external_provider text,
  add column if not exists external_payment_id text,
  add column if not exists last_synced_at timestamptz,
  add column if not exists sync_status text not null default 'local',
  add column if not exists last_sync_error text;

alter table public.customers
  add constraint customers_external_provider_check
    check (external_provider is null or external_provider in ('zoho_books','quickbooks')),
  add constraint customers_sync_status_check
    check (sync_status in ('local','pending','synced','failed'));

alter table public.invoices
  add constraint invoices_external_provider_check
    check (external_provider is null or external_provider in ('zoho_books','quickbooks')),
  add constraint invoices_sync_status_check
    check (sync_status in ('local','pending','synced','failed'));

alter table public.payments
  add constraint payments_external_provider_check
    check (external_provider is null or external_provider in ('zoho_books','quickbooks')),
  add constraint payments_sync_status_check
    check (sync_status in ('local','pending','synced','failed'));

create unique index if not exists customers_workspace_external_provider_id_key
  on public.customers(workspace_id, external_provider, external_customer_id);

create unique index if not exists invoices_workspace_external_provider_id_key
  on public.invoices(workspace_id, external_provider, external_invoice_id);

create unique index if not exists payments_workspace_external_provider_id_key
  on public.payments(workspace_id, external_provider, external_payment_id);

commit;
