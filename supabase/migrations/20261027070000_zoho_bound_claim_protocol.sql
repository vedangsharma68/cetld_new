-- Disabled owner-only claim-to-final protocol. No sender authority is enabled.
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
,
 ('public.cetld_zoho_original_bound_read_context(uuid,uuid,uuid)',array['273f1fc397a0505ba49e97d7e6625fa63da86acef1f813dab208434335270dbd'])
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
   where c.conrelid in ('app.zoho_invoice_origins'::regclass,'app.zoho_customer_origins'::regclass,'app.zoho_capture_completion'::regclass,'app.accounting_connection_epochs'::regclass) and c.contype in ('c','p','u','f'))
   is distinct from '4e724a814f77fd0002fa4ccf59637e10c31efcf292ab75b20e20e9f5bb41660a'
  -- PG versions differ in whether NOT NULL also appears as contype='n'.
  -- Independently protect every column/type/NOT NULL flag via pg_attribute;
  -- ignore no attribute merely because its constraint catalog row is absent.
  or (select encode(sha256(convert_to(jsonb_agg(jsonb_build_array(a.attrelid::regclass::text,a.attnum,a.attname,
   format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated) order by a.attrelid::regclass::text,a.attnum)::text,'UTF8')),'hex')
   from pg_attribute a where a.attrelid in ('app.zoho_invoice_origins'::regclass,'app.zoho_customer_origins'::regclass,
    'app.zoho_capture_completion'::regclass,'app.accounting_connection_epochs'::regclass) and a.attnum>0 and not a.attisdropped)
   is distinct from '8f3a72a36de67e045982275071a34cba02f62c7ac614a7f59b331a435e55b9ee' then
  raise exception 'original read private protection drift';end if;
end $private$;

-- Private protocol rows are not core queue rows or permission to dispatch.
-- No installation DML/backfill and no public/service executor is installed.
create table app.zoho_bound_claims (
 id uuid primary key default gen_random_uuid(),owner_id uuid not null,workspace_id uuid not null,invoice_id uuid not null,
 origin_operation_id uuid not null,customer_id uuid not null,account_id text not null,region text not null,
 external_invoice_id text not null,external_customer_id text not null,epoch_id uuid not null,
 phone text not null,invoice_version bigint not null,scheduled_for timestamptz not null,frame jsonb not null,
 state text not null check(state in ('claimed','challenged','reserved','posting','accepted','failed','quarantined','cancelled')),
 expires_at timestamptz not null,read_nonce uuid,read_deadline timestamptz,attempt_id uuid unique,
 permit_hash text,permit_deadline timestamptz,posting_started_at timestamptz,provider_message_id text unique,receipt_rank integer not null default 0 check(receipt_rank between 0 and 3),
 inserted_at timestamptz not null default clock_timestamp(),unique(workspace_id,invoice_id,invoice_version,scheduled_for)
);
create index zoho_bound_claim_pending_invoice on app.zoho_bound_claims(invoice_id) where state in ('claimed','challenged','reserved','posting','quarantined');
create index zoho_bound_claim_pending_phone on app.zoho_bound_claims(phone,workspace_id) where state in ('claimed','challenged','reserved','posting');
create index zoho_bound_claim_pending_customer on app.zoho_bound_claims(customer_id) where state in ('claimed','challenged','reserved','posting');
create index zoho_bound_claim_pending_workspace on app.zoho_bound_claims(workspace_id,owner_id) where state in ('claimed','challenged','reserved','posting');
create table app.zoho_bound_claim_write_context (
 backend_pid integer not null,transaction_id bigint not null,claim_id uuid not null,primary key(backend_pid,transaction_id,claim_id)
);
create table app.zoho_bound_claim_receipts (
 claim_id uuid not null references app.zoho_bound_claims(id),attempt_id uuid not null,
 provider_message_id text not null,status text not null check(status in ('accepted','sent','delivered','read','failed')),
 inserted_at timestamptz not null default clock_timestamp(),primary key(claim_id,attempt_id,provider_message_id,status)
);
alter table app.zoho_bound_claims enable row level security;
alter table app.zoho_bound_claim_write_context enable row level security;
alter table app.zoho_bound_claim_receipts enable row level security;
revoke all on app.zoho_bound_claims,app.zoho_bound_claim_write_context,app.zoho_bound_claim_receipts from public,anon,authenticated,service_role;
create function app.guard_zoho_bound_claim() returns trigger
language plpgsql security definer set search_path='' as $$
declare target uuid;
begin
 if tg_table_name='zoho_bound_claims' then
  if tg_op='DELETE' then target:=old.id;else target:=new.id;end if;
 else if tg_op='DELETE' then target:=old.claim_id;else target:=new.claim_id;end if;end if;
 if tg_op='DELETE' or not exists(select 1 from app.zoho_bound_claim_write_context where backend_pid=pg_backend_pid()
  and transaction_id=txid_current() and claim_id=target) then raise exception 'BOUND_CLAIM_PRIVATE_WRITE' using errcode='42501';end if;
 if tg_table_name='zoho_bound_claims' then if tg_op='UPDATE' and
  (new.id,new.owner_id,new.workspace_id,new.invoice_id,new.origin_operation_id,new.customer_id,new.account_id,new.region,
   new.external_invoice_id,new.external_customer_id,new.epoch_id,new.phone,new.invoice_version,new.scheduled_for,new.frame,new.expires_at)
  is distinct from
  (old.id,old.owner_id,old.workspace_id,old.invoice_id,old.origin_operation_id,old.customer_id,old.account_id,old.region,
   old.external_invoice_id,old.external_customer_id,old.epoch_id,old.phone,old.invoice_version,old.scheduled_for,old.frame,old.expires_at) then
  raise exception 'BOUND_CLAIM_IDENTITY_IMMUTABLE' using errcode='42501';end if;end if;
 if tg_table_name='zoho_bound_claim_receipts' and tg_op<>'INSERT' then raise exception 'BOUND_RECEIPT_IMMUTABLE' using errcode='42501';end if;
 return new;
end $$;
revoke all on function app.guard_zoho_bound_claim() from public,anon,authenticated,service_role;
create trigger zoho_bound_claim_guard before insert or update or delete on app.zoho_bound_claims for each row execute function app.guard_zoho_bound_claim();
create trigger zoho_bound_receipt_guard before insert or update or delete on app.zoho_bound_claim_receipts for each row execute function app.guard_zoho_bound_claim();

-- Data-only binding frame. This does NOT replace template, commercial-recipient,
-- signed owner approval or existing sender/final/receipt policy checks.
create function app.zoho_bound_claim_frame(p_owner uuid,p_workspace uuid,p_invoice uuid) returns jsonb
language sql volatile security definer set search_path='' set timezone='UTC' as $$
 select jsonb_build_object('origin',r.origin,'policyHash',encode(sha256(convert_to(jsonb_build_array(to_jsonb(s),to_jsonb(o))::text,'UTF8')),'hex'))
 from public.invoices i join public.customers x on x.workspace_id=i.workspace_id and x.id=i.customer_id
 join public.workspace_settings s on s.workspace_id=i.workspace_id
 join public.whatsapp_consents o on o.workspace_id=i.workspace_id and o.customer_id=x.id and o.phone=x.phone
 cross join lateral (select public.cetld_zoho_original_bound_read_context(p_owner,p_workspace,p_invoice) origin) r
 where i.workspace_id=p_workspace and i.id=p_invoice and r.origin is not null
 and i.followup_state in ('approved','active','scheduled') and i.next_follow_up_at<=clock_timestamp()
 and i.metadata->>'approved_reminder_text' is not null
 and app.core_safe_followup_time(i.metadata->>'approved_preferences_updated_at')=s.updated_at
 and x.phone~'^\+[1-9][0-9]{7,14}$' and i.customer_phone=x.phone
 and o.revoked_at is null and o.source in ('verbal','inbound_message') and o.categories @> array['invoice_updates']::text[]
 and not exists(select 1 from public.whatsapp_global_suppressions q where q.phone=x.phone)
 and not exists(select 1 from public.whatsapp_suppressions q where q.workspace_id=i.workspace_id and q.phone=x.phone)
 and i.reminder_count<coalesce((s.follow_up_preferences->>'maxReminders')::integer,3)
 and app.core_next_contact(clock_timestamp(),s.follow_up_preferences,s.default_timezone)<=clock_timestamp()+interval '1 second';
$$;
revoke all on function app.zoho_bound_claim_frame(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function app.zoho_bound_claim_protocol(p_owner uuid,p_workspace uuid,p_invoice uuid,p_action text,
 p_claim uuid default null,p_attempt uuid default null,p_nonce uuid default null,p_permit text default null,
 p_facts jsonb default null,p_message_id text default null,p_status text default null) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare c app.zoho_bound_claims; f jsonb;b app.zoho_invoice_origins; i public.invoices;phone text;permit text;target uuid;valid boolean;
begin
 if p_owner is null or p_workspace is null or p_invoice is null or p_action is null
  or p_action not in ('claim','challenge','check','reserve','begin_post','receipt','quarantine','recover') then raise exception 'BOUND_CLAIM_INPUT';end if;
 if p_facts is not null and octet_length(p_facts::text)>8192 then raise exception 'BOUND_CLAIM_ENVELOPE';end if;
 if p_action<>'reserve' and p_facts is not null or p_action<>'receipt' and (p_message_id is not null or p_status is not null)
  or p_action not in ('begin_post','receipt') and p_permit is not null
  or p_action not in ('check','reserve') and p_nonce is not null
  or p_action not in ('reserve','begin_post','receipt') and p_attempt is not null then raise exception 'BOUND_CLAIM_ENVELOPE';end if;
 if p_action='recover' then
  select * into c from app.zoho_bound_claims where id=p_claim and owner_id=p_owner and workspace_id=p_workspace and invoice_id=p_invoice;
  if c.id is null then return null;end if;
  return jsonb_build_object('claimId',c.id,'attemptId',c.attempt_id,'state',c.state,'deliveryAuthority',false);
 end if;
 -- Phone/settings prefix follows STOP. Invoice/customer follows capture; the
 -- disabled bridge must reconcile v2 review customer/invoice order. Connection,
 -- epoch and private claim follow. Never retain locks across HTTP.
 select x.phone into phone from public.invoices v join public.customers x on x.id=v.customer_id and x.workspace_id=v.workspace_id
  where v.id=p_invoice and v.workspace_id=p_workspace;
 if phone is not null then perform pg_advisory_xact_lock(hashtextextended(phone,0));end if;
 perform 1 from public.workspace_settings where workspace_id=p_workspace for share;
 select * into i from public.invoices where id=p_invoice and workspace_id=p_workspace for update;
 perform 1 from public.customers where id=i.customer_id and workspace_id=p_workspace for share;
 perform 1 from public.cetld_accounting_connections where owner_id=p_owner and workspace_id=p_workspace and provider='zoho_books' for update;
 perform 1 from app.accounting_connection_epochs where owner_id=p_owner and workspace_id=p_workspace and provider='zoho_books' for update;
 f:=app.zoho_bound_claim_frame(p_owner,p_workspace,p_invoice);
 if p_action='claim' then
  if p_claim is not null or p_attempt is not null or p_nonce is not null or f is null then return null;end if;
  if exists(select 1 from app.zoho_bound_claims where workspace_id=p_workspace and invoice_id=p_invoice
   and state in ('claimed','challenged','reserved','posting','quarantined'))
   or exists(select 1 from public.cetld_core_automation_delivery_claims where workspace_id=p_workspace and invoice_id=p_invoice
    and status in ('claimed','sending','quarantined')) then return null;end if;
  select * into b from app.zoho_invoice_origins where invoice_id=p_invoice and owner_id=p_owner and workspace_id=p_workspace;
  target:=gen_random_uuid();insert into app.zoho_bound_claim_write_context values(pg_backend_pid(),txid_current(),target);
  insert into app.zoho_bound_claims(id,owner_id,workspace_id,invoice_id,origin_operation_id,customer_id,account_id,region,external_invoice_id,
   external_customer_id,epoch_id,phone,invoice_version,scheduled_for,frame,state,expires_at)
   values(target,p_owner,p_workspace,p_invoice,b.operation_id,b.customer_id,b.account_id,b.region,b.external_invoice_id,b.external_customer_id,
    (f#>>'{origin,epochId}')::uuid,phone,i.automation_version,i.next_follow_up_at,f,'claimed',clock_timestamp()+interval '2 minutes') on conflict do nothing returning * into c;
  delete from app.zoho_bound_claim_write_context where backend_pid=pg_backend_pid() and transaction_id=txid_current() and claim_id=target;
  if c.id is null then return null;end if;
  return jsonb_build_object('claimId',c.id,'state',c.state,'deliveryAuthority',false);
 end if;
 select * into c from app.zoho_bound_claims where id=p_claim and owner_id=p_owner and workspace_id=p_workspace and invoice_id=p_invoice for update;
 if c.id is null then raise exception 'BOUND_CLAIM_SCOPE';end if;
 valid:=f is not null and f=c.frame and clock_timestamp()<c.expires_at;
 insert into app.zoho_bound_claim_write_context values(pg_backend_pid(),txid_current(),c.id);
 if p_action='quarantine' then
  update app.zoho_bound_claims set state=case when state in ('accepted','failed','cancelled') then state else 'quarantined' end where id=c.id;
 elsif p_action='challenge' then
  if not valid or c.state<>'claimed' then raise exception 'BOUND_CLAIM_STALE';end if;
  update app.zoho_bound_claims set state='challenged',read_nonce=gen_random_uuid(),read_deadline=clock_timestamp()+interval '5 seconds' where id=c.id returning * into c;
 elsif p_action='check' then
  if not valid or c.state<>'challenged' or p_nonce is distinct from c.read_nonce or c.read_deadline<=clock_timestamp() then raise exception 'BOUND_CLAIM_STALE';end if;
 elsif p_action='reserve' then
  if not valid or c.state<>'challenged' or p_nonce is distinct from c.read_nonce or c.read_deadline<=clock_timestamp()
   or p_attempt is null or p_facts is null or jsonb_typeof(p_facts)<>'object' then raise exception 'BOUND_CLAIM_EVIDENCE';end if;
  if p_facts is distinct from ((c.frame->'origin')-array['fingerprint','epochId','apiDomain','accountsDomain','reminderAuthority','workspaceId','invoiceId']||jsonb_build_object('creditsApplied','0','writeOff','0')) then
   raise exception 'BOUND_CLAIM_FACTS';end if;
  permit:=encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex');
  update app.zoho_bound_claims set state='reserved',attempt_id=p_attempt,read_nonce=null,
   permit_hash=encode(sha256(convert_to(permit,'UTF8')),'hex'),permit_deadline=least(c.read_deadline,clock_timestamp()+interval '2 seconds') where id=c.id returning * into c;
 elsif p_action='begin_post' then
  if not valid or c.state<>'reserved' or p_attempt is distinct from c.attempt_id or c.permit_deadline<=clock_timestamp()
   or p_permit is null or length(p_permit)<>64 or encode(sha256(convert_to(p_permit,'UTF8')),'hex') is distinct from c.permit_hash then raise exception 'BOUND_CLAIM_PERMIT';end if;
  update app.zoho_bound_claims set state='posting',posting_started_at=clock_timestamp() where id=c.id;
 elsif p_action='receipt' then
  if c.posting_started_at is null or c.state not in ('posting','quarantined','accepted','failed') or p_attempt is distinct from c.attempt_id
   or p_permit is null or length(p_permit)<>64 or encode(sha256(convert_to(p_permit,'UTF8')),'hex') is distinct from c.permit_hash
   or p_message_id is null or length(p_message_id) not between 1 and 256 or p_message_id~'[[:cntrl:]]'
   or p_status is null or p_status not in ('accepted','sent','delivered','read','failed')
   or c.provider_message_id is not null and c.provider_message_id<>p_message_id then raise exception 'BOUND_CLAIM_RECEIPT';end if;
  insert into app.zoho_bound_claim_receipts(claim_id,attempt_id,provider_message_id,status) values(c.id,p_attempt,p_message_id,p_status) on conflict do nothing;
  -- Audit only: never count/schedule/send, including callbacks after STOP/switch.
  update app.zoho_bound_claims set provider_message_id=p_message_id,
   state=case when p_status='failed' and receipt_rank<2 then 'failed'
    when state='failed' and p_status in ('accepted','sent') then state else 'accepted' end,
   receipt_rank=greatest(receipt_rank,case p_status when 'read' then 3 when 'delivered' then 2 when 'accepted' then 1 when 'sent' then 1 else 0 end) where id=c.id;
 end if;
 delete from app.zoho_bound_claim_write_context where backend_pid=pg_backend_pid() and transaction_id=txid_current() and claim_id=c.id;
 select * into c from app.zoho_bound_claims where id=c.id;
 return jsonb_build_object('claimId',c.id,'attemptId',c.attempt_id,'state',c.state,'deliveryAuthority',false)
  ||case when p_action in ('challenge','check') then jsonb_build_object('context',c.frame->'origin','nonce',c.read_nonce) else '{}'::jsonb end
  ||case when p_action='reserve' then jsonb_build_object('permit',permit) else '{}'::jsonb end;
exception when others then
 delete from app.zoho_bound_claim_write_context where backend_pid=pg_backend_pid() and transaction_id=txid_current() and claim_id=coalesce(c.id,target);raise;
end $$;
revoke all on function app.zoho_bound_claim_protocol(uuid,uuid,uuid,text,uuid,uuid,uuid,text,jsonb,text,text) from public,anon,authenticated,service_role;

-- Irreversible invalidation prevents edit/revert and STOP/START or away/back
-- from resurrecting an old capability. Only private protocol state is changed.
create function app.invalidate_zoho_bound_claims() returns trigger
language plpgsql security definer set search_path='' as $$
declare d jsonb; r record;
begin
 if tg_op='UPDATE' and new is not distinct from old then return new;end if;
 if tg_table_name='accounting_connection_epochs' and tg_op='UPDATE' then
  if (new.epoch_id,new.present) is not distinct from (old.epoch_id,old.present) then return new;end if;
 end if;
 if tg_op='DELETE' then d:=to_jsonb(old);else d:=to_jsonb(new);end if;
 for r in select id,state from app.zoho_bound_claims c where state in ('claimed','challenged','reserved','posting') and
  case tg_table_name
   when 'invoices' then c.invoice_id=(d->>'id')::uuid
   when 'customers' then c.customer_id=(d->>'id')::uuid
   when 'workspace_settings' then c.workspace_id=(d->>'workspace_id')::uuid
   when 'workspaces' then c.workspace_id=(d->>'id')::uuid
   when 'whatsapp_global_suppressions' then c.phone=d->>'phone'
   when 'whatsapp_suppressions' then c.workspace_id=(d->>'workspace_id')::uuid and c.phone=d->>'phone'
   when 'whatsapp_consents' then c.workspace_id=(d->>'workspace_id')::uuid and (c.phone=d->>'phone' or c.customer_id=(d->>'customer_id')::uuid)
   when 'accounting_connection_epochs' then c.workspace_id=(d->>'workspace_id')::uuid and c.owner_id=(d->>'owner_id')::uuid and d->>'provider'='zoho_books'
   else false end for update
 loop
  insert into app.zoho_bound_claim_write_context values(pg_backend_pid(),txid_current(),r.id);
  update app.zoho_bound_claims set state=case when r.state='posting' then 'quarantined' else 'cancelled' end,read_nonce=null where id=r.id;
  delete from app.zoho_bound_claim_write_context where backend_pid=pg_backend_pid() and transaction_id=txid_current() and claim_id=r.id;
 end loop;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
revoke all on function app.invalidate_zoho_bound_claims() from public,anon,authenticated,service_role;
create trigger zoho_claim_invoice_changed after update or delete on public.invoices for each row execute function app.invalidate_zoho_bound_claims();
create trigger zoho_claim_customer_changed after update or delete on public.customers for each row execute function app.invalidate_zoho_bound_claims();
create trigger zoho_claim_settings_changed after update or delete on public.workspace_settings for each row execute function app.invalidate_zoho_bound_claims();
create trigger zoho_claim_workspace_changed after update or delete on public.workspaces for each row execute function app.invalidate_zoho_bound_claims();
create trigger zoho_claim_consent_changed after insert or update or delete on public.whatsapp_consents for each row execute function app.invalidate_zoho_bound_claims();
create trigger zoho_claim_stop_changed after insert or update or delete on public.whatsapp_suppressions for each row execute function app.invalidate_zoho_bound_claims();
create trigger zoho_claim_global_stop_changed after insert or update or delete on public.whatsapp_global_suppressions for each row execute function app.invalidate_zoho_bound_claims();
create trigger zoho_claim_epoch_changed after update or delete on app.accounting_connection_epochs for each row execute function app.invalidate_zoho_bound_claims();
do $acl$
begin
 if exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  where p.oid in ('app.guard_zoho_bound_claim()'::regprocedure,'app.zoho_bound_claim_frame(uuid,uuid,uuid)'::regprocedure,
   'app.zoho_bound_claim_protocol(uuid,uuid,uuid,text,uuid,uuid,uuid,text,jsonb,text,text)'::regprocedure,'app.invalidate_zoho_bound_claims()'::regprocedure)
  and (pg_get_userbyid(p.proowner)<>'postgres' or not p.prosecdef or a.grantee<>p.proowner)) then raise exception 'bound claim new function ACL drift';end if;
 if exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  where c.oid in ('app.zoho_bound_claims'::regclass,'app.zoho_bound_claim_write_context'::regclass,'app.zoho_bound_claim_receipts'::regclass)
  and (pg_get_userbyid(c.relowner)<>'postgres' or not c.relrowsecurity or a.grantee<>c.relowner)) then raise exception 'bound claim new table ACL drift';end if;
end $acl$;
commit;
