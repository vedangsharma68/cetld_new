-- Original-bound inspection only; no reminder authorization is enabled.
begin;
set local search_path=pg_catalog,public;
do $guard$
declare r record; p oid;
begin
 for r in select * from (values
 ('app.invoice_has_external_ledger(public.invoices)',array['80321aeca14fc9c5f333f74ab938ff238a99869b7645edabb91235a4e6dfecde']),
 ('app.reminder_external_read_matches(public.invoices,uuid)',array['cbe9a66a4d8fb965f211cae88723eb9fdaa89030185bc4776bc340f4f753058e']),
 ('app.reminder_local_status_payable(public.invoices)',array['cf7a45a506f61501b5c6f229e297a9d46585a0fd193c54278057206c66df67da']),
 ('public.cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid)',array['c6a34979b74fd37d80aa5f133bd2bd33157deda76a1fe374743d7351e070c6a3','515a146cfc808f3bcfc8290a9fa883d9d5d725649c696b656e34964cd868b687','7682bf8e74ce798442b3054f4672e888c952dce4fce70c31a80554606e1ab6ef']),
 ('public.cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz)',array['f8c636e89460d6107b0f009c893c1e02a2a5d155f10c9f6ee66ba405d01e5876','3f73ac01580326a2106f9529c8794f59607a205e7a8d86e96febe51095eabcb4','a642cdbd4d09e1aab02e2f02f21e3faf9948e40415520f187a87fb8bb121a8df']),
 ('public.cetld_update_accounting_connection_tokens(uuid,uuid,text,bigint,uuid,text,text,text,timestamptz,text,text,text)',array['fb4e3a8f82aabc64dd0ae525938341c9170336582af9c58737d816ae27497110'])
,
 ('app.has_invoice_total_correction_context(uuid)',array['5b53eee3ad8c388ff0f29929e11b072efd1bb57fcc66f9373965640bad6155ad']),
 ('app.apply_owner_invoice_correction(uuid,uuid,uuid,timestamptz,jsonb,text,text)',array['0f287de4b01b1a334d73e7d6e0e50ce292ad7419c1d6962167054d49d22d0449']),
 ('app.admit_accounting_invoice_insert()',array['881380398dd689c2096d45e8772edfed4364ce3b0dc6b11e0cfc1a341ecdc015']),
 ('app.track_accounting_connection_epoch()',array['546976eeae6c0629f5b27b1cd38eb64a8368bde26234c7cae1ebb9892fd25fc5']),
 ('public.cetld_zoho_operation_context(uuid,uuid)',array['8b6e02843dbe8bb44115e382ac02161e39921a70813d83b57bb56e4309785106']),
 ('public.cetld_reserve_zoho_export_operation(uuid,uuid,uuid,timestamptz,bigint,uuid)',array['ddb82ed9446b67650eac92ff12c79e397296facfe43a247888d21b6535c7e28d']),
 ('public.cetld_transition_zoho_export_operation(uuid,uuid,uuid,uuid,text,text)',array['8fa84c5c3e4593f5d47acbea993c3ffe03e0e5642dcc01c61f28700ec276011e'])
,
 ('app.fence_old_zoho_export_journal()',array['7251a86ee41eadfe50d2a018d29cbecb30921230db0ec68c134faf6de062fe3a']),
 ('app.fence_zoho_capture_candidate()',array['ac7167eca0e297b75fc36acf690189764e0054980e087e58eb000f32d3767d0e']),
 ('app.guard_zoho_bound_customer()',array['8f6e33e0cdf72a3497a3353a5e6d532f1b3ef51e71bd9c6a1dda31a46a667fef']),
 ('app.guard_zoho_bound_invoice()',array['6a3ea57db81270a75667c9bae7bb68af15c5fdb34230d6d23ac9a09dac07f58f']),
 ('app.guard_zoho_customer_origin()',array['15dd360f944bdf228b50d515eb2ef7fc3e836d3456d4df687cc952f80a68bc1a']),
 ('app.guard_zoho_origin()',array['67447599b7c2baef5c975ce47fc28a247b7a0429f71693eb64bb5eac3c42f706']),
 ('public.cetld_zoho_capture_completion_protocol(uuid,uuid,uuid,text,uuid,timestamp with time zone,bigint,uuid,text,text,uuid,text,text,numeric,numeric,numeric,text,date,date,text,text)',array['639642afa5ba4c61119d9146bdf1fac1a940de8b5f97838452e6faaa1fc5f8ec'])
 ) s(signature,hashes) loop
  p:=to_regprocedure(r.signature);
  if p is null or not encode(sha256(convert_to(pg_get_functiondef(p),'UTF8')),'hex')=any(r.hashes) then
   raise exception 'capture protocol predecessor source drift: %',r.signature;end if;
  if (select pg_get_userbyid(proowner) from pg_proc where oid=p)<>'postgres'
   or (r.signature like 'public.%' and not has_function_privilege('service_role',p,'EXECUTE')) then
   raise exception 'capture protocol predecessor owner/ACL drift: %',r.signature;end if;
  if exists(select 1 from pg_proc f cross join lateral aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a
   where f.oid=p and a.grantee<>f.proowner and
    (r.signature not like 'public.%' or a.grantee<>'service_role'::regrole or a.is_grantable)) then
   raise exception 'capture protocol predecessor ACL drift: %',r.signature;end if;
 end loop;
 -- Reuse only the installed private owner-correction permit. Neither JWT/GUC
 -- claims nor service DML may manufacture it. Preserve its existing ACL/schema.
 if not exists(select 1 from pg_class where oid='app.invoice_total_correction_context'::regclass
   and relkind='r' and pg_get_userbyid(relowner)='postgres')
  or exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   where c.oid='app.invoice_total_correction_context'::regclass and a.grantee<>c.relowner)
  or exists(select 1 from pg_attribute t cross join lateral aclexplode(t.attacl) a
   where t.attrelid='app.invoice_total_correction_context'::regclass and a.grantee<>'postgres'::regrole) then
  raise exception 'capture protocol owner correction context ACL drift';end if;
 if not (select relrowsecurity and pg_get_userbyid(relowner)='postgres' from pg_class where oid='public.cetld_accounting_connections'::regclass)
  or has_any_column_privilege('authenticated','public.cetld_accounting_connections','SELECT,INSERT,UPDATE')
  or has_table_privilege('authenticated','public.cetld_accounting_connections','DELETE')
  or has_any_column_privilege('anon','public.cetld_accounting_connections','SELECT,INSERT,UPDATE')
  or has_table_privilege('anon','public.cetld_accounting_connections','DELETE') then
  raise exception 'capture protocol connection protection drift';end if;
 if (select pg_get_userbyid(nspowner) from pg_namespace where nspname='app')<>'postgres' or
 exists(select 1 from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
  where n.nspname='app' and a.privilege_type='CREATE' and a.grantee<>n.nspowner) then
  raise exception 'capture protocol private schema CREATE drift';end if;
end $guard$;
do $private$
begin
 if (select count(*) from pg_class c where c.oid in ('app.zoho_invoice_origins'::regclass,'app.zoho_customer_origins'::regclass,
   'app.zoho_capture_completion'::regclass,'app.accounting_connection_epochs'::regclass) and c.relrowsecurity and pg_get_userbyid(c.relowner)='postgres')<>4
  or exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
   where c.oid in ('app.zoho_invoice_origins'::regclass,'app.zoho_customer_origins'::regclass,'app.zoho_capture_completion'::regclass,'app.accounting_connection_epochs'::regclass) and a.grantee<>c.relowner)
  or exists(select 1 from pg_attribute t cross join lateral aclexplode(t.attacl) a
   where t.attrelid in ('app.zoho_invoice_origins'::regclass,'app.zoho_customer_origins'::regclass,'app.zoho_capture_completion'::regclass,'app.accounting_connection_epochs'::regclass) and a.grantee<>'postgres'::regrole)
  or (select count(*) from (values
   ('app.zoho_invoice_origins','zoho_origin_immutable','app.guard_zoho_origin()'),
   ('app.zoho_customer_origins','zoho_customer_origin_immutable','app.guard_zoho_customer_origin()'),
   ('public.invoices','zoho_bound_invoice','app.guard_zoho_bound_invoice()'),
   ('public.customers','zoho_bound_customer','app.guard_zoho_bound_customer()'),
   ('public.invoices','zoho_capture_candidate_fence','app.fence_zoho_capture_candidate()'),
   ('app.zoho_export_operations','zoho_old_worker_capture_fence','app.fence_old_zoho_export_journal()')
  ) expected(relation,name,func) join pg_trigger t on t.tgrelid=to_regclass(expected.relation)
   and t.tgname=expected.name and t.tgfoid=to_regprocedure(expected.func) and t.tgenabled='O')<>6
  or (select encode(sha256(convert_to(jsonb_agg(jsonb_build_array(c.conrelid::regclass::text,c.contype,pg_get_constraintdef(c.oid),c.convalidated)
   order by c.conrelid::regclass::text,c.contype,pg_get_constraintdef(c.oid))::text,'UTF8')),'hex') from pg_constraint c
   where c.conrelid in ('app.zoho_invoice_origins'::regclass,'app.zoho_customer_origins'::regclass,'app.zoho_capture_completion'::regclass,'app.accounting_connection_epochs'::regclass))
   is distinct from '95dd43365ab952980fbc4eb85d669d5c206efc0df4ee17943e0be14d009018ea' then
  raise exception 'original read private protection drift';end if;
end $private$;

-- A SELECT-only prospective inspection context, never a reminder grant. No
-- generic verified flag, evidence persistence, list, lease or ledger mutation.
create function public.cetld_zoho_original_bound_read_context(p_owner_id uuid,p_workspace_id uuid,p_invoice_id uuid) returns jsonb
language sql stable security definer set search_path='' set timezone='UTC' as $$
 select jsonb_build_object('invoiceId',i.id,'workspaceId',i.workspace_id,'epochId',e.epoch_id,
  'accountId',b.account_id,'region',b.region,'apiDomain',c.api_domain,'accountsDomain',c.accounts_domain,
  'externalInvoiceId',b.external_invoice_id,'externalCustomerId',b.external_customer_id,
  'currency',i.currency,'total',i.total_amount::text,'paid',i.amount_paid::text,'balance',(i.total_amount-i.amount_paid)::text,
  'status',i.status,'date',i.issue_date,'dueDate',i.due_date,'reference',b.reference,'reminderAuthority',false,
  'fingerprint',encode(sha256(convert_to(jsonb_build_array(to_jsonb(i),to_jsonb(x),to_jsonb(b),to_jsonb(m),e.epoch_id,w.owner_id)::text,'UTF8')),'hex'))
 from public.invoices i join public.workspaces w on w.id=i.workspace_id
 join public.customers x on x.id=i.customer_id and x.workspace_id=i.workspace_id
 join app.zoho_invoice_origins b on b.invoice_id=i.id and b.owner_id=w.owner_id and b.workspace_id=i.workspace_id
 join app.zoho_customer_origins m on (m.owner_id,m.workspace_id,m.provider,m.account_id,m.region,m.customer_id,m.external_customer_id)
  =(b.owner_id,b.workspace_id,b.provider,b.account_id,b.region,b.customer_id,b.external_customer_id)
 join app.zoho_capture_completion o on o.invoice_id=i.id and o.operation_id=b.operation_id and o.state='captured' and o.outcome='captured'
 join public.cetld_accounting_connections c on c.owner_id=w.owner_id and c.workspace_id=i.workspace_id and c.provider=b.provider
 join app.accounting_connection_epochs e on e.owner_id=c.owner_id and e.workspace_id=c.workspace_id and e.provider=c.provider
 where auth.role()='service_role' and w.owner_id=p_owner_id and i.workspace_id=p_workspace_id and i.id=p_invoice_id
  and b.provider='zoho_books' and i.external_provider=b.provider and i.external_invoice_id=b.external_invoice_id and i.customer_id=b.customer_id
  and c.status='connected' and e.present and c.provider_account_id=b.account_id and c.region=b.region
  and b.account_id~'^[0-9]{1,40}$' and b.external_invoice_id~'^[0-9]{1,40}$' and b.external_customer_id~'^[0-9]{1,40}$'
  and b.region in ('com','eu','in','com.au','jp','ca','com.cn','sa')
  and c.api_domain='https://www.zohoapis.'||b.region and c.accounts_domain='https://accounts.zoho.'||b.region
  and i.deleted_at is null and not i.metadata?'test_invoice' and i.metadata->>'invoice_direction'='receivable'
  and i.status in ('sent','overdue') and i.status::text=b.provider_status and i.total_amount>0 and i.amount_paid=0
  and i.currency=b.currency and i.total_amount=b.total and i.amount_paid=b.paid and i.total_amount-i.amount_paid=b.balance
  and i.issue_date=b.invoice_date and i.due_date=b.due_date and i.due_date is not null
  and b.reference='cetld:'||i.id::text
  and (i.metadata->>'accounting_provider' is null or i.metadata->>'accounting_provider'=b.provider)
  and (i.metadata->>'bookkeeping_provider' is null or i.metadata->>'bookkeeping_provider'=b.provider)
  and (i.metadata->>'bookkeeping_record_id' is null or i.metadata->>'bookkeeping_record_id'=b.external_invoice_id);
$$;
revoke all on function public.cetld_zoho_original_bound_read_context(uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.cetld_zoho_original_bound_read_context(uuid,uuid,uuid) to service_role;
do $acl$
begin
 if exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  where p.oid='public.cetld_zoho_original_bound_read_context(uuid,uuid,uuid)'::regprocedure
   and (pg_get_userbyid(p.proowner)<>'postgres' or not p.prosecdef or a.grantee<>p.proowner and (a.grantee<>'service_role'::regrole or a.is_grantable))) then
  raise exception 'original read new function ACL drift';end if;
end $acl$;
commit;
