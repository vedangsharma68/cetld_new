alter table public.cetld_accounting_connections drop constraint cetld_accounting_connections_provider_check;
alter table public.cetld_accounting_connections add constraint cetld_accounting_connections_provider_check check (provider in ('zoho_books','quickbooks'));
alter table public.cetld_accounting_oauth_states drop constraint cetld_accounting_oauth_states_provider_check;
alter table public.cetld_accounting_oauth_states add constraint cetld_accounting_oauth_states_provider_check check (provider in ('zoho_books','quickbooks'));
alter table public.cetld_accounting_sync_records drop constraint cetld_accounting_sync_records_provider_check;
alter table public.cetld_accounting_sync_records add constraint cetld_accounting_sync_records_provider_check check (provider in ('zoho_books','quickbooks'));