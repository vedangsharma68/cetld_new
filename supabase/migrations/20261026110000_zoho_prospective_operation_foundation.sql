-- Prospective operation bookkeeping only. NO verified origin and NO reminder authority.
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
 ('public.cetld_update_accounting_connection_tokens(uuid,uuid,text,bigint,uuid,text,text,text,timestamptz,text,text,text)',array['da4b98688566ce8526e0362eaae7bcfe29b2381b81f5bb7197608f5f4e7d1150'])
 ) s(signature,hashes) loop
  p:=to_regprocedure(r.signature);
  if p is null or not encode(sha256(convert_to(pg_get_functiondef(p),'UTF8')),'hex')=any(r.hashes) then
   raise exception 'foundation predecessor source drift: %',r.signature;end if;
  if (select pg_get_userbyid(proowner) from pg_proc where oid=p)<>'postgres'
   or (r.signature like 'public.%' and not has_function_privilege('service_role',p,'EXECUTE')) then
   raise exception 'foundation predecessor owner/ACL drift: %',r.signature;end if;
  if exists(select 1 from pg_proc f cross join lateral aclexplode(coalesce(f.proacl,acldefault('f',f.proowner))) a
   where f.oid=p and a.grantee<>f.proowner and
    (r.signature not like 'public.%' or a.grantee<>'service_role'::regrole or a.is_grantable)) then
   raise exception 'foundation predecessor ACL drift: %',r.signature;end if;
 end loop;
 if not (select relrowsecurity and pg_get_userbyid(relowner)='postgres' from pg_class where oid='public.cetld_accounting_connections'::regclass)
  or has_any_column_privilege('authenticated','public.cetld_accounting_connections','SELECT,INSERT,UPDATE')
  or has_table_privilege('authenticated','public.cetld_accounting_connections','DELETE')
  or has_any_column_privilege('anon','public.cetld_accounting_connections','SELECT,INSERT,UPDATE')
  or has_table_privilege('anon','public.cetld_accounting_connections','DELETE') then
  raise exception 'foundation connection protection drift';end if;
 if (select pg_get_userbyid(nspowner) from pg_namespace where nspname='app')<>'postgres' or
 exists(select 1 from pg_namespace n cross join lateral aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
  where n.nspname='app' and a.privilege_type='CREATE' and a.grantee<>n.nspowner) then
  raise exception 'foundation private schema CREATE drift';end if;
end $guard$;

-- Tombstones intentionally survive invoice/connection deletion. No cascade can
-- turn an old UUID or reconnect into a new admission/incarnation.
create table app.accounting_invoice_admissions (
 invoice_id uuid primary key, admission_id uuid not null unique default gen_random_uuid(),
 workspace_id uuid not null, owner_id uuid not null, admitted_at timestamptz not null default clock_timestamp(),
 local_export_candidate boolean not null, retired boolean not null default false
);
create table app.accounting_connection_epochs (
 owner_id uuid not null, workspace_id uuid not null, provider text not null check(provider='zoho_books'),
 epoch_id uuid not null unique, generation bigint not null check(generation>0), present boolean not null,
 primary key(owner_id,workspace_id,provider)
);
-- A short-lived, transaction-owned permit issued ONLY by the existing token
-- refresh RPC. Direct credential PATCH/reconsent never receives this permit.
create table app.accounting_refresh_permits (
 transaction_id bigint not null, owner_id uuid not null, workspace_id uuid not null, provider text not null,
 revision bigint not null, primary key(transaction_id,owner_id,workspace_id,provider)
);
create table app.zoho_export_operations (
 operation_id uuid primary key default gen_random_uuid(), admission_id uuid not null unique references app.accounting_invoice_admissions(admission_id),
 owner_id uuid not null, workspace_id uuid not null, invoice_id uuid not null unique,
 epoch_id uuid not null, attempted_account_id text not null, attempted_region text not null,
 invoice_version bigint not null, invoice_updated_at timestamptz not null, invoice_fingerprint text not null,
 state text not null default 'reserved' check(state in ('reserved','dispatched','finished','invalidated')),
 outcome text check(outcome in ('created_unverified','duplicate_unverified','unknown_unverified')),
 reserved_at timestamptz not null default clock_timestamp(), finished_at timestamptz,
 check((state='finished')=(outcome is not null))
);
alter table app.accounting_invoice_admissions enable row level security;
alter table app.accounting_connection_epochs enable row level security;
alter table app.accounting_refresh_permits enable row level security;
alter table app.zoho_export_operations enable row level security;
revoke all on app.accounting_invoice_admissions,app.accounting_connection_epochs,app.accounting_refresh_permits,app.zoho_export_operations from public,anon,authenticated,service_role;

create function app.admit_accounting_invoice_insert() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_op<>'INSERT' then
  if tg_op='DELETE' or new.deleted_at is not null or new.id is distinct from old.id or new.workspace_id is distinct from old.workspace_id then
   update app.accounting_invoice_admissions set retired=true where invoice_id=old.id;
  end if;
  if tg_op='DELETE' then return old;end if;return new;
 end if;
 insert into app.accounting_invoice_admissions(invoice_id,workspace_id,owner_id,local_export_candidate)
 select new.id,new.workspace_id,w.owner_id,
  not app.invoice_has_external_ledger(new)
  and not (new.metadata ? 'test_invoice' or new.invoice_number like 'CETLD-TEST-%'
   or coalesce(new.metadata->>'source_invoice_number','') like 'CETLD-TEST-%')
 from public.workspaces w where w.id=new.workspace_id
 on conflict(invoice_id) do update set retired=true;
 return new;
end; $$;
revoke all on function app.admit_accounting_invoice_insert() from public,anon,authenticated,service_role;
create trigger accounting_prospective_admission after insert or update or delete on public.invoices for each row execute function app.admit_accounting_invoice_insert();

create function app.track_accounting_connection_epoch() returns trigger
language plpgsql security definer set search_path='' as $$
declare trusted_refresh boolean:=false;rotate boolean:=false;
begin
 if coalesce(new.provider,old.provider)<>'zoho_books' then
  if tg_op='DELETE' then return old;end if;return new;
 end if;
 if tg_op='UPDATE' then
  if (new.owner_id,new.workspace_id,new.provider) is distinct from (old.owner_id,old.workspace_id,old.provider) then
   raise exception 'accounting connection scope is immutable';end if;
  select exists(select 1 from app.accounting_refresh_permits p where p.transaction_id=txid_current()
   and p.owner_id=old.owner_id and p.workspace_id=old.workspace_id and p.provider=old.provider
   and p.revision=old.revision and new.revision=old.revision+1 and old.refresh_lease_token is not null
   and new.refresh_lease_token is null) into trusted_refresh;
  -- Refresh cannot enroll an old connection, even when it fills regional
  -- metadata that was missing before installation.
  if trusted_refresh and not exists(select 1 from app.accounting_connection_epochs e
   where e.owner_id=old.owner_id and e.workspace_id=old.workspace_id and e.provider=old.provider) then return new;end if;
  rotate:=(new.provider_account_id,new.region,new.api_domain,new.accounts_domain) is distinct from
   (old.provider_account_id,old.region,old.api_domain,old.accounts_domain)
   or (new.status='disconnected') is distinct from (old.status='disconnected')
   or (not trusted_refresh and (new.revision,new.token_ciphertext,new.token_iv,new.token_tag,new.token_expires_at)
    is distinct from (old.revision,old.token_ciphertext,old.token_iv,old.token_tag,old.token_expires_at));
 else rotate:=true;end if;
 if rotate then
  insert into app.accounting_connection_epochs(owner_id,workspace_id,provider,epoch_id,generation,present)
  values(coalesce(new.owner_id,old.owner_id),coalesce(new.workspace_id,old.workspace_id),'zoho_books',gen_random_uuid(),1,
   tg_op<>'DELETE' and coalesce(new.status<>'disconnected',false))
  on conflict(owner_id,workspace_id,provider) do update set epoch_id=gen_random_uuid(),
   generation=app.accounting_connection_epochs.generation+1,present=excluded.present;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end; $$;
revoke all on function app.track_accounting_connection_epoch() from public,anon,authenticated,service_role;
create trigger accounting_connection_epoch after insert or update or delete on public.cetld_accounting_connections
 for each row execute function app.track_accounting_connection_epoch();

create function app.refresh_accounting_connection(
 p_owner_id uuid,p_workspace_id uuid,p_provider text,p_expected_revision bigint,p_lease_token uuid,
 p_token_ciphertext text,p_token_iv text,p_token_tag text,p_token_expires_at timestamptz,
 p_api_domain text,p_provider_account_id text,p_region text
) returns setof public.cetld_accounting_connections
language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.cetld_accounting_connections c where c.owner_id=p_owner_id and c.workspace_id=p_workspace_id
  and c.provider=p_provider and c.revision=p_expected_revision and c.refresh_lease_token=p_lease_token for update;
 if not found then return;end if;
 insert into app.accounting_refresh_permits values(txid_current(),p_owner_id,p_workspace_id,p_provider,p_expected_revision);
 return query update public.cetld_accounting_connections c
 set token_ciphertext=p_token_ciphertext,token_iv=p_token_iv,token_tag=p_token_tag,
  token_expires_at=p_token_expires_at,api_domain=coalesce(p_api_domain,c.api_domain),
  provider_account_id=coalesce(p_provider_account_id,c.provider_account_id),region=coalesce(p_region,c.region),
  revision=c.revision+1,refresh_lease_token=null,refresh_lease_until=null,status='connected',updated_at=now()
 where c.owner_id=p_owner_id and c.workspace_id=p_workspace_id and c.provider=p_provider
  and c.revision=p_expected_revision and c.refresh_lease_token=p_lease_token returning c.*;
 delete from app.accounting_refresh_permits where transaction_id=txid_current() and owner_id=p_owner_id
  and workspace_id=p_workspace_id and provider=p_provider;
end; $$;
revoke all on function app.refresh_accounting_connection(uuid,uuid,text,bigint,uuid,text,text,text,timestamptz,text,text,text) from public,anon,authenticated,service_role;
-- Preserve the exact original public signature, SQL language, owner, ACL,
-- security-definer mode, search_path and all other pg_proc security attributes.
do $refresh$
declare p oid:='public.cetld_update_accounting_connection_tokens(uuid,uuid,text,bigint,uuid,text,text,text,timestamptz,text,text,text)'::regprocedure;
 d text;b text;before_security jsonb;after_security jsonb;
begin
 select pg_get_functiondef(oid),prosrc,to_jsonb(f)-'prosrc'-'xmin'-'cmin'-'xmax'-'cmax'-'ctid' into d,b,before_security from pg_proc f where oid=p;
 execute replace(d,b,E'\n select * from app.refresh_accounting_connection(p_owner_id,p_workspace_id,p_provider,p_expected_revision,p_lease_token,p_token_ciphertext,p_token_iv,p_token_tag,p_token_expires_at,p_api_domain,p_provider_account_id,p_region);\n');
 select to_jsonb(f)-'prosrc'-'xmin'-'cmin'-'xmax'-'cmax'-'ctid' into after_security from pg_proc f where oid=p;
 if after_security is distinct from before_security then raise exception 'foundation changed public refresh security';end if;
end $refresh$;

create function public.cetld_zoho_operation_context(p_owner_id uuid,p_workspace_id uuid) returns jsonb
language sql security definer set search_path='' as $$
 select jsonb_build_object('epochId',e.epoch_id,'accountId',c.provider_account_id,'region',c.region,
  'apiDomain',c.api_domain,'accountsDomain',c.accounts_domain,'provenance','unverified')
 from public.cetld_accounting_connections c join app.accounting_connection_epochs e
  on (e.owner_id,e.workspace_id,e.provider)=(c.owner_id,c.workspace_id,c.provider)
 join public.workspaces w on w.id=c.workspace_id and w.owner_id=c.owner_id
 where c.owner_id=p_owner_id and c.workspace_id=p_workspace_id and c.provider='zoho_books'
  and c.status='connected' and e.present and nullif(c.provider_account_id,'') is not null
  and nullif(c.region,'') is not null and nullif(c.api_domain,'') is not null and nullif(c.accounts_domain,'') is not null;
$$;

create function public.cetld_reserve_zoho_export_operation(p_owner_id uuid,p_workspace_id uuid,p_invoice_id uuid,
 p_expected_updated_at timestamptz,p_expected_version bigint,p_expected_epoch uuid) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare i public.invoices;c public.cetld_accounting_connections;a app.accounting_invoice_admissions;
 e app.accounting_connection_epochs;o app.zoho_export_operations;
begin
 select v.* into i from public.invoices v join public.workspaces w on w.id=v.workspace_id
  where v.id=p_invoice_id and v.workspace_id=p_workspace_id and w.owner_id=p_owner_id for update of v;
 if i.id is null then raise exception 'ZOHO_OPERATION_SCOPE';end if;
 select * into a from app.accounting_invoice_admissions where invoice_id=i.id and workspace_id=p_workspace_id and owner_id=p_owner_id;
 if a.invoice_id is null or a.retired or not a.local_export_candidate then return jsonb_build_object('state','not_admitted','provenance','unverified');end if;
 if i.deleted_at is not null or app.invoice_has_external_ledger(i) or i.metadata ? 'test_invoice'
  or i.status in ('void','cancelled') or i.metadata->>'invoice_direction'='payable'
  or i.updated_at is distinct from p_expected_updated_at or i.automation_version is distinct from p_expected_version then
  raise exception 'ZOHO_OPERATION_INVOICE_CHANGED';end if;
 select * into c from public.cetld_accounting_connections where owner_id=p_owner_id and workspace_id=p_workspace_id and provider='zoho_books' for update;
 select * into e from app.accounting_connection_epochs where owner_id=p_owner_id and workspace_id=p_workspace_id and provider='zoho_books' for update;
 if c.owner_id is null or c.status<>'connected' or e.epoch_id is null or not e.present
  or e.epoch_id is distinct from p_expected_epoch or nullif(c.provider_account_id,'') is null
  or nullif(c.region,'') is null or nullif(c.api_domain,'') is null or nullif(c.accounts_domain,'') is null then
  raise exception 'ZOHO_OPERATION_CONNECTION_CHANGED';end if;
 if exists(select 1 from app.zoho_export_operations where admission_id=a.admission_id) then
  return jsonb_build_object('state','retry_unverified','provenance','unverified');end if;
 insert into app.zoho_export_operations(admission_id,owner_id,workspace_id,invoice_id,epoch_id,attempted_account_id,attempted_region,
  invoice_version,invoice_updated_at,invoice_fingerprint)
 values(a.admission_id,p_owner_id,p_workspace_id,i.id,e.epoch_id,c.provider_account_id,c.region,
  i.automation_version,i.updated_at,encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex')) returning * into o;
 return jsonb_build_object('state','reserved','operationId',o.operation_id,'provenance','unverified');
end; $$;

create function public.cetld_transition_zoho_export_operation(p_owner_id uuid,p_workspace_id uuid,p_invoice_id uuid,
 p_operation_id uuid,p_action text,p_outcome text default null) returns jsonb
language plpgsql security definer set search_path='' set timezone='UTC' as $$
declare i public.invoices;c public.cetld_accounting_connections;e app.accounting_connection_epochs;o app.zoho_export_operations;valid boolean;
begin
 if p_action is null or p_action not in ('start','finish') or (p_action='start' and p_outcome is not null)
  or (p_action='finish' and (p_outcome is null or p_outcome not in ('created_unverified','duplicate_unverified','unknown_unverified'))) then
  raise exception 'ZOHO_OPERATION_INPUT';end if;
 -- All operation paths lock invoice -> connection -> epoch -> operation.
 select v.* into i from public.invoices v join public.workspaces w on w.id=v.workspace_id
  where v.id=p_invoice_id and v.workspace_id=p_workspace_id and w.owner_id=p_owner_id for update of v;
 if i.id is null then raise exception 'ZOHO_OPERATION_SCOPE';end if;
 select * into c from public.cetld_accounting_connections where owner_id=p_owner_id and workspace_id=p_workspace_id and provider='zoho_books' for update;
 select * into e from app.accounting_connection_epochs where owner_id=p_owner_id and workspace_id=p_workspace_id and provider='zoho_books' for update;
 select * into o from app.zoho_export_operations where operation_id=p_operation_id and owner_id=p_owner_id
  and workspace_id=p_workspace_id and invoice_id=p_invoice_id for update;
 if o.operation_id is null then raise exception 'ZOHO_OPERATION_UNKNOWN';end if;
 valid:=exists(select 1 from app.accounting_invoice_admissions a where a.admission_id=o.admission_id
  and a.invoice_id=i.id and a.workspace_id=p_workspace_id and a.owner_id=p_owner_id and a.local_export_candidate and not a.retired)
  and clock_timestamp()<=o.reserved_at+interval '2 minutes' and i.deleted_at is null and not app.invoice_has_external_ledger(i) and c.status='connected' and e.present
  and e.epoch_id=o.epoch_id and c.provider_account_id=o.attempted_account_id and c.region=o.attempted_region
  and encode(sha256(convert_to(to_jsonb(i)::text,'UTF8')),'hex')=o.invoice_fingerprint;
 if valid is distinct from true then
  if o.state in ('reserved','dispatched') then update app.zoho_export_operations set state='invalidated',finished_at=clock_timestamp() where operation_id=o.operation_id;end if;
  return jsonb_build_object('state','invalidated','provenance','unverified');end if;
 if p_action='start' then
  if o.state<>'reserved' then raise exception 'ZOHO_OPERATION_NOT_RESERVED';end if;
  update app.zoho_export_operations set state='dispatched' where operation_id=o.operation_id;
  return jsonb_build_object('state','dispatched','provenance','unverified');
 end if;
 if o.state='finished' and o.outcome=p_outcome then return jsonb_build_object('state','replay_unverified','provenance','unverified');end if;
 if o.state<>'dispatched' then raise exception 'ZOHO_OPERATION_NOT_DISPATCHED';end if;
 update app.zoho_export_operations set state='finished',outcome=p_outcome,finished_at=clock_timestamp() where operation_id=o.operation_id;
 return jsonb_build_object('state','finished','provenance','unverified');
end; $$;
revoke all on function public.cetld_zoho_operation_context(uuid,uuid),
 public.cetld_reserve_zoho_export_operation(uuid,uuid,uuid,timestamptz,bigint,uuid),
 public.cetld_transition_zoho_export_operation(uuid,uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role;
grant execute on function public.cetld_zoho_operation_context(uuid,uuid),
 public.cetld_reserve_zoho_export_operation(uuid,uuid,uuid,timestamptz,bigint,uuid),
 public.cetld_transition_zoho_export_operation(uuid,uuid,uuid,uuid,text,text) to service_role;
-- Reject unexpected default-privilege grants instead of trusting the caller's
-- installation defaults for newly created security-definer entrypoints.
do $new_acl$
begin
 if exists(select 1 from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  where p.oid in ('app.admit_accounting_invoice_insert()'::regprocedure,'app.track_accounting_connection_epoch()'::regprocedure,
   'app.refresh_accounting_connection(uuid,uuid,text,bigint,uuid,text,text,text,timestamptz,text,text,text)'::regprocedure,
   'public.cetld_zoho_operation_context(uuid,uuid)'::regprocedure,
   'public.cetld_reserve_zoho_export_operation(uuid,uuid,uuid,timestamptz,bigint,uuid)'::regprocedure,
   'public.cetld_transition_zoho_export_operation(uuid,uuid,uuid,uuid,text,text)'::regprocedure)
  and (pg_get_userbyid(p.proowner)<>'postgres' or not p.prosecdef or
   (a.grantee<>p.proowner and (p.pronamespace<>'public'::regnamespace or a.grantee<>'service_role'::regrole or a.is_grantable)))) then
  raise exception 'foundation new function ACL/owner drift';end if;
 if exists(select 1 from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  where c.oid in ('app.accounting_invoice_admissions'::regclass,'app.accounting_connection_epochs'::regclass,
   'app.accounting_refresh_permits'::regclass,'app.zoho_export_operations'::regclass)
  and (pg_get_userbyid(c.relowner)<>'postgres' or not c.relrowsecurity or a.grantee<>c.relowner)) then
  raise exception 'foundation new table ACL/owner drift';end if;
end $new_acl$;
commit;
