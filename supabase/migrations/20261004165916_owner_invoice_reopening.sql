-- REVIEW DRAFT. Unapplied; production installation needs separate approval.
-- Reopening reverses local invoice allocations, never deletes a receipt or
-- sends a refund. The owner must confirm a versioned preview in a later event.
begin;
create table public.invoice_reopening_proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,owner_id uuid not null,phone text not null,
  invoice_id uuid not null,source_message_id text not null unique,
  invoice_number text not null,currency text not null,amount numeric not null check(amount>=0 and scale(amount)<=2),
  expected_updated_at timestamptz not null,ledger_fingerprint text not null,
  payment_ids uuid[] not null,state text not null default 'pending' check(state in ('pending','confirmed','cancelled','expired')),
  created_at timestamptz not null default clock_timestamp(),expires_at timestamptz not null default clock_timestamp()+interval '10 minutes',
  decision_message_id text unique,result jsonb,
  foreign key(workspace_id,owner_id) references public.workspaces(id,owner_id) on delete cascade,
  foreign key(workspace_id,invoice_id) references public.invoices(workspace_id,id) on delete cascade
);
alter table public.invoice_reopening_proposals enable row level security;
alter table public.invoice_reopening_proposals force row level security;
revoke all on public.invoice_reopening_proposals from public,anon,authenticated,service_role;
grant select on public.invoice_reopening_proposals to service_role;

create table public.payment_reversals (
  id uuid primary key default gen_random_uuid(),workspace_id uuid not null,
  invoice_id uuid not null,payment_id uuid not null,proposal_id uuid not null references public.invoice_reopening_proposals(id),
  amount numeric not null check(amount>0 and scale(amount)<=2),actor_id uuid not null references auth.users(id),
  reason text not null default 'owner_invoice_reopening' check(reason='owner_invoice_reopening'),
  recorded_at timestamptz not null default clock_timestamp(),
  unique(workspace_id,payment_id),
  foreign key(workspace_id,payment_id) references public.payments(workspace_id,id),
  foreign key(workspace_id,invoice_id) references public.invoices(workspace_id,id),
  foreign key(workspace_id,actor_id) references public.workspaces(id,owner_id)
);
alter table public.payment_reversals enable row level security;
alter table public.payment_reversals force row level security;
revoke all on public.payment_reversals from public,anon,authenticated,service_role;
grant select on public.payment_reversals to authenticated,service_role;
create policy owner_payment_reversals_read on public.payment_reversals for select to authenticated
using(exists(select 1 from public.workspaces w where w.id=workspace_id and w.owner_id=auth.uid()));

create or replace function app.guard_reversal_audit() returns trigger
language plpgsql security definer set search_path='' as $$
declare p public.payments%rowtype;
begin
  if tg_op<>'INSERT' then raise exception 'reversal audit is immutable' using errcode='42501'; end if;
  select * into p from public.payments where workspace_id=new.workspace_id and id=new.payment_id;
  if not found or p.invoice_id<>new.invoice_id or p.amount<>new.amount then
    raise exception 'reversal must retain the original allocation amount' using errcode='22023'; end if;
  return new;
end; $$;
revoke all on function app.guard_reversal_audit() from public,anon,authenticated,service_role;
create trigger payment_reversal_audit_guard before insert or update or delete on public.payment_reversals
for each row execute function app.guard_reversal_audit();

create or replace function app.protect_reversed_payment() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from public.payment_reversals r where r.workspace_id=old.workspace_id and r.payment_id=old.id) then
    raise exception 'a reversed payment remains immutable audit history' using errcode='42501'; end if;
  if tg_op='DELETE' then return old; end if;return new;
end; $$;
revoke all on function app.protect_reversed_payment() from public,anon,authenticated,service_role;
create trigger reversed_payment_history_guard before update or delete on public.payments
for each row execute function app.protect_reversed_payment();

create or replace function public.whatsapp_invoice_reopening(
  p_workspace_id uuid,p_owner_id uuid,p_phone text,p_message_id text,p_user_message text,
  p_action text,p_invoice_id uuid default null,p_proposal_id uuid default null,
  p_pending_id bigint default null,p_pending_version bigint default null,p_interaction_id text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  o record;e public.whatsapp_inbound_events%rowtype;i public.invoices%rowtype;
  a public.whatsapp_pending_actions%rowtype;q public.invoice_reopening_proposals%rowtype;
  receipt public.whatsapp_direct_write_receipts%rowtype;v_result jsonb;v_request jsonb;
  v_sum numeric;v_ids uuid[];v_fingerprint text;v_generation bigint;v_stored record;
  v_now timestamptz:=clock_timestamp();v_today date;v_reversals integer;v_confirm boolean;
begin
  if coalesce(nullif(current_setting('request.jwt.claim.role',true),''),auth.role(),'')<>'service_role'
    or p_action is null or p_action not in ('prepare','confirm','cancel') or p_workspace_id is null or p_owner_id is null
    or p_phone is null or p_phone!~'^\+[1-9][0-9]{7,14}$' or p_message_id is null
    or length(p_message_id) not between 1 and 256 or p_user_message is null or length(p_user_message)>4000 then
    return jsonb_build_object('ok',false,'code','INVALID');end if;
  select * into o from public.whatsapp_resolve_verified_owner(p_phone) x
    where x.workspace_id=p_workspace_id and x.owner_id=p_owner_id;
  if not found then return jsonb_build_object('ok',false,'code','DENIED');end if;
  select * into e from public.whatsapp_inbound_events where provider_message_id=p_message_id and sender_phone=p_phone
    and status in ('processing','done');
  if not found or e.message_text is distinct from p_user_message then return jsonb_build_object('ok',false,'code','DENIED');end if;
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||':'||o.customer_id::text||':'||p_phone,0));
  v_request:=jsonb_build_object('operation','invoice.reopen.'||p_action,'proposalId',p_proposal_id,'interactionId',p_interaction_id);
  select * into receipt from public.whatsapp_direct_write_receipts where provider_message_id=p_message_id;
  if found then
    if receipt.workspace_id<>p_workspace_id or receipt.owner_id<>p_owner_id or receipt.phone<>p_phone or receipt.request<>v_request then
      return jsonb_build_object('ok',false,'code','REPLAY_MISMATCH');end if;
    return receipt.result||jsonb_build_object('replayed',true);end if;
  if p_action='prepare' then
    if p_invoice_id is null or p_proposal_id is not null or p_interaction_id is not null then return jsonb_build_object('ok',false,'code','INVALID');end if;
    select * into q from public.invoice_reopening_proposals where source_message_id=p_message_id;
    if found then
      if q.workspace_id<>p_workspace_id or q.owner_id<>p_owner_id or q.invoice_id<>p_invoice_id then return jsonb_build_object('ok',false,'code','REPLAY_MISMATCH');end if;
      if q.state<>'pending' or q.expires_at<=v_now then return jsonb_build_object('ok',false,'code','EXPIRED');end if;
      select * into a from public.whatsapp_pending_actions x where x.workspace_id=p_workspace_id and x.customer_id=o.customer_id
        and x.phone=p_phone and x.consumed_at is null and x.action->>'type'='owner_invoice_reopen' and x.action->>'proposalId'=q.id::text;
      if not found then
        return jsonb_build_object('ok',false,'code','STALE');end if;
      return jsonb_build_object('ok',true,'proposal',true,'requiresConfirmation',true,'replayed',true,'proposalId',q.id,
        'invoiceNumber',q.invoice_number,'currency',q.currency,'reversalAmount',q.amount,'balanceAfter',a.action->'balanceAfter','paymentCount',cardinality(q.payment_ids),'expiresAt',q.expires_at,'cashRefund',false);
    end if;
    select * into a from public.whatsapp_pending_actions where workspace_id=p_workspace_id and customer_id=o.customer_id and phone=p_phone
      and consumed_at is null order by generation desc limit 1 for update;
    if found and a.action->>'type'<>'owner_invoice_request' then return jsonb_build_object('ok',false,'code','PENDING');end if;
  else
    select * into a from public.whatsapp_pending_actions where workspace_id=p_workspace_id and customer_id=o.customer_id and phone=p_phone
      and id=p_pending_id and version=p_pending_version and consumed_at is null for update;
    if not found or a.action->>'type'<>'owner_invoice_reopen' or a.action->>'proposalId' is distinct from p_proposal_id::text then
      return jsonb_build_object('ok',false,'code','NO_PENDING_ACTION');end if;
    select * into q from public.invoice_reopening_proposals where id=p_proposal_id and workspace_id=p_workspace_id and owner_id=p_owner_id
      and phone=p_phone and state='pending' for update;
    if not found or q.source_message_id=p_message_id or a.action->>'sourceMessageId' is distinct from q.source_message_id
      or e.received_at<a.created_at or (e.provider_timestamp is not null and e.provider_timestamp+interval '1 second'<a.created_at) then
      return jsonb_build_object('ok',false,'code','STALE');end if;
    if q.expires_at<=v_now then
      update public.invoice_reopening_proposals set state='expired' where id=q.id;
      update public.whatsapp_pending_actions set consumed_at=v_now where id=a.id;
      return jsonb_build_object('ok',false,'code','EXPIRED');end if;
    if p_interaction_id is not null then
      if e.interaction_id is distinct from p_interaction_id or p_interaction_id!~'^oab1\.' then return jsonb_build_object('ok',false,'code','INVALID');end if;
    elsif p_action='confirm' and p_user_message!~*'^\s*(yes|y|ok|okay|confirm|confirmed|do it|go ahead|proceed|approve)\s*[.!]?\s*$'
      or p_action='cancel' and p_user_message!~*'^\s*(no|cancel|never mind|nevermind|discard)\s*[.!]?\s*$' then
      return jsonb_build_object('ok',false,'code','INVALID');end if;
    if p_action='cancel' then
      update public.invoice_reopening_proposals set state='cancelled',decision_message_id=p_message_id where id=q.id;
      update public.whatsapp_pending_actions set consumed_at=v_now where id=a.id;
      v_result:=jsonb_build_object('ok',true,'completed',true,'action','pending.cancelled','entityType','pending','entityId',a.id::text,'cashRefund',false);
      insert into public.whatsapp_direct_write_receipts(provider_message_id,workspace_id,owner_id,phone,idempotency_key,request,result)
        values(p_message_id,p_workspace_id,p_owner_id,p_phone,'ownerreopen_'||md5(p_message_id),v_request,v_result);
      return v_result;
    end if;
    p_invoice_id:=q.invoice_id;
  end if;
  select * into i from public.invoices where workspace_id=p_workspace_id and id=p_invoice_id and deleted_at is null for update;
  if not found then return jsonb_build_object('ok',false,'code','NOT_FOUND');end if;
  if not app.currency_uses_two_decimal_precision(i.currency) or i.total_amount<=0 or i.total_amount>999999999999.99
    or scale(i.total_amount)>2 or scale(i.amount_paid)>2 then return jsonb_build_object('ok',false,'code','PAYMENT_GUARD');end if;
  if i.status::text in ('void','cancelled') then return jsonb_build_object('ok',false,'code','PAYMENT_GUARD');end if;
  perform 1 from public.payments where workspace_id=p_workspace_id and invoice_id=i.id for update;
  if coalesce(to_jsonb(i)->>'external_provider',i.metadata->>'accounting_provider','')<>''
    or coalesce(to_jsonb(i)->>'external_invoice_id','')<>''
    or exists(select 1 from public.payments p where p.workspace_id=p_workspace_id and p.invoice_id=i.id and
      (coalesce(to_jsonb(p)->>'external_provider',p.metadata->>'accounting_provider','')<>'' or coalesce(to_jsonb(p)->>'external_payment_id','')<>'')) then
    return jsonb_build_object('ok',false,'code','EXTERNAL_LEDGER');end if;
  perform 1 from public.cetld_core_automation_delivery_claims where workspace_id=p_workspace_id and invoice_id=i.id and status='sending' for update;
  if found then return jsonb_build_object('ok',false,'code','IN_USE');end if;
  select coalesce(sum(p.amount) filter(where r.payment_id is null),0),
    coalesce(array_agg(p.id order by p.id) filter(where r.payment_id is null),'{}'::uuid[]),
    md5(coalesce(jsonb_agg(jsonb_build_object('payment',to_jsonb(p),'reversal',to_jsonb(r)) order by p.id)::text,'[]'))
  into v_sum,v_ids,v_fingerprint from public.payments p left join public.payment_reversals r
    on r.workspace_id=p.workspace_id and r.payment_id=p.id where p.workspace_id=p_workspace_id and p.invoice_id=i.id;
  if v_sum<>i.amount_paid then return jsonb_build_object('ok',false,'code','LEDGER_MISMATCH');end if;
  if p_action='prepare' then
    if v_sum=0 and i.status::text<>'paid' then return jsonb_build_object('ok',true,'readOnly',true,'completed',false,'alreadyUnpaid',true,'requiresConfirmation',false,'invoiceNumber',i.invoice_number,'cashRefund',false);end if;
    insert into public.invoice_reopening_proposals(workspace_id,owner_id,phone,invoice_id,source_message_id,invoice_number,currency,amount,expected_updated_at,ledger_fingerprint,payment_ids)
      values(p_workspace_id,p_owner_id,p_phone,i.id,p_message_id,i.invoice_number,i.currency,v_sum,i.updated_at,v_fingerprint,v_ids) returning * into q;
    select coalesce(max(generation),0) into v_generation from public.whatsapp_pending_actions where workspace_id=p_workspace_id and customer_id=o.customer_id and phone=p_phone;
    select * into v_stored from public.whatsapp_store_pending_action(p_workspace_id,o.customer_id,p_phone,
      jsonb_build_object('type','owner_invoice_reopen','proposalId',q.id,'invoiceId',i.id,'invoiceNumber',i.invoice_number,'currency',i.currency,
        'reversalAmount',v_sum,'balanceAfter',i.total_amount,'paymentCount',cardinality(v_ids),'sourceMessageId',p_message_id,'expiresAt',q.expires_at),
      'whatsapp',v_generation,a.id,a.version);
    if not found then raise exception 'pending action changed' using errcode='Z0002';end if;
    return jsonb_build_object('ok',true,'proposal',true,'requiresConfirmation',true,'proposalId',q.id,'invoiceNumber',i.invoice_number,
      'currency',i.currency,'reversalAmount',v_sum,'balanceAfter',i.total_amount,'paymentCount',cardinality(v_ids),'expiresAt',q.expires_at,'cashRefund',false);
  end if;
  if i.updated_at is distinct from q.expected_updated_at or v_fingerprint<>q.ledger_fingerprint or v_sum<>q.amount or v_ids<>q.payment_ids then
    return jsonb_build_object('ok',false,'code','STALE');end if;
  insert into public.payment_reversals(workspace_id,invoice_id,payment_id,proposal_id,amount,actor_id)
    select p_workspace_id,i.id,p.id,q.id,p.amount,p_owner_id from public.payments p where p.workspace_id=p_workspace_id and p.invoice_id=i.id and p.id=any(q.payment_ids);
  get diagnostics v_reversals=row_count;
  if v_reversals<>cardinality(q.payment_ids) then raise exception 'reversal count changed' using errcode='Z0002';end if;
  select (v_now at time zone coalesce(s.default_timezone,'UTC'))::date into v_today from public.workspace_settings s where s.workspace_id=p_workspace_id;
  update public.invoices set amount_paid=0,status=case when due_date<coalesce(v_today,current_date) then 'overdue'::public.invoice_status else 'sent'::public.invoice_status end,
    followup_state='paused',next_follow_up_at=null,metadata=metadata||jsonb_build_object('outstanding_amount',total_amount,'followup_state','paused',
      'next_follow_up_at',null,'approved_reminder_text',null,'approved_preferences_updated_at',null)
    where workspace_id=p_workspace_id and id=i.id returning * into i;
  v_result:=jsonb_build_object('ok',true,'completed',true,'action','invoice.reopened','entityType','invoice','entityId',i.id::text,
    'updatedAt',i.updated_at,'invoiceNumber',i.invoice_number,'currency',i.currency,'reversedAmount',q.amount,'balanceAfter',i.total_amount,'paymentCount',v_reversals,
    'paymentHistoryPreserved',true,'cashRefund',false,'record',to_jsonb(i));
  update public.invoice_reopening_proposals set state='confirmed',decision_message_id=p_message_id,result=v_result where id=q.id;
  update public.whatsapp_pending_actions set consumed_at=v_now where id=a.id;
  insert into public.whatsapp_direct_write_receipts(provider_message_id,workspace_id,owner_id,phone,idempotency_key,request,result)
    values(p_message_id,p_workspace_id,p_owner_id,p_phone,'ownerreopen_'||md5(p_message_id),v_request,v_result);
  return v_result;
exception when others then
  return jsonb_build_object('ok',false,'code',case when sqlstate='Z0002' then 'STALE' else 'UNAVAILABLE' end,'diagnosticSqlState',sqlstate);
end; $$;
revoke all on function public.whatsapp_invoice_reopening(uuid,uuid,text,text,text,text,uuid,uuid,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.whatsapp_invoice_reopening(uuid,uuid,text,text,text,text,uuid,uuid,bigint,bigint,text) to service_role;
commit;
