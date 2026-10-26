-- Disabled origin capture; prospective one-shot completion protocol only.
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
 ('app.admit_accounting_invoice_insert()',array['881380398dd689c2096d45e8772edfed4364ce3b0dc6b11e0cfc1a341ecdc015']),
 ('app.track_accounting_connection_epoch()',array['546976eeae6c0629f5b27b1cd38eb64a8368bde26234c7cae1ebb9892fd25fc5']),
 ('public.cetld_zoho_operation_context(uuid,uuid)',array['8b6e02843dbe8bb44115e382ac02161e39921a70813d83b57bb56e4309785106']),
 ('public.cetld_reserve_zoho_export_operation(uuid,uuid,uuid,timestamptz,bigint,uuid)',array['ddb82ed9446b67650eac92ff12c79e397296facfe43a247888d21b6535c7e28d']),
 ('public.cetld_transition_zoho_export_operation(uuid,uuid,uuid,uuid,text,text)',array['8fa84c5c3e4593f5d47acbea993c3ffe03e0e5642dcc01c61f28700ec276011e'])
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

-- New cutover. This table NEVER stores a verified binding, and cannot be
-- upgraded into one. No preinstallation or PR201 admission is copied here.
create table app.zoho_capture_completion (
 invoice_id uuid primary key, birth_id uuid not null unique default gen_random_uuid(),
 owner_id uuid not null,workspace_id uuid not null,
 state text not null check(state in ('eligible','reserved','started','excluded','completed_unverified')),
 reason text,operation_id uuid unique,epoch_id uuid,attempted_account_id text,attempted_region text,
 invoice_hash text,customer_hash text,deadline timestamptz,result_external_id text,result_hash text,
 outcome text check(outcome in ('created_unverified','duplicate_unverified','unknown_unverified')),
 inserted_at timestamptz not null default clock_timestamp()
);
create table app.zoho_capture_write_context (
 transaction_id bigint not null,invoice_id uuid not null,primary key(transaction_id,invoice_id)
);
alter table app.zoho_capture_completion enable row level security;
alter table app.zoho_capture_write_context enable row level security;
revoke all on app.zoho_capture_completion,app.zoho_capture_write_context from public,anon,authenticated,service_role;

create function app.fence_zoho_capture_candidate() returns trigger
language plpgsql security definer set search_path='' as $$
declare eligible boolean;old_sync jsonb;new_sync jsonb;
begin
 if tg_op='INSERT' then
  eligible:=not app.invoice_has_external_ledger(new) and new.deleted_at is null
   and new.metadata->>'invoice_direction'='receivable' and new.amount_paid=0
   and new.status in ('draft','sent','overdue') and not new.metadata ? 'test_invoice'
   and new.invoice_number not like 'CETLD-TEST-%' and coalesce(new.metadata->>'source_invoice_number','') not like 'CETLD-TEST-%'
   and not (new.metadata ? 'bookkeeping_sync_attempted_at' or new.metadata ? 'bookkeeping_sync_attempts')
   and coalesce(new.metadata->>'bookkeeping_sync_status','pending')='pending';
  insert into app.zoho_capture_completion(invoice_id,owner_id,workspace_id,state,reason)
   select new.id,w.owner_id,new.workspace_id,case when eligible then 'eligible' else 'excluded' end,
    case when eligible then null else 'not_candidate' end from public.workspaces w where w.id=new.workspace_id
   on conflict(invoice_id) do update set state='excluded',reason='reused_id';
  return new;
 end if;
 if exists(select 1 from app.zoho_capture_write_context c where c.transaction_id=txid_current() and c.invoice_id=old.id) then return new;end if;
 if tg_op='DELETE' then
  update app.zoho_capture_completion set state='excluded',reason='deleted' where invoice_id=old.id;
  return old;
 end if;
 select coalesce(jsonb_object_agg(key,value),'{}') into old_sync from jsonb_each(old.metadata) where key like 'bookkeeping_%';
 select coalesce(jsonb_object_agg(key,value),'{}') into new_sync from jsonb_each(new.metadata) where key like 'bookkeeping_%';
 update app.zoho_capture_completion set state='excluded',reason='uncontrolled_write'
 where invoice_id=old.id and state<>'excluded' and (
  (state in ('reserved','started','completed_unverified') and to_jsonb(new) is distinct from to_jsonb(old))
  or new_sync is distinct from old_sync or app.invoice_has_external_ledger(new)
  or new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id
  or new.deleted_at is not null or new.metadata ? 'test_invoice' or new.metadata->>'invoice_direction'='payable');
 return new;
end; $$;
revoke all on function app.fence_zoho_capture_candidate() from public,anon,authenticated,service_role;
create trigger zoho_capture_candidate_fence after insert or update or delete on public.invoices
 for each row execute function app.fence_zoho_capture_candidate();

-- PR201 workers can call their old journal without touching invoice metadata.
-- That first observed old operation must burn the NEW cutover permanently too.
create function app.fence_old_zoho_export_journal() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 update app.zoho_capture_completion set state='excluded',reason='old_worker_attempt'
 where invoice_id=new.invoice_id and state<>'excluded';
 return new;
end; $$;
revoke all on function app.fence_old_zoho_export_journal() from public,anon,authenticated,service_role;
create trigger zoho_old_worker_capture_fence after insert on app.zoho_export_operations
 for each row execute function app.fence_old_zoho_export_journal();

create function public.cetld_probe_zoho_capture_completion(p_workspace_id uuid,p_invoice_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('ownerId',w.owner_id,'eligible',true,'originCaptured',false)
 from app.zoho_capture_completion o join public.invoices i on i.id=o.invoice_id and i.workspace_id=o.workspace_id
 join public.workspaces w on w.id=i.workspace_id and w.owner_id=o.owner_id
 where i.workspace_id=p_workspace_id and i.id=p_invoice_id and o.state='eligible';
$$;
revoke all on function public.cetld_probe_zoho_capture_completion(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.cetld_probe_zoho_capture_completion(uuid,uuid) to service_role;

create function public.cetld_zoho_capture_completion_protocol(p_owner_id uuid,p_workspace_id uuid,p_invoice_id uuid,
 p_action text,p_operation_id uuid default null,p_expected_updated_at timestamptz default null,
 p_expected_version bigint default null,p_expected_epoch uuid default null,p_external_id text default null,p_outcome text default null)
returns jsonb language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare i public.invoices;cust public.customers;c public.cetld_accounting_connections;e app.accounting_connection_epochs;
 o app.zoho_capture_completion;valid boolean;
begin
 if p_action is null or p_action not in ('reserve','start','complete','abort') then raise exception 'CAPTURE_PROTOCOL_INPUT';end if;
 -- Consistent order: invoice -> customer -> connection -> epoch -> protocol.
 select v.* into i from public.invoices v join public.workspaces w on w.id=v.workspace_id
 where v.id=p_invoice_id and v.workspace_id=p_workspace_id and w.owner_id=p_owner_id for update of v;
 if i.id is null then raise exception 'CAPTURE_PROTOCOL_SCOPE';end if;
 select * into cust from public.customers where id=i.customer_id and workspace_id=p_workspace_id for share;
 select * into c from public.cetld_accounting_connections where owner_id=p_owner_id and workspace_id=p_workspace_id and provider='zoho_books' for update;
 select * into e from app.accounting_connection_epochs where owner_id=p_owner_id and workspace_id=p_workspace_id and provider='zoho_books' for update;
 select * into o from app.zoho_capture_completion where invoice_id=i.id and owner_id=p_owner_id and workspace_id=p_workspace_id for update;
 if o.invoice_id is null then return jsonb_build_object('state','not_admitted','originCaptured',false);end if;
 if p_action='reserve' then
  if o.state<>'eligible' then return jsonb_build_object('state','unavailable','originCaptured',false);end if;
  if p_operation_id is not null or p_external_id is not null or p_outcome is not null then raise exception 'CAPTURE_PROTOCOL_INPUT';end if;
  if i.updated_at is distinct from p_expected_updated_at or i.automation_version is distinct from p_expected_version then raise exception 'CAPTURE_PROTOCOL_VERSION';end if;
  if cust.id is null or i.deleted_at is not null or app.invoice_has_external_ledger(i) or i.metadata ? 'test_invoice'
   or i.metadata->>'invoice_direction' is distinct from 'receivable' or i.status not in ('draft','sent','overdue') or i.amount_paid<>0
   or exists(select 1 from app.zoho_export_operations where invoice_id=i.id)
   or i.metadata ? 'bookkeeping_sync_attempted_at' or i.metadata ? 'bookkeeping_sync_attempts' then
   update app.zoho_capture_completion set state='excluded',reason='prior_or_ineligible' where invoice_id=i.id;
   return jsonb_build_object('state','unavailable','originCaptured',false);end if;
  if c.owner_id is null or c.status<>'connected' or e.epoch_id is null or not e.present or e.epoch_id is distinct from p_expected_epoch
   or nullif(c.provider_account_id,'') is null or nullif(c.region,'') is null then
   update app.zoho_capture_completion set state='excluded',reason='epoch_unavailable' where invoice_id=i.id;
   return jsonb_build_object('state','unavailable','originCaptured',false);end if;
  insert into app.zoho_capture_write_context values(txid_current(),i.id);
  update public.invoices set metadata=metadata||jsonb_build_object('bookkeeping_sync_status','pending','bookkeeping_sync_attempts',0,
   'bookkeeping_sync_attempted_at',clock_timestamp(),'bookkeeping_sync_next_at',clock_timestamp()+interval '2 minutes')
   where id=i.id returning * into i;
  delete from app.zoho_capture_write_context where transaction_id=txid_current() and invoice_id=i.id;
  update app.zoho_capture_completion set state='reserved',operation_id=gen_random_uuid(),epoch_id=e.epoch_id,
   attempted_account_id=c.provider_account_id,attempted_region=c.region,deadline=clock_timestamp()+interval '2 minutes',
   invoice_hash=encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex'),
   customer_hash=encode(sha256(convert_to(to_jsonb(cust)::text,'UTF8')),'hex') where invoice_id=i.id returning * into o;
  return jsonb_build_object('state','reserved','operationId',o.operation_id,'invoice',to_jsonb(i),
   'customer',jsonb_build_object('id',cust.id,'name',cust.name,'email',cust.email,'phone',cust.phone),'originCaptured',false);
 end if;
 if p_operation_id is null or o.operation_id is distinct from p_operation_id then raise exception 'CAPTURE_PROTOCOL_UNKNOWN';end if;
 -- Terminal replay is read-only and does not consult today's connection as an
 -- origin assertion. It only recovers an unchanged, already-committed result.
 if p_action='complete' and o.state='completed_unverified' then
  if o.result_external_id=p_external_id and o.outcome=p_outcome and i.external_provider='zoho_books'
   and i.external_invoice_id=o.result_external_id and i.deleted_at is null
   and encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex')=o.result_hash then
   return jsonb_build_object('state','completed_unverified','invoice',to_jsonb(i),'originCaptured',false);end if;
  raise exception 'CAPTURE_PROTOCOL_REPLAY_CONFLICT';
 end if;
 valid:=o.state in ('reserved','started') and clock_timestamp()<=o.deadline and i.deleted_at is null
  and not app.invoice_has_external_ledger(i) and c.status='connected' and e.present and e.epoch_id=o.epoch_id
  and c.provider_account_id=o.attempted_account_id and c.region=o.attempted_region
  and encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex')=o.invoice_hash
  and encode(sha256(convert_to(to_jsonb(cust)::text,'UTF8')),'hex')=o.customer_hash;
 if p_action='abort' or valid is distinct from true then
  if o.state in ('reserved','started') then
   if p_action='abort' and valid is true then
    insert into app.zoho_capture_write_context values(txid_current(),i.id);
    update public.invoices set sync_status='failed',last_sync_error='ACCOUNTING_EXPORT_UNVERIFIED',
     metadata=metadata||jsonb_build_object('bookkeeping_sync_status','failed','bookkeeping_sync_error','ACCOUNTING_EXPORT_UNVERIFIED',
      'bookkeeping_sync_next_at',clock_timestamp()+interval '5 minutes') where id=i.id returning * into i;
    delete from app.zoho_capture_write_context where transaction_id=txid_current() and invoice_id=i.id;
   end if;
   update app.zoho_capture_completion set state='excluded',reason=case when p_action='abort' then 'unknown' else 'changed_or_expired' end,
    outcome='unknown_unverified' where invoice_id=i.id;
  end if;
  return jsonb_build_object('state','excluded','invoice',to_jsonb(i),'originCaptured',false);
 end if;
 if p_action='start' then
  if o.state<>'reserved' or p_external_id is not null or p_outcome is not null then raise exception 'CAPTURE_PROTOCOL_NOT_RESERVED';end if;
  insert into app.zoho_capture_write_context values(txid_current(),i.id);
  update public.invoices set metadata=metadata||jsonb_build_object('bookkeeping_sync_attempts',1) where id=i.id returning * into i;
  delete from app.zoho_capture_write_context where transaction_id=txid_current() and invoice_id=i.id;
  update app.zoho_capture_completion set state='started',invoice_hash=encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex') where invoice_id=i.id;
  return jsonb_build_object('state','started','originCaptured',false);
 end if;
 if o.state<>'started' or p_external_id is null or length(p_external_id) not between 1 and 100 or p_external_id ~ '[[:cntrl:]]'
  or p_outcome is null or p_outcome not in ('created_unverified','duplicate_unverified') then raise exception 'CAPTURE_PROTOCOL_RESULT';end if;
 -- Atomic UNVERIFIED linkage + durable result. There is deliberately no origin
 -- binding table, verified state or receipt-as-JSON path in this disabled stage.
 insert into app.zoho_capture_write_context values(txid_current(),i.id);
 update public.invoices set external_provider='zoho_books',external_invoice_id=p_external_id,sync_status='synced',last_sync_error=null,last_synced_at=clock_timestamp(),
  metadata=metadata||jsonb_build_object('bookkeeping_provider','zoho_books','bookkeeping_record_id',p_external_id,'bookkeeping_sync_status','synced',
   'bookkeeping_sync_error',null,'bookkeeping_sync_http_status',null,'bookkeeping_sync_provider_code',null,'bookkeeping_sync_provider_message',null,
   'bookkeeping_sync_provider_operation',null,'bookkeeping_sync_next_at',null,'bookkeeping_synced_at',clock_timestamp())
 where id=i.id returning * into i;
 delete from app.zoho_capture_write_context where transaction_id=txid_current() and invoice_id=i.id;
 update app.zoho_capture_completion set state='completed_unverified',result_external_id=p_external_id,outcome=p_outcome,
  result_hash=encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex') where invoice_id=i.id;
 return jsonb_build_object('state','completed_unverified','invoice',to_jsonb(i),'originCaptured',false);
end; $$;

create function public.cetld_recover_zoho_capture_completion(p_owner_id uuid,p_workspace_id uuid,p_invoice_id uuid,p_operation_id uuid)
returns jsonb language sql stable security definer set search_path='' set timezone='UTC' as $$
 select jsonb_build_object('state','completed_unverified','invoice',to_jsonb(i),'originCaptured',false)
 from app.zoho_capture_completion o join public.invoices i on i.id=o.invoice_id and i.workspace_id=o.workspace_id
 join public.workspaces w on w.id=i.workspace_id and w.owner_id=o.owner_id
 where o.owner_id=p_owner_id and o.workspace_id=p_workspace_id and o.invoice_id=p_invoice_id and o.operation_id=p_operation_id
  and o.state='completed_unverified' and i.deleted_at is null and i.external_provider='zoho_books' and i.external_invoice_id=o.result_external_id
  and encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex')=o.result_hash;
$$;
revoke all on function public.cetld_zoho_capture_completion_protocol(uuid,uuid,uuid,text,uuid,timestamptz,bigint,uuid,text,text),
 public.cetld_recover_zoho_capture_completion(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.cetld_zoho_capture_completion_protocol(uuid,uuid,uuid,text,uuid,timestamptz,bigint,uuid,text,text),
 public.cetld_recover_zoho_capture_completion(uuid,uuid,uuid,uuid) to service_role;
do $acl$
begin
 if exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
 where p.oid in ('app.fence_zoho_capture_candidate()'::regprocedure,'app.fence_old_zoho_export_journal()'::regprocedure,
  'public.cetld_zoho_capture_completion_protocol(uuid,uuid,uuid,text,uuid,timestamptz,bigint,uuid,text,text)'::regprocedure,
  'public.cetld_recover_zoho_capture_completion(uuid,uuid,uuid,uuid)'::regprocedure,'public.cetld_probe_zoho_capture_completion(uuid,uuid)'::regprocedure)
 and (pg_get_userbyid(p.proowner)<>'postgres' or not p.prosecdef or (a.grantee<>p.proowner and
  (p.pronamespace<>'public'::regnamespace or a.grantee<>'service_role'::regrole or a.is_grantable)))) then
 raise exception 'capture protocol new function ACL drift';end if;
 if exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
 where c.oid in ('app.zoho_capture_completion'::regclass,'app.zoho_capture_write_context'::regclass)
 and (pg_get_userbyid(c.relowner)<>'postgres' or not c.relrowsecurity or a.grantee<>c.relowner)) then
 raise exception 'capture protocol new table ACL drift';end if;
end $acl$;
commit;
