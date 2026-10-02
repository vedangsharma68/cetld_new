-- Configure owner routing from an authenticated dashboard; preserve existing records.
alter table public.workspace_settings add column whatsapp_owner_phone text
  check (whatsapp_owner_phone is null or whatsapp_owner_phone ~ '^\+[1-9][0-9]{7,14}$');
create unique index workspace_settings_owner_phone_unique
  on public.workspace_settings(whatsapp_owner_phone) where whatsapp_owner_phone is not null;

create or replace function app.guard_messaging_settings()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare p jsonb; key text; v text; minimum integer; maximum integer;
begin
  if new.business_name is null or length(btrim(new.business_name)) not between 1 and 200 then
    raise exception 'A business name is required'; end if;
  new.business_name:=btrim(new.business_name);
  if ((tg_op='INSERT' and new.whatsapp_owner_phone is not null) or
     (tg_op='UPDATE' and new.whatsapp_owner_phone is distinct from old.whatsapp_owner_phone)) and
     auth.uid() is not null and not exists(
       select 1 from public.workspaces where id=new.workspace_id and owner_id=auth.uid()) then
    raise exception 'Only the workspace owner can configure the owner number'; end if;
  if not exists(select 1 from pg_timezone_names where name=new.default_timezone) then
    raise exception 'Invalid timezone'; end if;
  p:=new.follow_up_preferences;
  if jsonb_typeof(p)<>'object' then raise exception 'Invalid follow-up preferences'; end if;
  foreach key in array array['firstReminderDays','cadenceDays','maxReminders'] loop
    if p ? key then
      minimum:=case key when 'firstReminderDays' then 0 else 1 end;
      maximum:=case key when 'maxReminders' then 20 else 90 end;
      v:=p->>key;
      if jsonb_typeof(p->key)<>'number' or v !~ '^[0-9]{1,2}$' or v::integer not between minimum and maximum then
        raise exception 'Invalid reminder timing or limit'; end if;
    end if;
  end loop;
  if p ? 'tone' and (jsonb_typeof(p->'tone')<>'string' or p->>'tone' not in ('gentle','professional','firm')) then raise exception 'Invalid tone'; end if;
  if p ? 'escalation' and (jsonb_typeof(p->'escalation')<>'string' or p->>'escalation' not in ('pause','manual_review')) then raise exception 'Invalid escalation'; end if;
  foreach key in array array['pauseOnReply','stopOnPayment','dailySummary'] loop
    if p ? key and jsonb_typeof(p->key)<>'boolean' then raise exception 'Invalid reminder option'; end if;
  end loop;
  if p->>'stopOnPayment'='false' then raise exception 'Paid invoices always stop reminders'; end if;
  if p ? 'allowedWeekdays' then
    if jsonb_typeof(p->'allowedWeekdays')<>'array' then raise exception 'Invalid weekdays'; end if;
    if jsonb_array_length(p->'allowedWeekdays') not between 1 and 7 then raise exception 'Choose weekdays'; end if;
    if exists(select 1 from jsonb_array_elements(p->'allowedWeekdays') day
      where jsonb_typeof(day)<>'number' or day::text !~ '^[0-6]$') then raise exception 'Invalid weekdays'; end if;
  end if;
  foreach key in array array['contactStart','contactEnd'] loop
    if p ? key and (jsonb_typeof(p->key)<>'string' or p->>key !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
      raise exception 'Invalid contact hours'; end if;
  end loop;
  if coalesce(p->>'contactStart','09:00')>=coalesce(p->>'contactEnd','18:00') then
    raise exception 'Contact end must follow contact start'; end if;
  return new;
end; $$;
create trigger workspace_messaging_settings_guard before insert or update on public.workspace_settings
  for each row execute function app.guard_messaging_settings();

-- Business identity changes require new approval, just like cadence changes.
create or replace function app.invalidate_core_followup_approvals()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if new.follow_up_preferences is distinct from old.follow_up_preferences
    or new.default_timezone is distinct from old.default_timezone
    or new.business_name is distinct from old.business_name then
    update public.invoices set metadata=metadata||jsonb_build_object('followup_state','paused',
      'next_follow_up_at',null,'approved_reminder_text',null,'approved_preferences_updated_at',null)
      where workspace_id=new.workspace_id and followup_state in ('approved','active','scheduled');
  end if;
  return new;
end; $$;
drop trigger workspace_settings_invalidate_core_followups on public.workspace_settings;
create trigger workspace_settings_invalidate_core_followups after update of follow_up_preferences,default_timezone,business_name
  on public.workspace_settings for each row execute function app.invalidate_core_followup_approvals();
revoke all on function app.invalidate_core_followup_approvals() from public,anon,authenticated;

create or replace function app.require_branded_reminder_approval()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare business text; body text;
begin
  if new.metadata->>'followup_state'='approved' and (
    tg_op='INSERT' or new.metadata->>'followup_state' is distinct from old.metadata->>'followup_state'
    or new.metadata->>'approved_reminder_text' is distinct from old.metadata->>'approved_reminder_text') then
    select business_name into business from public.workspace_settings where workspace_id=new.workspace_id;
    body:=new.metadata->>'approved_reminder_text';
    if business is null or btrim(business)='' or body is null or right(btrim(body),length(business)+2)<>'— '||business then
      raise exception 'Approve a reminder containing the configured business name'; end if;
  end if;
  return new;
end; $$;
create trigger invoices_require_business_reminder before insert or update on public.invoices
  for each row execute function app.require_branded_reminder_approval();

create table public.whatsapp_messages(
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  invoice_id uuid references public.invoices(id) on delete set null,
  phone text not null check(phone ~ '^\+[1-9][0-9]{7,14}$'),
  direction text not null check(direction in ('inbound','outbound')),
  audience text not null default 'customer' check(audience in ('owner','customer')),
  body text not null check(length(body)<=4000),
  kind text not null,
  status text not null check(status in ('received','pending','accepted','sent','delivered','read','failed','blocked','unknown')),
  provider_message_id text,
  callback_token text unique check(callback_token ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(workspace_id,idempotency_key)
);
create index whatsapp_messages_workspace_created on public.whatsapp_messages(workspace_id,created_at desc,id desc);
create index whatsapp_messages_provider on public.whatsapp_messages(provider_message_id,phone);
alter table public.whatsapp_messages enable row level security;
alter table public.whatsapp_messages force row level security;
revoke all on public.whatsapp_messages from public,anon,authenticated;
grant select on public.whatsapp_messages to authenticated;
grant select,insert,update on public.whatsapp_messages to service_role;
create policy whatsapp_messages_member_read on public.whatsapp_messages for select to authenticated
  using(app.is_workspace_member(workspace_id));

create or replace function public.whatsapp_record_delivery_status(p_message_id text,p_phone text,p_status text,p_callback_token text default null)
returns void language sql security definer set search_path=public,pg_temp as $$
  update public.whatsapp_messages set status=p_status,provider_message_id=coalesce(provider_message_id,p_message_id),updated_at=now()
    where direction='outbound' and phone=p_phone and (
      provider_message_id=p_message_id or (callback_token=p_callback_token and provider_message_id is null))
      and p_status in ('sent','delivered','read','failed')
      and case p_status when 'sent' then status in ('pending','accepted','unknown')
        when 'delivered' then status in ('pending','accepted','unknown','sent','failed')
        when 'read' then true
        when 'failed' then status in ('pending','accepted','unknown','sent') else false end;
$$;
revoke all on function public.whatsapp_record_delivery_status(text,text,text,text) from public,anon,authenticated;
grant execute on function public.whatsapp_record_delivery_status(text,text,text,text) to service_role;

create or replace function public.whatsapp_pause_customer_followups(p_workspace_id uuid,p_customer_id uuid,p_message_id text default null)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare changed_invoice uuid;
begin
  if not exists(select 1 from public.customers where id=p_customer_id and workspace_id=p_workspace_id)then return;end if;
  if p_message_id is not null then
    insert into public.cetld_core_automation_events(workspace_id,type,idempotency_key,metadata)
      values(p_workspace_id,'customer_reply','whatsapp_reply:'||p_message_id,jsonb_build_object('customer_id',p_customer_id))
      on conflict(workspace_id,idempotency_key)do nothing;
  end if;
  for changed_invoice in
  update public.invoices i set metadata=i.metadata||jsonb_build_object('followup_state','paused','next_follow_up_at',null,
    'approved_reminder_text',null,'approved_preferences_updated_at',null)
    from public.workspace_settings s where s.workspace_id=p_workspace_id and i.workspace_id=s.workspace_id
      and i.customer_id=p_customer_id and coalesce((s.follow_up_preferences->>'pauseOnReply')::boolean,true)
      and i.amount_paid<i.total_amount and i.status not in ('paid','void','cancelled')
      and i.followup_state in ('approved','active','scheduled') returning i.id loop
    if p_message_id is not null then
      insert into public.cetld_core_automation_events(workspace_id,invoice_id,type,idempotency_key)
        values(p_workspace_id,changed_invoice,'followup_paused','whatsapp_pause:'||p_message_id||':'||changed_invoice)
        on conflict(workspace_id,idempotency_key)do nothing;
    end if;
  end loop;
end; $$;
revoke all on function public.whatsapp_pause_customer_followups(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.whatsapp_pause_customer_followups(uuid,uuid,text) to service_role;

create or replace function public.whatsapp_claim_owner_reply(p_provider_message_id text,p_sender_phone text,p_workspace_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not exists(select 1 from public.workspace_settings s join public.workspaces w on w.id=s.workspace_id
    join public.workspace_members m on m.workspace_id=w.id and m.user_id=w.owner_id and m.role='owner'
    where s.workspace_id=p_workspace_id and s.whatsapp_owner_phone=p_sender_phone
      and nullif(btrim(s.business_name),'') is not null) then return false; end if;
  if exists(select 1 from public.whatsapp_global_suppressions where phone=p_sender_phone)
    or exists(select 1 from public.whatsapp_suppressions where phone=p_sender_phone and workspace_id=p_workspace_id)
    then return false; end if;
  return public.whatsapp_claim_inbound_reply(p_provider_message_id,p_sender_phone,'normal',p_workspace_id);
end; $$;
revoke all on function public.whatsapp_claim_owner_reply(text,text,uuid) from public,anon,authenticated;
grant execute on function public.whatsapp_claim_owner_reply(text,text,uuid) to service_role;

-- Dashboard summaries read only the member's own workspace events.
grant select on public.cetld_core_automation_events to authenticated;
create policy core_automation_events_member_read on public.cetld_core_automation_events for select to authenticated
  using(app.is_workspace_member(workspace_id));

-- Serialize abandonment with the existing inbound claim, so a duplicate worker
-- cannot label another worker's in-flight transport as blocked.
create or replace function public.whatsapp_block_unclaimed_reply(p_workspace_id uuid,p_message_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare claimed timestamptz;
begin
  select reply_claimed_at into claimed from public.whatsapp_inbound_events
    where provider_message_id=p_message_id for update;
  if not found or claimed is null then
    update public.whatsapp_messages set status='blocked',updated_at=now()
      where workspace_id=p_workspace_id and idempotency_key='reply:'||p_message_id and status='pending';
  end if;
end; $$;
revoke all on function public.whatsapp_block_unclaimed_reply(uuid,text) from public,anon,authenticated;
grant execute on function public.whatsapp_block_unclaimed_reply(uuid,text) to service_role;

-- A template claim and stale-intent status are decided under the same phone
-- lock as STOP. Existing concurrent claims keep their transport status.
create or replace function public.whatsapp_claim_logged_invoice_update(
  p_workspace_id uuid,p_invoice_id uuid,p_customer_id uuid,p_phone text,
  p_idempotency_key text,p_expected_updated_at timestamptz
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare intent_status text; claimed boolean;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_phone,0));
  select status into intent_status from public.whatsapp_messages
    where workspace_id=p_workspace_id and invoice_id=p_invoice_id and customer_id=p_customer_id
      and phone=p_phone and direction='outbound' and audience='customer' and kind='invoice_update'
      and idempotency_key='template:'||p_idempotency_key for update;
  if not found or intent_status not in ('pending','unknown')then return false;end if;
  claimed:=public.whatsapp_claim_invoice_update(p_workspace_id,p_invoice_id,p_customer_id,p_phone,p_idempotency_key,p_expected_updated_at);
  if not claimed and not exists(select 1 from public.whatsapp_invoice_update_claims
    where workspace_id=p_workspace_id and invoice_id=p_invoice_id and idempotency_key=p_idempotency_key)then
    update public.whatsapp_messages set status='blocked',updated_at=now()
      where workspace_id=p_workspace_id and idempotency_key='template:'||p_idempotency_key and status='pending';
  end if;
  return claimed;
end; $$;
revoke all on function public.whatsapp_claim_logged_invoice_update(uuid,uuid,uuid,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.whatsapp_claim_logged_invoice_update(uuid,uuid,uuid,text,text,timestamptz) to service_role;
