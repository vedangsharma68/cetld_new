-- OFFLINE TEST CONTRACT ONLY. Not a migration or production atomicity proof.
-- Intentionally omits deployment grants, global lock discipline, durable
-- reconciliation and STOP cancellation: those require separate approved DDL.
create table fixture_reminder_dispatches(claim_id uuid primary key,snapshot_hash text not null,callback_token text not null);
create function public.cetld_core_authorize_first_party_reminder(p_owner_id uuid,p_workspace_id uuid,p_claim_id uuid,p_snapshot jsonb,p_snapshot_hash text)
returns jsonb language plpgsql as $$
declare i public.invoices%rowtype; c public.cetld_core_automation_delivery_claims%rowtype; s public.workspace_settings%rowtype; token text;
begin
  if not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=p_owner_id) then return '{"authorized":false}';end if;
  select * into c from public.cetld_core_automation_delivery_claims where id=p_claim_id and workspace_id=p_workspace_id for update;
  select * into i from public.invoices where id=c.invoice_id and workspace_id=p_workspace_id for update;
  select * into s from public.workspace_settings where workspace_id=p_workspace_id for update;
  if c.id is null or c.status<>'sending' or c.lease_until<=now() or i.id is null
    or i.id::text<>p_snapshot->>'invoiceId' or i.customer_id::text<>p_snapshot->>'customerId'
    or i.deleted_at is not null or i.status<>'sent' or i.amount_paid>=i.total_amount
    or i.followup_state not in ('approved','active','scheduled')
    or i.automation_version<>c.invoice_version or i.automation_version::text<>p_snapshot->>'invoiceVersion'
    or i.updated_at<>(p_snapshot->>'invoiceUpdatedAt')::timestamptz
    or s.updated_at<>(p_snapshot->>'preferencesUpdatedAt')::timestamptz
    or i.metadata->>'approved_reminder_text'<>p_snapshot->>'body'
    or exists(select 1 from public.whatsapp_global_suppressions where phone=p_snapshot->>'phone')
    or exists(select 1 from public.whatsapp_suppressions where workspace_id=p_workspace_id and phone=p_snapshot->>'phone')
    or not exists(select 1 from public.customers x join public.whatsapp_consents o on o.customer_id=x.id and o.workspace_id=x.workspace_id
      where x.id=i.customer_id and x.workspace_id=p_workspace_id and x.phone=p_snapshot->>'phone'
      and o.phone=x.phone and o.revoked_at is null and o.source in ('verbal','inbound_message')
      and 'invoice_updates'=any(o.categories) and o.created_at=(p_snapshot->>'consentCreatedAt')::timestamptz)
    then return '{"authorized":false}';end if;
  token:=repeat(replace(gen_random_uuid()::text,'-',''),2);
  insert into fixture_reminder_dispatches values(p_claim_id,p_snapshot_hash,token) on conflict do nothing;
  if not found then return '{"authorized":false}';end if;
  return jsonb_build_object('authorized',true,'snapshot_hash',p_snapshot_hash,'callback_token',token);
end $$;
