-- PROPOSED ADDITIVE MIGRATION: LOCAL REVIEW ONLY. DO NOT APPLY WITHOUT APPROVAL.
-- Does not register a provider, activate a sender, schedule work or mint consent.
-- Registry approval requires a separately reviewed DB-admin insert. No tokens.
begin;
create table app.first_party_reminder_templates(
  workspace_id uuid not null,owner_id uuid not null,
  waba_id text not null check(waba_id ~ '^[0-9]{5,30}$'),phone_number_id text not null check(phone_number_id ~ '^[0-9]{5,30}$'),
  name text not null check(name ~ '^[a-z][a-z0-9_]*$' and length(name)<=512),language text not null check(language ~ '^[a-z]{2}(_[A-Z]{2})?$'),
  revision text not null check(revision ~ '^[A-Za-z0-9._:-]{1,128}$'),body text not null check(length(body) between 1 and 1000),
  approved boolean not null default false,approval_reference text,approved_at timestamptz,
  primary key(workspace_id,waba_id,phone_number_id,name,language,revision),
  foreign key(workspace_id,owner_id) references public.workspaces(id,owner_id),
  check(not approved or (approval_reference is not null and approved_at is not null))
);
create table app.first_party_reminder_dispatches(
  claim_id uuid primary key references public.cetld_core_automation_delivery_claims(id),
  workspace_id uuid not null,owner_id uuid not null,invoice_id uuid not null,customer_id uuid not null,
  phone text not null,callback_token text not null unique check(callback_token ~ '^[a-f0-9]{64}$'),
  snapshot jsonb not null,snapshot_hash text not null check(snapshot_hash ~ '^[a-f0-9]{64}$'),
  state text not null default 'reserved' check(state in ('reserved','accepted','delivered','read','failed','uncertain')),
  provider_message_id text unique,counted boolean not null default false,
  count_before integer not null,reserved_at timestamptz not null default clock_timestamp(),lease_until timestamptz not null,
  receipt_at timestamptz,last_error text,
  foreign key(workspace_id,owner_id) references public.workspaces(id,owner_id),
  foreign key(workspace_id,invoice_id) references public.invoices(workspace_id,id),
  foreign key(workspace_id,customer_id) references public.customers(workspace_id,id)
);
create index first_party_reminder_uncertain_lease on app.first_party_reminder_dispatches(lease_until) where state='reserved';
create table app.first_party_reminder_receipt_events(
  callback_token text not null references app.first_party_reminder_dispatches(callback_token),
  provider_message_id text not null,status text not null,received_at timestamptz not null default clock_timestamp(),
  primary key(callback_token,provider_message_id,status)
);
alter table app.first_party_reminder_templates enable row level security;
alter table app.first_party_reminder_dispatches enable row level security;
alter table app.first_party_reminder_receipt_events enable row level security;
revoke all on app.first_party_reminder_templates,app.first_party_reminder_dispatches,app.first_party_reminder_receipt_events from public,anon,authenticated,service_role;

create function app.reminder_canonical_json(p jsonb) returns text language sql immutable strict set search_path='' as $$
  select case jsonb_typeof(p)
    when 'object' then '{'||coalesce((select string_agg(to_jsonb(k)::text||':'||app.reminder_canonical_json(v),',' order by k collate "C") from jsonb_each(p) e(k,v)),'')||'}'
    when 'array' then '['||coalesce((select string_agg(app.reminder_canonical_json(v),',' order by n) from jsonb_array_elements(p) with ordinality e(v,n)),'')||']'
    else p::text end
$$;

-- A coherent local ledger is required. External ledgers require their own fresh
-- scoped accounting verification and are deliberately unsupported here.
create function public.cetld_core_check_local_reminder_payment(p_owner_id uuid,p_workspace_id uuid,p_invoice_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.invoices%rowtype; net numeric;
begin
  if not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=p_owner_id) then return '{"ok":false,"reason":"scope"}';end if;
  select * into i from public.invoices where workspace_id=p_workspace_id and id=p_invoice_id for update;
  if i.id is null or i.deleted_at is not null then return '{"ok":false,"reason":"invoice_unavailable"}';end if;
  if i.metadata->>'invoice_direction' is distinct from 'receivable' then return '{"ok":false,"reason":"invoice_direction"}';end if;
  if i.external_provider is not null or i.external_invoice_id is not null or i.metadata ? 'bookkeeping_record_id'
    then return '{"ok":false,"reason":"external_accounting_required"}';end if;
  if exists(select 1 from public.payment_reversals r left join public.payments p on p.workspace_id=r.workspace_id and p.id=r.payment_id
    where r.workspace_id=p_workspace_id and (r.invoice_id=p_invoice_id or p.invoice_id=p_invoice_id) and (p.id is null or p.invoice_id<>r.invoice_id or p.amount<>r.amount))
    then return '{"ok":false,"reason":"payment_audit_mismatch"}';end if;
  select coalesce(sum(case when r.id is null then p.amount else 0 end),0) into net
    from public.payments p left join public.payment_reversals r on r.workspace_id=p.workspace_id and r.payment_id=p.id
    where p.workspace_id=p_workspace_id and p.invoice_id=p_invoice_id;
  if net<>i.amount_paid or net>i.total_amount then return '{"ok":false,"reason":"payment_balance_mismatch"}';end if;
  return jsonb_build_object('ok',true,'paidMinor',net*100,'invoiceVersion',i.automation_version);
end $$;

create function public.cetld_core_authorize_first_party_reminder(p_owner_id uuid,p_workspace_id uuid,p_claim_id uuid,p_snapshot jsonb,p_snapshot_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare i public.invoices%rowtype; c public.cetld_core_automation_delivery_claims%rowtype;
  s public.workspace_settings%rowtype; x public.customers%rowtype; o public.whatsapp_consents%rowtype;
  t app.first_party_reminder_templates%rowtype; facts jsonb; body text; token text; n integer; payment jsonb;
begin
  if jsonb_typeof(p_snapshot)<>'object' or length(p_snapshot::text)>8000 or p_snapshot_hash !~ '^[a-f0-9]{64}$'
    then return '{"authorized":false}';end if;
  if not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=p_owner_id) then return '{"authorized":false}';end if;
  if p_snapshot->>'phone' !~ '^\+[1-9][0-9]{7,14}$' then return '{"authorized":false}';end if;
  -- Same phone advisory lock already used by active-consent and all STOP RPCs.
  perform pg_advisory_xact_lock(hashtextextended(p_snapshot->>'phone',0));
  -- Invoice before claim throughout this proposal. STOP follows this order.
  select * into i from public.invoices where workspace_id=p_workspace_id and id=(p_snapshot->>'invoiceId')::uuid for update;
  select * into c from public.cetld_core_automation_delivery_claims where id=p_claim_id and workspace_id=p_workspace_id for update;
  select * into s from public.workspace_settings where workspace_id=p_workspace_id for share;
  select * into x from public.customers where id=i.customer_id and workspace_id=p_workspace_id for share;
  -- Consent writes acquire the same phone advisory lock; an MVCC read avoids
  -- row-lock -> advisory inversion inside BEFORE consent triggers.
  select * into o from public.whatsapp_consents where workspace_id=p_workspace_id and customer_id=x.id and phone=x.phone;
  if i.id is null or c.id is null or c.invoice_id<>i.id or c.status<>'sending' or c.delivery_token is null or c.lease_until<=clock_timestamp()
    or i.automation_version<>c.invoice_version or s.updated_at<>c.preferences_updated_at or i.deleted_at is not null
    or i.status<>'sent' or i.metadata->>'invoice_direction' is distinct from 'receivable' or i.amount_paid>=i.total_amount
    or i.total_amount<=0 or i.due_date is null or i.followup_state not in ('approved','active','scheduled')
    or i.next_follow_up_at is null or i.next_follow_up_at>clock_timestamp()
    or x.phone is distinct from p_snapshot->>'phone' or x.id::text is distinct from p_snapshot->>'customerId'
    or o.id is null or o.revoked_at is not null or o.source not in ('verbal','inbound_message') or not ('invoice_updates'=any(o.categories))
    or o.id::text is distinct from p_snapshot->>'consentId' or o.created_at is distinct from (p_snapshot->>'consentCreatedAt')::timestamptz
    or i.updated_at is distinct from (p_snapshot->>'invoiceUpdatedAt')::timestamptz
    or i.automation_version::text is distinct from p_snapshot->>'invoiceVersion'
    or s.updated_at is distinct from (p_snapshot->>'preferencesUpdatedAt')::timestamptz
    or s.updated_at is distinct from (i.metadata->>'approved_preferences_updated_at')::timestamptz
    or exists(select 1 from public.whatsapp_global_suppressions where phone=x.phone)
    or exists(select 1 from public.whatsapp_suppressions where workspace_id=p_workspace_id and phone=x.phone)
    then return '{"authorized":false}';end if;
  if app.core_next_contact(clock_timestamp(),s.follow_up_preferences,s.default_timezone)>clock_timestamp()+interval '1 second'
    or i.reminder_count>=coalesce((s.follow_up_preferences->>'maxReminders')::integer,3) then return '{"authorized":false}';end if;
  payment:=public.cetld_core_check_local_reminder_payment(p_owner_id,p_workspace_id,i.id);
  if payment->>'ok' is distinct from 'true' then return '{"authorized":false}';end if;
  select * into t from app.first_party_reminder_templates where workspace_id=p_workspace_id and owner_id=p_owner_id
    and waba_id=p_snapshot#>>'{template,wabaId}' and phone_number_id=p_snapshot#>>'{template,phoneNumberId}'
    and name=p_snapshot#>>'{template,name}' and language=p_snapshot#>>'{template,language}' and revision=p_snapshot#>>'{template,revision}' for share;
  if t.workspace_id is null or not t.approved or t.body is distinct from p_snapshot#>>'{template,body}' then return '{"authorized":false}';end if;
  facts:=jsonb_build_array(s.business_name,x.name,i.invoice_number,to_char(i.total_amount-i.amount_paid,'FM9999999999999990.00'),i.currency,i.due_date::text);
  if exists(select 1 from jsonb_array_elements_text(facts) e(v) where v is null or length(btrim(v)) not between 1 and 256
    or position(chr(10) in v)>0 or position(chr(13) in v)>0 or v like '%{%' or v like '%}%') then return '{"authorized":false}';end if;
  if facts is distinct from p_snapshot#>'{template,parameters}' then return '{"authorized":false}';end if;
  body:=t.body;for n in 1..6 loop body:=replace(body,'{{'||n||'}}',facts->>(n-1));end loop;
  if body is distinct from p_snapshot->>'body' or body is distinct from i.metadata->>'approved_reminder_text'
    or body like '%{{%' or encode(sha256(convert_to(app.reminder_canonical_json(p_snapshot),'UTF8')),'hex')<>p_snapshot_hash
    then return '{"authorized":false}';end if;
  token:=encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex');
  insert into app.first_party_reminder_dispatches(claim_id,workspace_id,owner_id,invoice_id,customer_id,phone,callback_token,snapshot,snapshot_hash,count_before,lease_until)
    values(c.id,p_workspace_id,p_owner_id,i.id,x.id,x.phone,token,p_snapshot,p_snapshot_hash,i.reminder_count,c.lease_until) on conflict do nothing;
  if not found then return '{"authorized":false}';end if;
  return jsonb_build_object('authorized',true,'snapshot_hash',p_snapshot_hash,'callback_token',token);
exception when invalid_text_representation or datetime_field_overflow then return '{"authorized":false}';
end $$;

create function app.first_party_template_revision_guard() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' or (to_jsonb(new)-'approved') is distinct from (to_jsonb(old)-'approved')
    or (not old.approved and new.approved) then raise exception 'Template approval revisions are immutable; insert a newly reviewed revision' using errcode='42501';end if;
  return new;
end $$;
create trigger immutable_first_party_template_revision before update or delete on app.first_party_reminder_templates
  for each row execute function app.first_party_template_revision_guard();
create function app.first_party_receipt_audit_guard() returns trigger language plpgsql set search_path='' as $$
begin raise exception 'Reminder receipt audit is append-only' using errcode='42501';end $$;
create trigger immutable_first_party_receipt_audit before update or delete on app.first_party_reminder_receipt_events
  for each row execute function app.first_party_receipt_audit_guard();

create function app.first_party_consent_phone_lock() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='UPDATE' and old.phone is distinct from new.phone then
    perform pg_advisory_xact_lock(hashtextextended(least(old.phone,new.phone),0));
    perform pg_advisory_xact_lock(hashtextextended(greatest(old.phone,new.phone),0));
  else perform pg_advisory_xact_lock(hashtextextended(new.phone,0));end if;
  if new.revoked_at is not null and (tg_op='INSERT' or old.revoked_at is null) then perform app.cancel_first_party_phone(new.phone,new.workspace_id);end if;
  return new;
end $$;
create trigger first_party_consent_phone_lock before insert or update on public.whatsapp_consents
  for each row execute function app.first_party_consent_phone_lock();

-- Existing claims must follow phone -> invoice -> claim as well. Select candidate
-- IDs without row locks, then take deterministic phone/invoice locks and recheck.
create or replace function public.cetld_core_claim_due_followups(p_owner_id uuid,p_workspace_id uuid,p_now timestamptz default now(),p_limit integer default 25,p_invoice_id uuid default null)
returns table(claim_id uuid,invoice_id uuid,invoice_version bigint)
language plpgsql security definer set search_path='' as $$
declare candidate record;i public.invoices%rowtype;s public.workspace_settings%rowtype;c public.cetld_core_automation_delivery_claims%rowtype;
begin
  if not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=p_owner_id) then return;end if;
  for candidate in select v.id,x.phone from public.invoices v left join public.customers x on x.workspace_id=v.workspace_id and x.id=v.customer_id
    where v.workspace_id=p_workspace_id and (p_invoice_id is null or v.id=p_invoice_id) and v.next_follow_up_at<=p_now
    and v.followup_state in ('approved','active','scheduled') and v.deleted_at is null
    order by x.phone collate "C",v.id limit greatest(1,least(p_limit,100))
  loop
    if candidate.phone is null or candidate.phone !~ '^\+[1-9][0-9]{7,14}$' then continue;end if;
    if candidate.phone is not null then perform pg_advisory_xact_lock(hashtextextended(candidate.phone,0));end if;
    select * into i from public.invoices where id=candidate.id and workspace_id=p_workspace_id for update skip locked;
    select * into s from public.workspace_settings where workspace_id=p_workspace_id;
    if i.id is null or i.deleted_at is not null or i.followup_state not in ('approved','active','scheduled') or i.next_follow_up_at>p_now
      or i.next_follow_up_at is null or i.amount_paid>=i.total_amount or i.total_amount<=0 or i.status::text in ('paid','void','cancelled')
      or i.due_date is null or i.metadata->>'invoice_direction' is distinct from 'receivable'
      or nullif(btrim(i.metadata->>'approved_reminder_text'),'') is null
      or app.core_safe_followup_time(i.metadata->>'approved_preferences_updated_at') is distinct from s.updated_at
      or not exists(select 1 from public.customers x where x.workspace_id=p_workspace_id and x.id=i.customer_id and x.phone=candidate.phone)
      or exists(select 1 from public.whatsapp_global_suppressions where phone=candidate.phone)
      or exists(select 1 from public.whatsapp_suppressions where workspace_id=p_workspace_id and phone=candidate.phone) then continue;end if;
    insert into public.cetld_core_automation_delivery_claims(workspace_id,invoice_id,scheduled_for,invoice_version,preferences_updated_at,status,lease_until)
      values(p_workspace_id,i.id,i.next_follow_up_at,i.automation_version,s.updated_at,'claimed',p_now+interval '2 minutes')
    on conflict on constraint core_followup_claim_unique do update set invoice_version=excluded.invoice_version,preferences_updated_at=excluded.preferences_updated_at,
      status='claimed',attempts=public.cetld_core_automation_delivery_claims.attempts+1,lease_until=excluded.lease_until,delivery_token=null
      where public.cetld_core_automation_delivery_claims.attempts<3
      and not exists(select 1 from app.first_party_reminder_dispatches d where d.claim_id=public.cetld_core_automation_delivery_claims.id)
      and (public.cetld_core_automation_delivery_claims.status in ('failed','cancelled') or
        (public.cetld_core_automation_delivery_claims.status='claimed' and public.cetld_core_automation_delivery_claims.lease_until<p_now)) returning * into c;
    if found then claim_id:=c.id;invoice_id:=c.invoice_id;invoice_version:=c.invoice_version;return next;end if;
  end loop;
end $$;

create or replace function public.cetld_core_authorize_delivery(p_claim_id uuid,p_owner_id uuid,p_workspace_id uuid,p_preferences_version timestamptz default null)
returns table(authorized boolean,reason text,token uuid) language plpgsql security definer set search_path='' as $$
declare c public.cetld_core_automation_delivery_claims%rowtype;i public.invoices%rowtype;s public.workspace_settings%rowtype;target_phone text;
begin
  authorized:=false;reason:='not_found';token:=null;
  if not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=p_owner_id) then return next;return;end if;
  select v.* into i from public.invoices v join public.cetld_core_automation_delivery_claims d on d.workspace_id=v.workspace_id and d.invoice_id=v.id
    where d.id=p_claim_id and d.workspace_id=p_workspace_id;
  select x.phone into target_phone from public.customers x where x.workspace_id=p_workspace_id and x.id=i.customer_id;
  if target_phone is null or target_phone !~ '^\+[1-9][0-9]{7,14}$' then reason:='missing_contact';return next;return;end if;
  if target_phone is not null then perform pg_advisory_xact_lock(hashtextextended(target_phone,0));end if;
  select * into i from public.invoices where id=i.id and workspace_id=p_workspace_id for update;
  select * into c from public.cetld_core_automation_delivery_claims where id=p_claim_id and workspace_id=p_workspace_id for update;
  select * into s from public.workspace_settings where workspace_id=p_workspace_id;
  if c.id is null or i.id is null or s.workspace_id is null then return next;return;end if;
  if c.status<>'claimed' then reason:='not_claimed';return next;return;end if;
  if c.invoice_version<>i.automation_version or c.preferences_updated_at<>s.updated_at or (p_preferences_version is not null and p_preferences_version<>s.updated_at)
    then reason:='stale_claim';return next;return;end if;
  if c.lease_until<=clock_timestamp() then reason:='expired';return next;return;end if;
  if i.deleted_at is not null or i.followup_state not in ('approved','active','scheduled') or i.status::text in ('paid','void','cancelled')
    or i.total_amount<=0 or i.amount_paid>=i.total_amount or i.due_date is null or i.metadata->>'invoice_direction' is distinct from 'receivable'
    or nullif(btrim(i.metadata->>'approved_reminder_text'),'') is null
    or app.core_safe_followup_time(i.metadata->>'approved_preferences_updated_at') is distinct from s.updated_at
    or not exists(select 1 from public.customers x where x.workspace_id=p_workspace_id and x.id=i.customer_id and x.phone=target_phone)
    or exists(select 1 from public.whatsapp_global_suppressions q where q.phone=target_phone)
    or exists(select 1 from public.whatsapp_suppressions q where q.workspace_id=p_workspace_id and q.phone=target_phone)
    then reason:='ineligible_invoice';return next;return;end if;
  if i.reminder_count>=coalesce((s.follow_up_preferences->>'maxReminders')::integer,3) then reason:='reminder_limit';return next;return;end if;
  if app.core_next_contact(clock_timestamp(),s.follow_up_preferences,s.default_timezone)>clock_timestamp()+interval '1 second'
    then reason:='contact_hours';return next;return;end if;
  token:=gen_random_uuid();authorized:=true;reason:=null;
  update public.cetld_core_automation_delivery_claims set status='sending',delivery_token=token where id=c.id;return next;
end $$;

-- Suppression inserts are an additive hook on existing STOP transactions.
create function app.cancel_first_party_phone(p_phone text,p_workspace_id uuid) returns void
language plpgsql security definer set search_path='' as $$
declare i public.invoices%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_phone,0));
  for i in select v.* from public.invoices v join public.customers x on x.workspace_id=v.workspace_id and x.id=v.customer_id
    where (x.phone=p_phone or exists(select 1 from app.first_party_reminder_dispatches d where d.workspace_id=v.workspace_id and d.invoice_id=v.id and d.phone=p_phone))
    and (p_workspace_id is null or v.workspace_id=p_workspace_id)
    and v.deleted_at is null and v.metadata->>'invoice_direction'='receivable' order by v.id for update of v
  loop
    update public.cetld_core_automation_delivery_claims set status=case when status='sending' then 'quarantined' else 'cancelled' end,last_error='recipient_suppressed'
      where workspace_id=i.workspace_id and invoice_id=i.id and status in ('claimed','sending');
    update app.first_party_reminder_dispatches set state='uncertain',last_error='recipient_suppressed'
      where workspace_id=i.workspace_id and invoice_id=i.id and state='reserved';
    if i.followup_state in ('approved','active','scheduled') and i.amount_paid<i.total_amount and i.status<>'paid' then
      update public.invoices set followup_state='paused',next_follow_up_at=null where id=i.id and workspace_id=i.workspace_id;
    end if;
  end loop;
end $$;
create function app.first_party_suppression_hook() returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform app.cancel_first_party_phone(new.phone,case when tg_table_name='whatsapp_global_suppressions' then null else (to_jsonb(new)->>'workspace_id')::uuid end);
  return new;
end $$;
create trigger first_party_global_stop after insert on public.whatsapp_global_suppressions for each row execute function app.first_party_suppression_hook();
create trigger first_party_workspace_stop after insert on public.whatsapp_suppressions for each row execute function app.first_party_suppression_hook();

-- Called only by trusted signed-Meta parsing or the bound adapter after accepted
-- HTTP. Opaque correlation resolves ownership; caller cannot choose tenant/claim.
create function public.cetld_core_record_first_party_receipt(p_callback_token text,p_waba_id text,p_phone_number_id text,p_phone text,p_message_id text,p_status text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare d app.first_party_reminder_dispatches%rowtype;i public.invoices%rowtype;s public.workspace_settings%rowtype;
  next_at timestamptz; rank_old integer;rank_new integer;
begin
  if p_status is null or p_status not in ('accepted','sent','delivered','read','failed') or p_message_id is null or length(p_message_id) not between 1 and 256 then return '{"ok":false}';end if;
  select * into d from app.first_party_reminder_dispatches where callback_token=p_callback_token;
  if d.claim_id is null or d.phone is distinct from p_phone or d.snapshot#>>'{template,wabaId}' is distinct from p_waba_id or d.snapshot#>>'{template,phoneNumberId}' is distinct from p_phone_number_id then return '{"ok":false}';end if;
  perform pg_advisory_xact_lock(hashtextextended(d.phone,0));
  select * into i from public.invoices where workspace_id=d.workspace_id and id=d.invoice_id for update;
  perform 1 from public.cetld_core_automation_delivery_claims where id=d.claim_id for update;
  select * into d from app.first_party_reminder_dispatches where claim_id=d.claim_id for update;
  if d.provider_message_id is not null and d.provider_message_id<>p_message_id then return '{"ok":false}';end if;
  if exists(select 1 from app.first_party_reminder_dispatches where provider_message_id=p_message_id and claim_id<>d.claim_id) then return '{"ok":false}';end if;
  insert into app.first_party_reminder_receipt_events(callback_token,provider_message_id,status)
    values(p_callback_token,p_message_id,p_status) on conflict do nothing;
  rank_old:=case d.state when 'accepted' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end;
  rank_new:=case p_status when 'accepted' then 1 when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 else 0 end;
  if rank_new=0 and rank_old>=2 then return '{"ok":true}';end if;
  update app.first_party_reminder_dispatches set state=case when rank_new>=rank_old then case p_status when 'sent' then 'accepted' else p_status end else state end,
    provider_message_id=p_message_id,receipt_at=coalesce(receipt_at,clock_timestamp()) where claim_id=d.claim_id;
  if rank_new=0 then
    update public.cetld_core_automation_delivery_claims set status='failed',provider_message_id=p_message_id,last_error='signed_provider_failure' where id=d.claim_id and status<>'sent';
    return '{"ok":true}';
  end if;
  update public.cetld_core_automation_delivery_claims set status='sent',provider_message_id=p_message_id,last_error=null where id=d.claim_id;
  update public.cetld_core_automation_messages set status='sent',provider_message_id=p_message_id where workspace_id=d.workspace_id and payload->>'claimId'=d.claim_id::text;
  if not d.counted and i.deleted_at is null then
    select * into s from public.workspace_settings where workspace_id=d.workspace_id for share;
    -- Already committed normal engine receipt/count wins. A recovered receipt
    -- never overwrites payment/pause/STOP/changed preferences or edited facts.
    if i.reminder_count<=d.count_before then
      next_at:=i.next_follow_up_at;
      if i.automation_version=(d.snapshot->>'invoiceVersion')::bigint and i.followup_state in ('approved','active','scheduled')
        and i.amount_paid<i.total_amount and i.status='sent' and i.metadata->>'invoice_direction'='receivable'
        and s.updated_at=(d.snapshot->>'preferencesUpdatedAt')::timestamptz
        and not exists(select 1 from public.whatsapp_global_suppressions where phone=d.phone)
        and not exists(select 1 from public.whatsapp_suppressions where workspace_id=d.workspace_id and phone=d.phone) then
        next_at:=app.core_next_contact(clock_timestamp()+make_interval(days=>coalesce((s.follow_up_preferences->>'cadenceDays')::integer,3)),s.follow_up_preferences,s.default_timezone);
        if i.reminder_count+1>=coalesce((s.follow_up_preferences->>'maxReminders')::integer,3) then next_at:=null;end if;
      end if;
      update public.invoices set reminder_count=reminder_count+1,last_follow_up_at=greatest(coalesce(last_follow_up_at,d.reserved_at),d.reserved_at),
        next_follow_up_at=next_at,followup_state=case when next_at is null and followup_state in ('approved','active','scheduled') then 'paused' else followup_state end
        where workspace_id=d.workspace_id and id=d.invoice_id;
    end if;
    update app.first_party_reminder_dispatches set counted=true where claim_id=d.claim_id;
  end if;
  return '{"ok":true}';
end $$;

create function public.cetld_core_quarantine_first_party_leases(p_owner_id uuid,p_workspace_id uuid,p_now timestamptz default clock_timestamp())
returns integer language plpgsql security definer set search_path='' as $$
declare target record;n integer:=0;
begin
  if not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=p_owner_id) then return 0;end if;
  -- Includes a worker killed after core authorization but before gate reservation.
  for target in select c.id,c.invoice_id,coalesce(d.phone,x.phone,'invoice:'||c.invoice_id::text) as phone
    from public.cetld_core_automation_delivery_claims c join public.invoices i on i.workspace_id=c.workspace_id and i.id=c.invoice_id
    left join public.customers x on x.workspace_id=i.workspace_id and x.id=i.customer_id
    left join app.first_party_reminder_dispatches d on d.claim_id=c.id
    where c.workspace_id=p_workspace_id and c.status='sending' and c.lease_until<=p_now
    order by coalesce(d.phone,x.phone,'invoice:'||c.invoice_id::text) collate "C",c.invoice_id loop
    perform pg_advisory_xact_lock(hashtextextended(target.phone,0));
    perform 1 from public.invoices where workspace_id=p_workspace_id and id=target.invoice_id for update;
    perform 1 from public.cetld_core_automation_delivery_claims where id=target.id for update;
    update public.cetld_core_automation_delivery_claims set status='quarantined',last_error='dispatch_lease_expired'
      where id=target.id and status='sending' and lease_until<=p_now;
    if found then
      update app.first_party_reminder_dispatches set state='uncertain',last_error='dispatch_lease_expired' where claim_id=target.id and state='reserved';n:=n+1;
    end if;
  end loop;
  return n;
end $$;
revoke all on function app.reminder_canonical_json(jsonb),app.cancel_first_party_phone(text,uuid),app.first_party_suppression_hook(),
  app.first_party_template_revision_guard(),app.first_party_receipt_audit_guard(),app.first_party_consent_phone_lock() from public,anon,authenticated,service_role;
revoke all on function public.cetld_core_check_local_reminder_payment(uuid,uuid,uuid),public.cetld_core_authorize_first_party_reminder(uuid,uuid,uuid,jsonb,text),
  public.cetld_core_record_first_party_receipt(text,text,text,text,text,text),public.cetld_core_quarantine_first_party_leases(uuid,uuid,timestamptz),
  public.cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid),public.cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.cetld_core_check_local_reminder_payment(uuid,uuid,uuid),public.cetld_core_authorize_first_party_reminder(uuid,uuid,uuid,jsonb,text),
  public.cetld_core_record_first_party_receipt(text,text,text,text,text,text),public.cetld_core_quarantine_first_party_leases(uuid,uuid,timestamptz),
  public.cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid),public.cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz) to service_role;
commit;
