-- Keep the privileged workspace bootstrap implementation outside the exposed
-- public API schema. The public RPC is an invoker-rights wrapper.
alter function public.create_workspace(text, text) set schema app;

revoke all on function app.create_workspace(text, text) from public, anon;
grant execute on function app.create_workspace(text, text) to authenticated;

create function public.create_workspace(p_name text, p_slug text default null)
returns public.workspaces
language sql security invoker set search_path = pg_catalog, public, app
as $$ select app.create_workspace(p_name, p_slug) $$;

revoke all on function public.create_workspace(text, text) from public, anon;
grant execute on function public.create_workspace(text, text) to authenticated;

create index workspaces_owner_id_idx on public.workspaces(owner_id);
create index workspace_members_user_id_idx on public.workspace_members(user_id);
create index invoices_workspace_customer_idx on public.invoices(workspace_id, customer_id);
create index payments_workspace_invoice_idx on public.payments(workspace_id, invoice_id);
create index invoice_files_workspace_invoice_idx on public.invoice_files(workspace_id, invoice_id);
