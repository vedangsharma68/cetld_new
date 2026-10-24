-- Read evidence is supplied only by the trusted backend, scoped to one RPC.
-- No evidence table, verified flag, sync snapshot or invoice financial write.
begin;
create or replace function app.reminder_external_read_matches(i public.invoices,p_owner_id uuid) returns boolean
language plpgsql volatile security invoker set search_path='' as $$
declare e jsonb;
begin
 if auth.role() is distinct from 'service_role' then return false;end if;
 e:=nullif(current_setting('app.reminder_external_read',true),'')::jsonb;
 return coalesce(e->>'ownerId'=p_owner_id::text and e->>'workspaceId'=i.workspace_id::text and e->>'invoiceId'=i.id::text
   and e->>'provider' in ('zoho_books','quickbooks') and nullif(e->>'externalId','') is not null
   and e->>'provider'=coalesce(nullif(btrim(i.external_provider),''),nullif(btrim(i.metadata->>'accounting_provider'),''))
   and e->>'externalId'=coalesce(nullif(btrim(i.external_invoice_id),''),nullif(btrim(i.metadata->>'bookkeeping_record_id'),''))
   and e->'linkage'=jsonb_build_array(i.external_provider,i.external_invoice_id,i.metadata->>'accounting_provider',i.metadata->>'bookkeeping_record_id')
   and e->>'invoiceVersion'=i.automation_version::text and (e->>'invoiceUpdatedAt')::timestamptz=i.updated_at
   and e->>'status'=i.status::text and i.status='sent' and e->>'currency'=i.currency
   and (e->>'total')::numeric=i.total_amount and (e->>'paid')::numeric=i.amount_paid and i.total_amount>i.amount_paid
   and (e->>'startedAt')::timestamptz between clock_timestamp()-interval '15 seconds' and clock_timestamp(),false);
exception when others then return false;
end $$;
revoke all on function app.reminder_external_read_matches(public.invoices,uuid) from public,anon,authenticated,service_role;

-- Patch only the external refusal. Payment audit and balance checks remain intact.
-- The approved reminder feature is optional in historical fixture installations.
do $patch$
declare target regprocedure; def text;marker text;acl aclitem[];args text;names text;wrapper text;
begin
 target:=to_regprocedure('public.cetld_core_check_local_reminder_payment(uuid,uuid,uuid)');
 if target is not null then
  def:=pg_get_functiondef(target);select proacl into acl from pg_proc where oid=target;
  marker:='then return ''{"ok":false,"reason":"external_accounting_required"}'';end if;';
  if strpos(def,'app.reminder_external_read_matches')=0 then
   if (length(def)-length(replace(def,marker,'')))/length(marker)<>1 then raise exception 'external reminder refusal patch point changed';end if;
   def:=replace(def,'if nullif(btrim(i.external_provider)', 'if (nullif(btrim(i.external_provider)');
   execute replace(def,marker,') and not app.reminder_external_read_matches(i,p_owner_id) '||marker);
  end if;
  if (select proacl from pg_proc where oid=target) is distinct from acl then raise exception 'payment checker ACL changed';end if;
 end if;
 -- Separate names preserve the old fail-closed API and every original gate/ACL.
 -- Set evidence transaction-locally, call the unchanged entrypoint, then restore.
 for target in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in ('whatsapp_owner_reminder','cetld_core_authorize_first_party_reminder','cetld_core_check_local_reminder_payment')
 loop
  select pg_get_function_arguments(p.oid),array_to_string(p.proargnames,','),p.proname||'_with_external_read' into args,names,wrapper from pg_proc p where p.oid=target;
  execute format('create or replace function public.%I(%s,p_external_read jsonb default null) returns jsonb language plpgsql security definer set search_path='''' as $body$
    declare previous text:=current_setting(''app.reminder_external_read'',true); result jsonb;
    begin
      if auth.role() is distinct from ''service_role'' then raise insufficient_privilege;end if;
      perform set_config(''app.reminder_external_read'',coalesce(p_external_read::text,''''),true);
      result:=public.%I(%s);
      perform set_config(''app.reminder_external_read'',coalesce(previous,''''),true);
      return result;
    exception when others then
      perform set_config(''app.reminder_external_read'',coalesce(previous,''''),true);raise;
    end $body$',wrapper,args,(select proname from pg_proc where oid=target),names);
  select pg_get_function_identity_arguments(p.oid) into args from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=wrapper;
  execute format('revoke all on function public.%I(%s) from public,anon,authenticated',wrapper,args);
  execute format('grant execute on function public.%I(%s) to service_role',wrapper,args);
 end loop;
end $patch$;
commit;
