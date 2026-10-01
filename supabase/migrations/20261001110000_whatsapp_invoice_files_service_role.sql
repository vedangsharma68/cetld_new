-- Private, workspace-scoped originals for verified WhatsApp invoice ingestion.
-- Idempotent and safe to paste/run as one migration.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('invoice-files', 'invoice-files', false, 10485760,
  array['application/pdf','image/jpeg','image/png','image/webp']::text[])
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

grant select, insert on public.invoice_files to service_role;
grant select, update on public.invoices to service_role;
grant select, insert on storage.objects to service_role;
do $$
declare function_name text;
begin
  foreach function_name in array array[
    'set_updated_at', 'prevent_workspace_change', 'reject_unsupported_invoice_currency',
    'protect_settled_invoice_amounts', 'sync_core_followup_invoice',
    'invalidate_core_followup_approvals', 'currency_uses_two_decimal_precision',
    'core_safe_followup_time', 'core_safe_reminder_count', 'core_next_contact'
  ] loop
    if exists (select 1 from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
      where n.nspname='app' and p.proname=function_name) then
      execute pg_catalog.format('grant execute on all functions in schema app to service_role');
      exit;
    end if;
  end loop;
  if pg_catalog.to_regprocedure('public.record_invoice_payment(uuid,uuid,numeric,text,text,boolean)') is not null then
    execute 'grant execute on function public.record_invoice_payment(uuid,uuid,numeric,text,text,boolean) to service_role';
  end if;
end $$;
