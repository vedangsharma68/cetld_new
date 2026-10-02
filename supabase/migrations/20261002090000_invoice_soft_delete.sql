-- Reversible invoice deletion. This migration only adds lifecycle metadata and
-- guards; it does not rewrite invoice, payment, or reminder financial data.
begin;

do $preflight$
declare relation_name text; function_name text;
begin
  foreach relation_name in array array[
    'public.invoices','public.payments','public.customers','public.workspaces','public.workspace_members',
    'public.workspace_settings','public.invoice_files','public.whatsapp_inbound_events',
    'public.whatsapp_messages','public.whatsapp_pending_actions','public.whatsapp_invoice_update_claims',
    'public.whatsapp_consents','public.whatsapp_suppressions','public.whatsapp_global_suppressions',
    'public.cetld_core_automation_delivery_claims','public.cetld_core_automation_messages','public.cetld_core_automation_events'
  ] loop
    if pg_catalog.to_regclass(relation_name) is null then
      raise exception 'invoice lifecycle prerequisites are missing';
    end if;
  end loop;
  foreach function_name in array array[
    'auth.uid()','public.whatsapp_resolve_verified_owner(text)','public.whatsapp_claim_invoice_update(uuid,uuid,uuid,text,text,timestamptz)',
    'public.record_invoice_payment(uuid,uuid,numeric,text,text,boolean)',
    'public.cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid)',
    'public.cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz)',
    'public.cetld_core_mark_sent(uuid,uuid,uuid,uuid,text)','app.is_workspace_member(uuid,uuid)',
    'app.core_safe_followup_time(text)'
  ] loop
    if pg_catalog.to_regprocedure(function_name) is null then
      raise exception 'invoice lifecycle function prerequisites are missing';
    end if;
  end loop;
end;
$preflight$;

alter table public.invoices
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references auth.users(id) on delete restrict;

alter table public.invoices
  add constraint invoices_deleted_actor_pair_check
  check ((deleted_at is null) = (deleted_by is null)) not valid;
alter table public.invoices validate constraint invoices_deleted_actor_pair_check;

create index if not exists invoices_deleted_owner_at_idx
  on public.invoices(workspace_id, deleted_by, deleted_at desc)
  where deleted_at is not null;

create table public.invoice_lifecycle_proposals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  owner_id uuid not null,
  invoice_id uuid not null,
  actor_phone text check (actor_phone is null or actor_phone ~ '^\+[1-9][0-9]{7,14}$'),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9_-]{12,120}$'),
  request_message_id text check (request_message_id is null or length(request_message_id) between 1 and 256),
  confirmation_message_id text check (confirmation_message_id is null or length(confirmation_message_id) between 1 and 256),
  cancel_message_id text check (cancel_message_id is null or length(cancel_message_id) between 1 and 256),
  undo_request_message_id text check (undo_request_message_id is null or length(undo_request_message_id) between 1 and 256),
  undo_idempotency_key text check (undo_idempotency_key is null or undo_idempotency_key ~ '^[A-Za-z0-9_-]{12,120}$'),
  undo_actor_phone text check (undo_actor_phone is null or undo_actor_phone ~ '^\+[1-9][0-9]{7,14}$'),
  expected_updated_at timestamptz not null,
  invoice_number text not null check (length(invoice_number) between 1 and 100),
  customer_name text not null,
  total_amount numeric(18,2) not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  invoice_status public.invoice_status not null,
  requires_exact_confirmation boolean not null,
  had_payment boolean not null,
  had_sent_reminder boolean not null,
  state text not null default 'pending'
    check (state in ('pending','deleted','cancelled','expired','stale','restored')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  deleted_at timestamptz,
  restored_at timestamptz,
  undo_result jsonb,
  unique (workspace_id, owner_id, idempotency_key),
  foreign key (workspace_id, owner_id) references public.workspaces(id, owner_id) on delete cascade,
  foreign key (workspace_id, invoice_id) references public.invoices(workspace_id, id) on delete cascade
);

create unique index invoice_lifecycle_one_pending_per_owner_idx
  on public.invoice_lifecycle_proposals(workspace_id, owner_id)
  where state = 'pending';
create unique index invoice_lifecycle_request_message_unique
  on public.invoice_lifecycle_proposals(workspace_id, request_message_id)
  where request_message_id is not null;
create unique index invoice_lifecycle_confirmation_message_unique
  on public.invoice_lifecycle_proposals(confirmation_message_id)
  where confirmation_message_id is not null;
create unique index invoice_lifecycle_cancel_message_unique
  on public.invoice_lifecycle_proposals(cancel_message_id)
  where cancel_message_id is not null;
create unique index invoice_lifecycle_undo_key_unique
  on public.invoice_lifecycle_proposals(workspace_id, owner_id, undo_idempotency_key)
  where undo_idempotency_key is not null;
create unique index invoice_lifecycle_undo_message_unique
  on public.invoice_lifecycle_proposals(workspace_id, undo_request_message_id)
  where undo_request_message_id is not null;
create index invoice_lifecycle_owner_state_idx
  on public.invoice_lifecycle_proposals(workspace_id, owner_id, created_at desc);

-- A private transaction marker authorizes only the SECURITY DEFINER lifecycle
-- RPC's update to one locked invoice. Client-settable custom GUCs are not a
-- security boundary, so the trigger must not trust them.
create table app.invoice_lifecycle_write_context (
  backend_pid integer not null,
  transaction_id bigint not null,
  invoice_id uuid not null,
  primary key (backend_pid, transaction_id, invoice_id)
);
revoke all on app.invoice_lifecycle_write_context from public, anon, authenticated, service_role;

alter table public.invoice_lifecycle_proposals enable row level security;
alter table public.invoice_lifecycle_proposals force row level security;
revoke all on public.invoice_lifecycle_proposals from public, anon, authenticated, service_role;

create or replace function app.guard_invoice_lifecycle_columns()
returns trigger language plpgsql security definer set search_path = '' as $$
declare lifecycle_rpc boolean;
begin
  if tg_op = 'DELETE' then
    -- Keep normal workspace deletion and its FK cascades available.
    if exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
      raise exception 'invoice hard delete is disabled' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.deleted_at is not null or new.deleted_by is not null then
      raise exception 'invoice lifecycle fields are managed by the owner lifecycle RPC' using errcode = '42501';
    end if;
    return new;
  end if;
  select exists (
    select 1 from app.invoice_lifecycle_write_context c
    where c.backend_pid = pg_catalog.pg_backend_pid()
      and c.transaction_id = pg_catalog.txid_current()
      and c.invoice_id = old.id
  ) into lifecycle_rpc;
  if (old.deleted_at is not null or new.deleted_at is distinct from old.deleted_at
      or new.deleted_by is distinct from old.deleted_by) and not lifecycle_rpc then
    raise exception 'deleted invoices can only be restored through the owner lifecycle RPC' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function app.guard_invoice_lifecycle_columns() from public, anon, authenticated;
drop trigger if exists invoices_lifecycle_write_guard on public.invoices;
create trigger invoices_lifecycle_write_guard
  before insert or update or delete on public.invoices
  for each row execute function app.guard_invoice_lifecycle_columns();

create or replace function app.guard_payment_active_invoice()
returns trigger language plpgsql security definer set search_path = '' as $$
declare invoice_deleted_at timestamptz;
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.workspaces w where w.id = old.workspace_id)
       or not exists (select 1 from public.invoices i where i.workspace_id = old.workspace_id and i.id = old.invoice_id) then
      return old;
    end if;
    select i.deleted_at into invoice_deleted_at from public.invoices i
    where i.workspace_id = old.workspace_id and i.id = old.invoice_id for update;
    if invoice_deleted_at is not null then
      raise exception 'payments for deleted invoices are immutable' using errcode = '42501';
    end if;
    return old;
  end if;
  select i.deleted_at into invoice_deleted_at from public.invoices i
  where i.workspace_id = new.workspace_id and i.id = new.invoice_id for update;
  if not found or invoice_deleted_at is not null then
    raise exception 'payment requires an active invoice in this workspace' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function app.guard_payment_active_invoice() from public, anon, authenticated;
drop trigger if exists payments_require_active_invoice on public.payments;
create trigger payments_require_active_invoice
  before insert or update or delete on public.payments
  for each row execute function app.guard_payment_active_invoice();

drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices for select to authenticated
  using (app.is_workspace_member(workspace_id) and deleted_at is null);
drop policy if exists invoices_insert on public.invoices;
create policy invoices_insert on public.invoices for insert to authenticated
  with check (app.is_workspace_member(workspace_id) and deleted_at is null and deleted_by is null);
drop policy if exists invoices_update on public.invoices;
create policy invoices_update on public.invoices for update to authenticated
  using (app.is_workspace_member(workspace_id) and deleted_at is null)
  with check (app.is_workspace_member(workspace_id) and deleted_at is null and deleted_by is null);
drop policy if exists invoices_delete on public.invoices;
revoke delete on public.invoices from authenticated;

drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments for select to authenticated
  using (app.is_workspace_member(workspace_id) and exists (
    select 1 from public.invoices i where i.workspace_id = payments.workspace_id
      and i.id = payments.invoice_id and i.deleted_at is null));
drop policy if exists payments_insert on public.payments;
create policy payments_insert on public.payments for insert to authenticated
  with check (app.is_workspace_member(workspace_id) and exists (
    select 1 from public.invoices i where i.workspace_id = payments.workspace_id
      and i.id = payments.invoice_id and i.deleted_at is null));
drop policy if exists payments_update on public.payments;
create policy payments_update on public.payments for update to authenticated
  using (app.is_workspace_member(workspace_id) and exists (
    select 1 from public.invoices i where i.workspace_id = payments.workspace_id
      and i.id = payments.invoice_id and i.deleted_at is null))
  with check (app.is_workspace_member(workspace_id) and exists (
    select 1 from public.invoices i where i.workspace_id = payments.workspace_id
      and i.id = payments.invoice_id and i.deleted_at is null));
drop policy if exists payments_delete on public.payments;
create policy payments_delete on public.payments for delete to authenticated
  using (app.is_workspace_member(workspace_id) and exists (
    select 1 from public.invoices i where i.workspace_id = payments.workspace_id
      and i.id = payments.invoice_id and i.deleted_at is null));

drop policy if exists invoice_files_select on public.invoice_files;
create policy invoice_files_select on public.invoice_files for select to authenticated
  using (app.is_workspace_member(workspace_id) and exists (
    select 1 from public.invoices i where i.workspace_id = invoice_files.workspace_id
      and i.id = invoice_files.invoice_id and i.deleted_at is null));

create or replace function app.valid_invoice_file_path(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare parts text[]; ws uuid; inv uuid;
begin
  if p_name is null then return false; end if;
  parts := pg_catalog.string_to_array(p_name, '/');
  if coalesce(pg_catalog.array_length(parts, 1), 0) <> 3 or parts[3] = '' then return false; end if;
  if parts[1] !~ '^[0-9a-fA-F-]{36}$' or parts[2] !~ '^[0-9a-fA-F-]{36}$' then return false; end if;
  begin ws := parts[1]::uuid; inv := parts[2]::uuid;
  exception when invalid_text_representation then return false; end;
  return app.is_workspace_member(ws) and exists (
    select 1 from public.invoices i where i.workspace_id = ws and i.id = inv and i.deleted_at is null);
end;
$$;
revoke all on function app.valid_invoice_file_path(text) from public, anon;
grant execute on function app.valid_invoice_file_path(text) to authenticated;
grant execute on function app.valid_invoice_file_path(text) to service_role;

create or replace function public.invoice_lifecycle_action(
  p_action text,
  p_workspace_id uuid,
  p_invoice_id uuid default null,
  p_proposal_id uuid default null,
  p_invoice_number text default null,
  p_phone text default null,
  p_idempotency_key text default null,
  p_user_message text default null,
  p_request_message_id text default null,
  p_confirmation_message_id text default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_role text;
  v_owner_id uuid;
  v_phone text;
  v_is_service boolean := false;
  v_now timestamptz := pg_catalog.now();
  v_invoice public.invoices%rowtype;
  v_proposal public.invoice_lifecycle_proposals%rowtype;
  v_event public.whatsapp_inbound_events%rowtype;
  v_customer_name text;
  v_had_payment boolean;
  v_had_sent_reminder boolean;
  v_requires_exact boolean;
  v_active_dispatch boolean;
  v_match_count integer;
  v_result jsonb;
begin
  if p_action not in ('capabilities','pending','prepare','confirm','cancel','undo') or p_workspace_id is null then
    return jsonb_build_object('ok',false,'code','INVALID_REQUEST');
  end if;
  if p_user_message is not null and pg_catalog.length(p_user_message) > 4000 then
    return jsonb_build_object('ok',false,'code','INVALID_REQUEST');
  end if;
  v_role := coalesce(nullif(pg_catalog.current_setting('request.jwt.claim.role', true),''), auth.role(), '');
  v_is_service := v_role = 'service_role';
  if v_is_service then
    if p_phone is null or p_phone !~ '^\+[1-9][0-9]{7,14}$' then
      return jsonb_build_object('ok',false,'code','OWNER_REQUIRED');
    end if;
    select count(*)::integer into v_match_count
    from public.whatsapp_resolve_verified_owner(p_phone) r
    where r.workspace_id = p_workspace_id;
    if v_match_count <> 1 then return jsonb_build_object('ok',false,'code','OWNER_REQUIRED'); end if;
    select r.owner_id into v_owner_id
    from public.whatsapp_resolve_verified_owner(p_phone) r
    where r.workspace_id = p_workspace_id;
    v_phone := p_phone;
  else
    if auth.uid() is null or p_phone is not null then
      return jsonb_build_object('ok',false,'code','OWNER_REQUIRED');
    end if;
    select w.owner_id into v_owner_id
    from public.workspaces w
    join public.workspace_members m on m.workspace_id = w.id and m.user_id = w.owner_id and m.role = 'owner'
    where w.id = p_workspace_id and w.owner_id = auth.uid();
    if not found or v_owner_id is distinct from auth.uid() then
      return jsonb_build_object('ok',false,'code','OWNER_REQUIRED');
    end if;
    v_phone := null;
  end if;

  if p_action = 'capabilities' then
    return jsonb_build_object('ok',true,'action','capabilities','available',true);
  end if;

  if v_is_service and p_action in ('prepare','cancel','undo') then
    if p_request_message_id is null or p_user_message is null
       or pg_catalog.length(p_request_message_id) not between 1 and 256 then
      return jsonb_build_object('ok',false,'code','INVALID_REQUEST');
    end if;
    select * into v_event from public.whatsapp_inbound_events e
    where e.provider_message_id = p_request_message_id
      and e.sender_phone = v_phone and e.message_text = p_user_message
      and e.status in ('processing','done')
    for update;
    if not found then return jsonb_build_object('ok',false,'code','INVALID_CONFIRMATION'); end if;
  end if;

  if p_action = 'pending' then
    update public.invoice_lifecycle_proposals p set state = 'expired'
    where p.workspace_id = p_workspace_id and p.owner_id = v_owner_id
      and p.state = 'pending' and p.expires_at <= v_now;
    select * into v_proposal from public.invoice_lifecycle_proposals p
    where p.workspace_id = p_workspace_id and p.owner_id = v_owner_id
      and p.actor_phone is not distinct from v_phone and p.state = 'pending'
    order by p.created_at desc limit 1 for update;
    if not found then
      return jsonb_build_object('ok',true,'action','proposal_loaded','pending',false);
    end if;
    return jsonb_build_object('ok',true,'action','proposal_loaded','pending',true,
      'proposalId',v_proposal.id,'invoiceId',v_proposal.invoice_id,'invoiceNumber',v_proposal.invoice_number,
      'customerName',v_proposal.customer_name,'totalAmount',v_proposal.total_amount::text,
      'currency',v_proposal.currency,'status',v_proposal.invoice_status::text,
      'expectedUpdatedAt',v_proposal.expected_updated_at,'expiresAt',v_proposal.expires_at,
      'requiresExactConfirmation',v_proposal.requires_exact_confirmation);
  end if;

  if p_action = 'prepare' then
    if p_invoice_id is null or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{12,120}$'
       or (p_request_message_id is not null and pg_catalog.length(p_request_message_id) not between 1 and 256) then
      return jsonb_build_object('ok',false,'code','INVALID_REQUEST');
    end if;
    select * into v_proposal from public.invoice_lifecycle_proposals p
    where p.workspace_id = p_workspace_id and p.owner_id = v_owner_id and p.idempotency_key = p_idempotency_key
    for update;
    if found then
      if v_proposal.invoice_id <> p_invoice_id or v_proposal.actor_phone is distinct from v_phone
         or v_proposal.request_message_id is distinct from p_request_message_id then
        return jsonb_build_object('ok',false,'code','INVALID_REQUEST');
      end if;
      if v_proposal.state = 'pending' and v_proposal.expires_at > v_now then
        return jsonb_build_object('ok',true,'action','proposal_created','proposalId',v_proposal.id,
          'invoiceId',v_proposal.invoice_id,'invoiceNumber',v_proposal.invoice_number,
          'customerName',v_proposal.customer_name,'totalAmount',v_proposal.total_amount::text,
          'currency',v_proposal.currency,'status',v_proposal.invoice_status::text,
          'expectedUpdatedAt',v_proposal.expected_updated_at,'expiresAt',v_proposal.expires_at,
          'requiresExactConfirmation',v_proposal.requires_exact_confirmation);
      end if;
      return jsonb_build_object('ok',false,'code',case when v_proposal.state = 'expired' then 'ACTION_EXPIRED' else 'ACTION_STALE' end);
    end if;
    if v_is_service then
      select * into v_proposal from public.invoice_lifecycle_proposals p
      where p.workspace_id = p_workspace_id and p.owner_id = v_owner_id
        and p.actor_phone = v_phone and p.request_message_id = p_request_message_id
      for update;
      if found then
        if v_proposal.invoice_id <> p_invoice_id then
          return jsonb_build_object('ok',false,'code','INVALID_REQUEST');
        end if;
        if v_proposal.state = 'pending' and v_proposal.expires_at > v_now then
          return jsonb_build_object('ok',true,'action','proposal_created','proposalId',v_proposal.id,
            'invoiceId',v_proposal.invoice_id,'invoiceNumber',v_proposal.invoice_number,
            'customerName',v_proposal.customer_name,'totalAmount',v_proposal.total_amount::text,
            'currency',v_proposal.currency,'status',v_proposal.invoice_status::text,
            'expectedUpdatedAt',v_proposal.expected_updated_at,'expiresAt',v_proposal.expires_at,
            'requiresExactConfirmation',v_proposal.requires_exact_confirmation,'replayed',true);
        end if;
        return jsonb_build_object('ok',false,'code',case when v_proposal.expires_at <= v_now then 'ACTION_EXPIRED' else 'ACTION_STALE' end);
      end if;
    end if;
    if v_is_service and (v_event.status <> 'processing' or v_event.received_at < v_now - interval '10 minutes') then
      return jsonb_build_object('ok',false,'code','INVALID_CONFIRMATION');
    end if;
    update public.invoice_lifecycle_proposals p set state = 'expired'
    where p.workspace_id = p_workspace_id and p.owner_id = v_owner_id
      and p.state = 'pending' and p.expires_at <= v_now;
    if exists (select 1 from public.invoice_lifecycle_proposals p
      where p.workspace_id = p_workspace_id and p.owner_id = v_owner_id and p.state = 'pending') then
      return jsonb_build_object('ok',false,'code','ACTION_PENDING');
    end if;
    select * into v_invoice from public.invoices i
    where i.workspace_id = p_workspace_id and i.id = p_invoice_id and i.deleted_at is null
    for update;
    if not found then return jsonb_build_object('ok',false,'code','INVOICE_NOT_FOUND'); end if;
    select c.name into v_customer_name from public.customers c
    where c.workspace_id = p_workspace_id and c.id = v_invoice.customer_id;
    if not found then return jsonb_build_object('ok',false,'code','INVOICE_NOT_FOUND'); end if;
    v_had_payment := v_invoice.status = 'paid' or v_invoice.amount_paid > 0 or exists (
      select 1 from public.payments p where p.workspace_id = p_workspace_id and p.invoice_id = v_invoice.id);
    v_had_sent_reminder := exists (
      select 1 from public.cetld_core_automation_delivery_claims c
      where c.workspace_id = p_workspace_id and c.invoice_id = v_invoice.id
        and c.status in ('sending','sent','quarantined'))
      or exists (select 1 from public.cetld_core_automation_messages m
        where m.workspace_id = p_workspace_id and m.invoice_id = v_invoice.id and m.kind = 'reminder'
          and m.status in ('accepted','sent','delivered','read','unknown'))
      or exists (select 1 from public.whatsapp_messages m
        where m.workspace_id = p_workspace_id and m.invoice_id = v_invoice.id
          and m.direction = 'outbound' and m.audience = 'customer' and m.kind = 'reminder'
          and m.status in ('accepted','sent','delivered','read','unknown'));
    v_requires_exact := v_had_payment or v_had_sent_reminder;
    insert into public.invoice_lifecycle_proposals(
      workspace_id,owner_id,invoice_id,actor_phone,idempotency_key,request_message_id,
      expected_updated_at,invoice_number,customer_name,total_amount,currency,invoice_status,
      requires_exact_confirmation,had_payment,had_sent_reminder,expires_at)
    values (p_workspace_id,v_owner_id,v_invoice.id,v_phone,p_idempotency_key,p_request_message_id,
      v_invoice.updated_at,v_invoice.invoice_number,v_customer_name,v_invoice.total_amount,v_invoice.currency,
      v_invoice.status,v_requires_exact,v_had_payment,v_had_sent_reminder,v_now+interval '10 minutes')
    returning * into v_proposal;
    return jsonb_build_object('ok',true,'action','proposal_created','proposalId',v_proposal.id,
      'invoiceId',v_proposal.invoice_id,'invoiceNumber',v_proposal.invoice_number,
      'customerName',v_proposal.customer_name,'totalAmount',v_proposal.total_amount::text,
      'currency',v_proposal.currency,'status',v_proposal.invoice_status::text,
      'expectedUpdatedAt',v_proposal.expected_updated_at,'expiresAt',v_proposal.expires_at,
      'requiresExactConfirmation',v_proposal.requires_exact_confirmation);
  end if;

  if p_action = 'confirm' then
    if p_proposal_id is null or p_confirmation_message_id is null or p_user_message is null
       or pg_catalog.length(p_confirmation_message_id) not between 1 and 256 then
      return jsonb_build_object('ok',false,'code','INVALID_REQUEST');
    end if;
    select * into v_proposal from public.invoice_lifecycle_proposals p
    where p.id = p_proposal_id and p.workspace_id = p_workspace_id and p.owner_id = v_owner_id
      and p.actor_phone is not distinct from v_phone
    for update;
    if not found then return jsonb_build_object('ok',false,'code','PROPOSAL_NOT_FOUND'); end if;
    if v_is_service then
      select * into v_event from public.whatsapp_inbound_events e
      where e.provider_message_id = p_confirmation_message_id and e.sender_phone = v_phone
        and e.message_text = p_user_message and e.status in ('processing','done')
      for update;
      if not found then return jsonb_build_object('ok',false,'code','INVALID_CONFIRMATION'); end if;
    end if;
    if v_proposal.state = 'deleted' and v_proposal.confirmation_message_id = p_confirmation_message_id then
      return jsonb_build_object('ok',true,'action','deleted','proposalId',v_proposal.id,
        'invoiceId',v_proposal.invoice_id,'invoiceNumber',v_proposal.invoice_number,
        'customerName',v_proposal.customer_name,'totalAmount',v_proposal.total_amount::text,
        'currency',v_proposal.currency,'status',v_proposal.invoice_status::text,'replayed',true);
    end if;
    if v_proposal.state <> 'pending' then
      return jsonb_build_object('ok',false,'code',case when v_proposal.state = 'deleted' then 'ALREADY_DELETED' else 'ACTION_STALE' end);
    end if;
    if v_is_service and (p_confirmation_message_id = v_proposal.request_message_id
       or v_event.status <> 'processing' or v_event.received_at < v_proposal.created_at) then
      return jsonb_build_object('ok',false,'code','INVALID_CONFIRMATION');
    end if;
    if v_proposal.expires_at <= v_now then
      update public.invoice_lifecycle_proposals set state = 'expired' where id = v_proposal.id;
      return jsonb_build_object('ok',false,'code','ACTION_EXPIRED');
    end if;
    select * into v_invoice from public.invoices i
    where i.workspace_id = p_workspace_id and i.id = v_proposal.invoice_id
    for update;
    if not found or v_invoice.deleted_at is not null then
      update public.invoice_lifecycle_proposals set state = 'stale' where id = v_proposal.id;
      return jsonb_build_object('ok',false,'code','ALREADY_DELETED');
    end if;
    if v_invoice.updated_at is distinct from v_proposal.expected_updated_at then
      update public.invoice_lifecycle_proposals set state = 'stale' where id = v_proposal.id;
      return jsonb_build_object('ok',false,'code','ACTION_STALE');
    end if;
    v_had_payment := v_invoice.status = 'paid' or v_invoice.amount_paid > 0 or exists (
      select 1 from public.payments p where p.workspace_id = p_workspace_id and p.invoice_id = v_invoice.id);
    v_had_sent_reminder := exists (
      select 1 from public.cetld_core_automation_delivery_claims c
      where c.workspace_id = p_workspace_id and c.invoice_id = v_invoice.id
        and c.status in ('sending','sent','quarantined'))
      or exists (select 1 from public.cetld_core_automation_messages m
        where m.workspace_id = p_workspace_id and m.invoice_id = v_invoice.id and m.kind = 'reminder'
          and m.status in ('accepted','sent','delivered','read','unknown'))
      or exists (select 1 from public.whatsapp_messages m
        where m.workspace_id = p_workspace_id and m.invoice_id = v_invoice.id
          and m.direction = 'outbound' and m.audience = 'customer' and m.kind = 'reminder'
          and m.status in ('accepted','sent','delivered','read','unknown'));
    if (v_had_payment and not v_proposal.had_payment)
       or (v_had_sent_reminder and not v_proposal.had_sent_reminder) then
      update public.invoice_lifecycle_proposals set state = 'stale' where id = v_proposal.id;
      return jsonb_build_object('ok',false,'code','ACTION_STALE');
    end if;
    v_requires_exact := v_proposal.requires_exact_confirmation or v_had_payment or v_had_sent_reminder;
    if v_requires_exact then
      if p_user_message <> ('DELETE ' || v_invoice.invoice_number) then
        return jsonb_build_object('ok',false,'code','EXACT_CONFIRMATION_REQUIRED');
      end if;
    elsif pg_catalog.lower(pg_catalog.btrim(p_user_message)) <> 'yes' then
      return jsonb_build_object('ok',false,'code','INVALID_CONFIRMATION');
    end if;
    select exists (select 1 from public.cetld_core_automation_delivery_claims c
      where c.workspace_id = p_workspace_id and c.invoice_id = v_invoice.id
        and c.status = 'sending')
    into v_active_dispatch;
    if v_active_dispatch then return jsonb_build_object('ok',false,'code','ACTION_PENDING'); end if;

    insert into app.invoice_lifecycle_write_context(backend_pid,transaction_id,invoice_id)
    values (pg_catalog.pg_backend_pid(),pg_catalog.txid_current(),v_invoice.id);
    update public.invoices set deleted_at = v_now, deleted_by = v_owner_id,
      followup_state = 'cancelled', next_follow_up_at = null,
      metadata = pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(metadata,'{followup_state}','"cancelled"'::jsonb,true),
        '{next_follow_up_at}','null'::jsonb,true)
    where workspace_id = p_workspace_id and id = v_invoice.id;
    delete from app.invoice_lifecycle_write_context
    where backend_pid = pg_catalog.pg_backend_pid() and transaction_id = pg_catalog.txid_current()
      and invoice_id = v_invoice.id;

    update public.cetld_core_automation_delivery_claims set status = 'cancelled', delivery_token = null
    where workspace_id = p_workspace_id and invoice_id = v_invoice.id
      and status in ('claimed','failed');
    update public.cetld_core_automation_messages set status = 'blocked'
    where workspace_id = p_workspace_id and invoice_id = v_invoice.id and kind = 'reminder'
      and status = 'pending';
    update public.whatsapp_messages set status = 'blocked', updated_at = v_now
    where workspace_id = p_workspace_id and invoice_id = v_invoice.id and direction = 'outbound'
      and audience = 'customer' and kind = 'reminder' and status = 'pending';
    update public.whatsapp_pending_actions set consumed_at = v_now
    where workspace_id = p_workspace_id and consumed_at is null
      and action->>'invoiceId' = v_invoice.id::text;
    update public.invoice_lifecycle_proposals set state = 'deleted', deleted_at = v_now,
      confirmation_message_id = p_confirmation_message_id
    where id = v_proposal.id;
    insert into public.cetld_core_automation_events(workspace_id,invoice_id,type,idempotency_key,metadata)
    values (p_workspace_id,v_invoice.id,'invoice_deleted','invoice_delete:'||v_proposal.id::text,
      pg_catalog.jsonb_build_object('proposal_id',v_proposal.id,'owner_id',v_owner_id,
        'invoice_number',v_invoice.invoice_number,'deleted_at',v_now))
    on conflict (workspace_id,idempotency_key) do nothing;
    return jsonb_build_object('ok',true,'action','deleted','proposalId',v_proposal.id,
      'invoiceId',v_invoice.id,'invoiceNumber',v_invoice.invoice_number,
      'customerName',v_proposal.customer_name,'totalAmount',v_proposal.total_amount::text,
      'currency',v_proposal.currency,'status',v_proposal.invoice_status::text,
      'requiresExactConfirmation',v_requires_exact);
  end if;

  if p_action = 'cancel' then
    if p_proposal_id is null then return jsonb_build_object('ok',false,'code','INVALID_REQUEST'); end if;
    select * into v_proposal from public.invoice_lifecycle_proposals p
    where p.id = p_proposal_id and p.workspace_id = p_workspace_id and p.owner_id = v_owner_id
      and p.actor_phone is not distinct from v_phone
    for update;
    if not found then return jsonb_build_object('ok',false,'code','PROPOSAL_NOT_FOUND'); end if;
    if v_is_service and p_request_message_id = v_proposal.request_message_id then
      return jsonb_build_object('ok',false,'code','INVALID_CONFIRMATION');
    end if;
    if v_proposal.state = 'cancelled' and v_proposal.cancel_message_id is not null
       and v_proposal.cancel_message_id = coalesce(p_request_message_id,p_confirmation_message_id) then
      return jsonb_build_object('ok',true,'action','cancelled','proposalId',v_proposal.id,
        'invoiceId',v_proposal.invoice_id,'invoiceNumber',v_proposal.invoice_number,'replayed',true);
    end if;
    if v_proposal.state <> 'pending' then
      return jsonb_build_object('ok',false,'code',case when v_proposal.expires_at <= v_now then 'ACTION_EXPIRED' else 'ACTION_STALE' end);
    end if;
    if v_is_service and (v_event.status <> 'processing' or v_event.received_at < v_proposal.created_at) then
      return jsonb_build_object('ok',false,'code','INVALID_CONFIRMATION');
    end if;
    if v_proposal.expires_at <= v_now then
      update public.invoice_lifecycle_proposals set state = 'expired' where id = v_proposal.id;
      return jsonb_build_object('ok',false,'code','ACTION_EXPIRED');
    end if;
    update public.invoice_lifecycle_proposals set state = 'cancelled',
      cancel_message_id = coalesce(p_request_message_id,p_confirmation_message_id)
    where id = v_proposal.id;
    return jsonb_build_object('ok',true,'action','cancelled','proposalId',v_proposal.id,
      'invoiceId',v_proposal.invoice_id,'invoiceNumber',v_proposal.invoice_number);
  end if;

  if p_action = 'undo' then
    if (p_invoice_id is null) = (p_invoice_number is null)
       or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9_-]{12,120}$'
       or (p_invoice_number is not null and pg_catalog.length(p_invoice_number) not between 1 and 100) then
      return jsonb_build_object('ok',false,'code','INVALID_REQUEST');
    end if;
    if v_is_service then
      select * into v_proposal from public.invoice_lifecycle_proposals p
      where p.workspace_id = p_workspace_id and p.owner_id = v_owner_id
        and p.undo_actor_phone = v_phone and p.undo_request_message_id = p_request_message_id
      for update;
      if found then
        if (p_invoice_id is not null and p_invoice_id <> v_proposal.invoice_id)
           or (p_invoice_number is not null and p_invoice_number <> v_proposal.invoice_number)
           or v_proposal.undo_idempotency_key is distinct from p_idempotency_key
           or pg_catalog.lower(pg_catalog.btrim(coalesce(p_user_message,''))) not in (
             'undo delete ' || pg_catalog.lower(v_proposal.invoice_number),
             'undo ' || pg_catalog.lower(v_proposal.invoice_number),
             'restore ' || pg_catalog.lower(v_proposal.invoice_number)) then
          return jsonb_build_object('ok',false,'code','REPLAYED');
        end if;
        if v_proposal.state = 'restored' and v_proposal.undo_result is not null then
          return v_proposal.undo_result || pg_catalog.jsonb_build_object('replayed',true);
        end if;
        return jsonb_build_object('ok',false,'code','ACTION_STALE');
      end if;
    end if;
    select * into v_proposal from public.invoice_lifecycle_proposals p
    where p.workspace_id = p_workspace_id and p.owner_id = v_owner_id
      and p.undo_idempotency_key = p_idempotency_key
    for update;
    if found then
      if (p_invoice_id is not null and p_invoice_id <> v_proposal.invoice_id)
         or (p_invoice_number is not null and p_invoice_number <> v_proposal.invoice_number)
         or v_proposal.undo_actor_phone is distinct from v_phone
         or (v_is_service and v_proposal.undo_request_message_id is distinct from p_request_message_id)
         or (not v_is_service and v_proposal.undo_request_message_id is not null)
         or (v_is_service and pg_catalog.lower(pg_catalog.btrim(coalesce(p_user_message,''))) not in (
           'undo delete ' || pg_catalog.lower(v_proposal.invoice_number),
           'undo ' || pg_catalog.lower(v_proposal.invoice_number),
           'restore ' || pg_catalog.lower(v_proposal.invoice_number))) then
        return jsonb_build_object('ok',false,'code','REPLAYED');
      end if;
      if v_proposal.state = 'restored' and v_proposal.undo_result is not null then
        return v_proposal.undo_result || pg_catalog.jsonb_build_object('replayed',true);
      end if;
      return jsonb_build_object('ok',false,'code','ACTION_STALE');
    end if;
    select count(*)::integer into v_match_count from public.invoices i
    where i.workspace_id = p_workspace_id and i.deleted_by = v_owner_id and i.deleted_at is not null
      and ((p_invoice_id is not null and i.id = p_invoice_id)
        or (p_invoice_number is not null and i.invoice_number = p_invoice_number));
    if v_match_count = 0 then return jsonb_build_object('ok',false,'code','INVOICE_NOT_FOUND'); end if;
    if v_match_count > 1 then return jsonb_build_object('ok',false,'code','INVOICE_AMBIGUOUS'); end if;
    select * into v_invoice from public.invoices i
    where i.workspace_id = p_workspace_id and i.deleted_by = v_owner_id and i.deleted_at is not null
      and ((p_invoice_id is not null and i.id = p_invoice_id)
        or (p_invoice_number is not null and i.invoice_number = p_invoice_number))
    for update;
    if v_is_service and pg_catalog.lower(pg_catalog.btrim(coalesce(p_user_message,''))) not in (
      'undo delete ' || pg_catalog.lower(v_invoice.invoice_number),
      'undo ' || pg_catalog.lower(v_invoice.invoice_number),
      'restore ' || pg_catalog.lower(v_invoice.invoice_number)) then
      return jsonb_build_object('ok',false,'code','INVALID_CONFIRMATION');
    end if;
    select * into v_proposal from public.invoice_lifecycle_proposals p
    where p.workspace_id = p_workspace_id and p.owner_id = v_owner_id
      and p.invoice_id = v_invoice.id and p.state = 'deleted' and p.deleted_at = v_invoice.deleted_at
    order by p.created_at desc limit 1 for update;
    if not found then return jsonb_build_object('ok',false,'code','INVOICE_NOT_FOUND'); end if;
    if v_is_service and (v_event.status <> 'processing' or v_event.received_at < v_invoice.deleted_at) then
      return jsonb_build_object('ok',false,'code','INVALID_CONFIRMATION');
    end if;
    if v_invoice.deleted_at < v_now - interval '30 days' then
      return jsonb_build_object('ok',false,'code','UNDO_EXPIRED');
    end if;
    insert into app.invoice_lifecycle_write_context(backend_pid,transaction_id,invoice_id)
    values (pg_catalog.pg_backend_pid(),pg_catalog.txid_current(),v_invoice.id);
    update public.invoices set deleted_at = null, deleted_by = null,
      followup_state = case when status::text in ('paid','void','cancelled') or amount_paid >= total_amount then 'cancelled' else 'paused' end,
      next_follow_up_at = null,
      metadata = pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(metadata,'{followup_state}',
          case when status::text in ('paid','void','cancelled') or amount_paid >= total_amount then '"cancelled"'::jsonb else '"paused"'::jsonb end,true),
        '{next_follow_up_at}','null'::jsonb,true)
    where workspace_id = p_workspace_id and id = v_invoice.id
    returning * into v_invoice;
    delete from app.invoice_lifecycle_write_context
    where backend_pid = pg_catalog.pg_backend_pid() and transaction_id = pg_catalog.txid_current()
      and invoice_id = v_invoice.id;
    v_result := pg_catalog.jsonb_build_object('ok',true,'action','restored','proposalId',v_proposal.id,
      'invoiceId',v_invoice.id,'invoiceNumber',v_invoice.invoice_number,
      'status',v_invoice.status::text);
    update public.invoice_lifecycle_proposals set state = 'restored', restored_at = v_now,
      undo_idempotency_key = p_idempotency_key,
      undo_request_message_id = case when v_is_service then p_request_message_id else null end,
      undo_actor_phone = case when v_is_service then v_phone else null end,
      undo_result = v_result
    where id = v_proposal.id;
    return v_result;
  end if;

  return jsonb_build_object('ok',false,'code','INVALID_REQUEST');
end;
$$;

revoke all on function public.invoice_lifecycle_action(text,uuid,uuid,uuid,text,text,text,text,text,text)
  from public, anon;
grant execute on function public.invoice_lifecycle_action(text,uuid,uuid,uuid,text,text,text,text,text,text)
  to authenticated, service_role;

-- Keep the active due-reminder claim path aware of tombstones, even if a stale
-- followup_state value exists from an earlier release.
create or replace function public.cetld_core_claim_due_followups(
  p_owner_id uuid,p_workspace_id uuid,p_now timestamptz default now(),p_limit integer default 25,p_invoice_id uuid default null
) returns table(claim_id uuid,invoice_id uuid,invoice_version bigint)
language plpgsql security invoker set search_path = '' as $$
declare r record; c public.cetld_core_automation_delivery_claims%rowtype;
begin
  if not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=p_owner_id) then return; end if;
  for r in select i.id,i.next_follow_up_at,i.automation_version,s.updated_at
    from public.invoices i join public.workspace_settings s on s.workspace_id=i.workspace_id
    where i.workspace_id=p_workspace_id and i.deleted_at is null
      and (p_invoice_id is null or i.id=p_invoice_id)
      and i.followup_state in ('approved','active','scheduled') and i.next_follow_up_at<=p_now
      and i.status::text not in ('paid','void','cancelled') and i.amount_paid<i.total_amount and i.total_amount>0
      and i.due_date is not null and i.metadata->>'invoice_direction'='receivable'
      and nullif(pg_catalog.btrim(i.metadata->>'approved_reminder_text'),'') is not null
      and app.core_safe_followup_time(i.metadata->>'approved_preferences_updated_at')=s.updated_at
    order by i.next_follow_up_at,i.id limit greatest(1,least(p_limit,100)) for update of i skip locked
  loop
    insert into public.cetld_core_automation_delivery_claims(workspace_id,invoice_id,scheduled_for,invoice_version,preferences_updated_at,status,lease_until)
    values(p_workspace_id,r.id,r.next_follow_up_at,r.automation_version,r.updated_at,'claimed',p_now+interval '2 minutes')
    on conflict on constraint core_followup_claim_unique do update set
      invoice_version=excluded.invoice_version,preferences_updated_at=excluded.preferences_updated_at,
      status='claimed',attempts=public.cetld_core_automation_delivery_claims.attempts+1,
      lease_until=excluded.lease_until,delivery_token=null
      where public.cetld_core_automation_delivery_claims.attempts<3
        and (public.cetld_core_automation_delivery_claims.status in ('failed','cancelled')
          or (public.cetld_core_automation_delivery_claims.status='claimed' and public.cetld_core_automation_delivery_claims.lease_until<p_now))
    returning * into c;
    if found then claim_id:=c.id;invoice_id:=c.invoice_id;invoice_version:=c.invoice_version;return next; end if;
  end loop;
end;
$$;

create or replace function public.cetld_core_authorize_delivery(
  p_claim_id uuid,p_owner_id uuid,p_workspace_id uuid,p_preferences_version timestamptz default null
) returns table(authorized boolean,reason text,token uuid)
language plpgsql security invoker set search_path = '' as $$
declare
  c public.cetld_core_automation_delivery_claims%rowtype;
  i public.invoices%rowtype;
  s public.workspace_settings%rowtype;
  p jsonb;
  local_now timestamp;
  weekday integer;
  minute_now integer;
  start_minute integer;
  end_minute integer;
  max_count integer;
begin
  authorized:=false;reason:='not_found';token:=null;
  if not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=p_owner_id) then return next;return; end if;
  -- Discover the parent without locking, then take locks in invoice-before-
  -- claim order, matching due-claim creation and lifecycle deletion.
  select * into c from public.cetld_core_automation_delivery_claims
    where id=p_claim_id and workspace_id=p_workspace_id;
  if c.id is null then return next;return; end if;
  select * into i from public.invoices where id=c.invoice_id and workspace_id=p_workspace_id for update;
  if i.id is null then return next;return; end if;
  select * into c from public.cetld_core_automation_delivery_claims
    where id=p_claim_id and workspace_id=p_workspace_id and invoice_id=i.id for update;
  if c.id is null then return next;return; end if;
  select * into s from public.workspace_settings where workspace_id=p_workspace_id;
  if i.id is null or i.deleted_at is not null or s.workspace_id is null then reason:='ineligible_invoice';return next;return; end if;
  if c.status<>'claimed' then reason:='not_claimed';return next;return; end if;
  if c.invoice_version<>i.automation_version or c.preferences_updated_at<>s.updated_at
     or (p_preferences_version is not null and p_preferences_version<>s.updated_at) then reason:='stale_claim';return next;return; end if;
  if c.lease_until<=now() then reason:='expired';return next;return; end if;
  if i.followup_state not in ('approved','active','scheduled') or i.status::text in ('paid','void','cancelled')
    or i.total_amount<=0 or i.amount_paid>=i.total_amount or i.due_date is null
    or i.metadata->>'invoice_direction' is distinct from 'receivable'
    or nullif(pg_catalog.btrim(i.metadata->>'approved_reminder_text'),'') is null
    or app.core_safe_followup_time(i.metadata->>'approved_preferences_updated_at') is distinct from s.updated_at
    then reason:='ineligible_invoice';return next;return; end if;
  p:=s.follow_up_preferences;
  max_count:=coalesce((p->>'maxReminders')::integer,3);
  if i.reminder_count>=max_count then reason:='reminder_limit';return next;return; end if;
  local_now:=now() at time zone coalesce(nullif(s.default_timezone,''),'UTC');
  weekday:=extract(dow from local_now)::integer;
  if not exists(select 1 from jsonb_array_elements_text(coalesce(p->'allowedWeekdays','[1,2,3,4,5]'::jsonb)) day where day.value::integer=weekday) then reason:='weekday';return next;return; end if;
  minute_now:=extract(hour from local_now)::integer*60+extract(minute from local_now)::integer;
  start_minute:=split_part(coalesce(p->>'contactStart','09:00'),':',1)::integer*60+split_part(coalesce(p->>'contactStart','09:00'),':',2)::integer;
  end_minute:=split_part(coalesce(p->>'contactEnd','18:00'),':',1)::integer*60+split_part(coalesce(p->>'contactEnd','18:00'),':',2)::integer;
  if minute_now<start_minute or minute_now>=end_minute then reason:='contact_hours';return next;return; end if;
  token:=gen_random_uuid();authorized:=true;reason:=null;
  update public.cetld_core_automation_delivery_claims set status='sending',delivery_token=token,
    lease_until=now()+interval '2 minutes' where id=c.id;
  return next;
end;
$$;

create or replace function public.cetld_core_mark_sent(
  p_claim_id uuid,p_owner_id uuid,p_workspace_id uuid,p_token uuid,p_provider_message_id text
) returns table(ok boolean)
language plpgsql security invoker set search_path = '' as $$
declare
  invoice_id uuid;
  invoice_row public.invoices%rowtype;
begin
  ok:=false;
  select c.invoice_id into invoice_id from public.cetld_core_automation_delivery_claims c
  where c.id=p_claim_id and c.workspace_id=p_workspace_id
    and exists(select 1 from public.workspaces w where w.id=p_workspace_id and w.owner_id=p_owner_id);
  if not found then return next;return; end if;
  -- Lock the invoice first so sent-receipt handling serializes with deletion.
  select * into invoice_row from public.invoices i
  where i.workspace_id=p_workspace_id and i.id=invoice_id for update;
  if not found or invoice_row.deleted_at is not null then return next;return; end if;
  update public.cetld_core_automation_delivery_claims c set status='sent',provider_message_id=left(p_provider_message_id,250)
  where c.id=p_claim_id and c.workspace_id=p_workspace_id and c.invoice_id=invoice_row.id
    and c.status='sending' and c.delivery_token=p_token
    and exists(select 1 from public.workspaces w where w.id=p_workspace_id and w.owner_id=p_owner_id);
  ok:=found;
  if ok then update public.cetld_core_automation_messages set status='sent',provider_message_id=p_provider_message_id
    where workspace_id=p_workspace_id and payload->>'claimId'=p_claim_id::text; end if;
  return next;
end;
$$;

revoke execute on function public.cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid) from public,anon,authenticated;
revoke execute on function public.cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz) from public,anon,authenticated;
revoke execute on function public.cetld_core_mark_sent(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid) to service_role;
grant execute on function public.cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz) to service_role;
grant execute on function public.cetld_core_mark_sent(uuid,uuid,uuid,uuid,text) to service_role;

-- A queued customer invoice-update claim is also invalid after deletion.
create or replace function public.whatsapp_claim_invoice_update(
  p_workspace_id uuid,p_invoice_id uuid,p_customer_id uuid,p_phone text,
  p_idempotency_key text,p_expected_updated_at timestamptz
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_claimed integer := 0;
begin
  if p_idempotency_key !~ '^[A-Za-z0-9_-]{12,120}$' then
    raise exception 'Invalid WhatsApp idempotency key' using errcode = '23514';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_phone,0));
  insert into public.whatsapp_invoice_update_claims
    (workspace_id,invoice_id,customer_id,phone,idempotency_key,invoice_updated_at)
  select i.workspace_id,i.id,c.id,p_phone,p_idempotency_key,i.updated_at
  from public.invoices i
  join public.customers c on c.workspace_id=i.workspace_id and c.id=i.customer_id
  join public.workspace_settings s on s.workspace_id=i.workspace_id
  join public.whatsapp_consents wc on wc.workspace_id=i.workspace_id and wc.customer_id=c.id and wc.phone=p_phone
  where i.workspace_id=p_workspace_id and i.id=p_invoice_id and i.deleted_at is null
    and c.id=p_customer_id and c.phone=p_phone and i.updated_at=p_expected_updated_at
    and i.status::text in ('sent','paid')
    and wc.revoked_at is null and wc.source in ('verbal','inbound_message')
    and 'invoice_updates'=any(wc.categories)
    and not exists(select 1 from public.whatsapp_suppressions ws where ws.workspace_id=i.workspace_id and ws.phone=p_phone)
    and not exists(select 1 from public.whatsapp_global_suppressions gs where gs.phone=p_phone)
  on conflict (workspace_id,invoice_id,idempotency_key) do nothing;
  get diagnostics v_claimed=row_count;
  return v_claimed>0;
end;
$$;
revoke all on function public.whatsapp_claim_invoice_update(uuid,uuid,uuid,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.whatsapp_claim_invoice_update(uuid,uuid,uuid,text,text,timestamptz) to service_role;

-- Reject deleted invoices before the payment RPC can return an old idempotent
-- receipt or insert a new payment. The payment trigger is a second guard.
create or replace function public.record_invoice_payment(
  p_workspace_id uuid,p_invoice_id uuid,p_amount numeric,p_idempotency_key text,
  p_reference text,p_settle_remaining boolean
) returns public.payments
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  caller uuid := auth.uid();
  invoice_row public.invoices;
  existing_payment public.payments;
  created_payment public.payments;
  balance numeric;
  applied_amount numeric;
  normalized_reference text := nullif(btrim(p_reference),'');
begin
  if caller is null then raise exception 'authentication required' using errcode='42501'; end if;
  if p_workspace_id is null or not app.is_workspace_member(p_workspace_id,caller) then
    raise exception 'workspace access denied' using errcode='42501';
  end if;
  if p_idempotency_key is null or length(p_idempotency_key) not between 1 and 200 then
    raise exception 'idempotency key is required' using errcode='22023';
  end if;
  select * into invoice_row from public.invoices
  where workspace_id=p_workspace_id and id=p_invoice_id for update;
  if not found then raise exception 'invoice not found in this workspace' using errcode='42501'; end if;
  if invoice_row.deleted_at is not null then
    raise exception 'cannot record payment for a deleted invoice' using errcode='22023';
  end if;
  select * into existing_payment from public.payments
  where workspace_id=p_workspace_id and idempotency_key=p_idempotency_key;
  if found then
    if existing_payment.invoice_id<>p_invoice_id then
      raise exception 'idempotency key was already used for another invoice' using errcode='22023';
    end if;
    if p_settle_remaining is null or (p_settle_remaining and p_amount is not null)
       or existing_payment.settle_remaining is distinct from p_settle_remaining
       or existing_payment.reference is distinct from normalized_reference
       or (not p_settle_remaining and existing_payment.amount is distinct from p_amount) then
      raise exception 'idempotency key was reused with a different payment request' using errcode='22023';
    end if;
    return existing_payment;
  end if;
  if invoice_row.status in ('void'::public.invoice_status,'cancelled'::public.invoice_status) then
    raise exception 'cannot record payment for a void or cancelled invoice' using errcode='22023';
  end if;
  balance:=invoice_row.total_amount-invoice_row.amount_paid;
  if balance<=0 or invoice_row.status='paid'::public.invoice_status then
    raise exception 'invoice is already paid' using errcode='22023';
  end if;
  if p_settle_remaining then
    if p_amount is not null then raise exception 'settling the remaining balance does not accept an amount' using errcode='22023'; end if;
    applied_amount:=balance;
  else
    if p_amount is null or p_amount<=0 or scale(p_amount)>2 then
      raise exception 'payment amount must be positive with at most two decimal places' using errcode='22023';
    end if;
    if p_amount>balance then raise exception 'payment cannot exceed the invoice balance' using errcode='22023'; end if;
    applied_amount:=p_amount;
  end if;
  insert into public.payments(workspace_id,invoice_id,amount,reference,idempotency_key,settle_remaining)
  values(p_workspace_id,p_invoice_id,applied_amount,normalized_reference,p_idempotency_key,p_settle_remaining)
  on conflict (workspace_id,idempotency_key) where idempotency_key is not null do nothing
  returning * into created_payment;
  if not found then
    select * into existing_payment from public.payments
    where workspace_id=p_workspace_id and idempotency_key=p_idempotency_key;
    if p_settle_remaining is null or (p_settle_remaining and p_amount is not null)
       or existing_payment.invoice_id<>p_invoice_id
       or existing_payment.settle_remaining is distinct from p_settle_remaining
       or existing_payment.reference is distinct from normalized_reference
       or (not p_settle_remaining and existing_payment.amount is distinct from p_amount) then
      raise exception 'idempotency key was reused with a different payment request' using errcode='22023';
    end if;
    return existing_payment;
  end if;
  update public.invoices set amount_paid=amount_paid+applied_amount,
    status=case when amount_paid+applied_amount=total_amount then 'paid'::public.invoice_status else status end,
    metadata=case when amount_paid+applied_amount=total_amount
      then metadata||jsonb_build_object('followup_state','cancelled','next_follow_up_at',null) else metadata end
  where workspace_id=p_workspace_id and id=p_invoice_id;
  return created_payment;
end;
$$;
revoke all on function public.record_invoice_payment(uuid,uuid,numeric,text,text,boolean) from public,anon,authenticated;
grant execute on function public.record_invoice_payment(uuid,uuid,numeric,text,text,boolean) to authenticated;

commit;
