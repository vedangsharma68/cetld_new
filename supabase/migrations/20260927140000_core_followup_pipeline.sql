-- Additive bridge from the active core invoice schema to server-side follow-ups.
-- Existing rows and metadata are retained. An old invoice without an explicit
-- receivable direction is never eligible for outbound delivery.
alter table public.invoices
  add column if not exists followup_state text not null default 'draft',
  add column if not exists next_follow_up_at timestamptz,
  add column if not exists last_follow_up_at timestamptz,
  add column if not exists reminder_count integer not null default 0,
  add column if not exists customer_phone text,
  add column if not exists follow_up_settings jsonb not null default '{}'::jsonb,
  add column if not exists automation_version bigint not null default 0;

create or replace function app.core_safe_followup_time(value text)
returns timestamptz language plpgsql immutable security invoker set search_path = '' as $$
begin
  if value is null or length(value)>64 then return null; end if;
  return value::timestamptz;
exception when others then return null;
end;
$$;
create or replace function app.core_safe_reminder_count(value text)
returns integer language plpgsql immutable security invoker set search_path = '' as $$
declare parsed numeric;
begin
  if value is null or length(value)>3 or value !~ '^[0-9]+$' then return 0; end if;
  parsed:=value::numeric;
  return least(parsed,20)::integer;
exception when others then return 0;
end;
$$;

update public.invoices
set followup_state = case
    when status::text in ('paid','void','cancelled') or amount_paid >= total_amount then 'cancelled'
    when metadata->>'followup_state' in ('draft','approved','active','scheduled','paused','cancelled') then metadata->>'followup_state'
    else 'draft' end,
    next_follow_up_at = case
      when status::text in ('paid','void','cancelled') or amount_paid >= total_amount then null
      else app.core_safe_followup_time(metadata->>'next_follow_up_at') end,
    reminder_count = app.core_safe_reminder_count(metadata->>'reminder_count');

create or replace function app.core_next_contact(p_after timestamptz,p_preferences jsonb,p_timezone text)
returns timestamptz language plpgsql stable security invoker set search_path = '' as $$
declare local_at timestamp; contact_start time; contact_end time; allowed jsonb; day_number integer; candidate timestamptz;
begin
  contact_start := coalesce(p_preferences->>'contactStart','09:00')::time;
  contact_end := coalesce(p_preferences->>'contactEnd','18:00')::time;
  allowed := coalesce(p_preferences->'allowedWeekdays','[1,2,3,4,5]'::jsonb);
  if contact_start >= contact_end or jsonb_typeof(allowed) <> 'array' then raise exception 'Invalid contact preferences'; end if;
  local_at := p_after at time zone p_timezone;
  for counter in 0..370 loop
    day_number := extract(dow from local_at)::integer;
    if exists(select 1 from jsonb_array_elements_text(allowed) day where day.value::integer=day_number) then
      if local_at::time < contact_start then local_at := local_at::date+contact_start; end if;
      if local_at::time < contact_end then
        candidate := local_at at time zone p_timezone;
        if candidate >= p_after then return candidate; end if;
      end if;
    end if;
    local_at := date_trunc('day',local_at)+interval '1 day';
  end loop;
  raise exception 'No allowed contact day';
end;
$$;

create or replace function app.sync_core_followup_invoice()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare meta_state text; settings public.workspace_settings%rowtype; base_at timestamptz; first_days integer;
begin
  if tg_op = 'UPDATE' then
    if new.metadata is distinct from old.metadata and
       new.metadata->>'followup_state' is distinct from old.metadata->>'followup_state' then
      meta_state := new.metadata->>'followup_state';
      if meta_state in ('draft','approved','active','scheduled','paused','cancelled') then
        new.followup_state := meta_state;
      end if;
      if new.metadata->>'next_follow_up_at' is distinct from old.metadata->>'next_follow_up_at' then
        new.next_follow_up_at := app.core_safe_followup_time(new.metadata->>'next_follow_up_at');
      end if;
    elsif new.followup_state is distinct from old.followup_state or new.next_follow_up_at is distinct from old.next_follow_up_at then
      new.metadata := jsonb_set(jsonb_set(coalesce(new.metadata,'{}'::jsonb),'{followup_state}',to_jsonb(new.followup_state),true),'{next_follow_up_at}',coalesce(to_jsonb(new.next_follow_up_at),'null'::jsonb),true);
    end if;
    if new.total_amount is distinct from old.total_amount or new.amount_paid is distinct from old.amount_paid
       or new.status is distinct from old.status or new.due_date is distinct from old.due_date
       or new.metadata->>'invoice_direction' is distinct from old.metadata->>'invoice_direction'
       or new.metadata->>'approved_reminder_text' is distinct from old.metadata->>'approved_reminder_text'
       or new.followup_state is distinct from old.followup_state or new.next_follow_up_at is distinct from old.next_follow_up_at
       or new.customer_phone is distinct from old.customer_phone or new.reminder_count is distinct from old.reminder_count
       or new.customer_id is distinct from old.customer_id then
      new.automation_version := old.automation_version + 1;
    end if;
  else
    if new.metadata->>'followup_state' in ('draft','approved','active','scheduled','paused','cancelled') then
      new.followup_state := new.metadata->>'followup_state';
    end if;
  end if;
  if new.status::text in ('paid','void','cancelled') or new.total_amount <= 0 or new.amount_paid >= new.total_amount then
    new.followup_state := 'cancelled';
    new.next_follow_up_at := null;
  end if;
  if new.followup_state in ('approved','active','scheduled') and new.next_follow_up_at is null
     and new.due_date is not null and new.metadata->>'invoice_direction'='receivable'
     and new.amount_paid<new.total_amount and new.total_amount>0 then
    select * into settings from public.workspace_settings where workspace_id=new.workspace_id;
    if settings.workspace_id is not null then
      first_days := coalesce((settings.follow_up_preferences->>'firstReminderDays')::integer,3);
      base_at := ((new.due_date + first_days) + coalesce(settings.follow_up_preferences->>'contactStart','09:00')::time) at time zone settings.default_timezone;
      new.next_follow_up_at := app.core_next_contact(greatest(base_at,now()),settings.follow_up_preferences,settings.default_timezone);
    end if;
  end if;
  new.metadata := jsonb_set(jsonb_set(coalesce(new.metadata,'{}'::jsonb),'{followup_state}',to_jsonb(new.followup_state),true),'{next_follow_up_at}',coalesce(to_jsonb(new.next_follow_up_at),'null'::jsonb),true);
  return new;
end;
$$;

drop trigger if exists invoices_core_followup_sync on public.invoices;
create trigger invoices_core_followup_sync before insert or update on public.invoices
for each row execute function app.sync_core_followup_invoice();

create or replace function app.invalidate_core_followup_approvals()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.follow_up_preferences is distinct from old.follow_up_preferences
     or new.default_timezone is distinct from old.default_timezone then
    update public.invoices set followup_state='draft',next_follow_up_at=null,
      metadata=metadata - 'approved_reminder_text' - 'approved_preferences_updated_at'
    where workspace_id=new.workspace_id and followup_state in ('approved','active','scheduled');
  end if;
  return new;
end;
$$;
drop trigger if exists workspace_settings_invalidate_core_followups on public.workspace_settings;
create trigger workspace_settings_invalidate_core_followups after update of follow_up_preferences,default_timezone on public.workspace_settings
for each row execute function app.invalidate_core_followup_approvals();

create index if not exists invoices_core_followup_due_idx on public.invoices(workspace_id,next_follow_up_at)
where followup_state in ('approved','active','scheduled') and next_follow_up_at is not null;

create table if not exists public.cetld_core_automation_delivery_claims (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  scheduled_for timestamptz not null,
  invoice_version bigint not null,
  preferences_updated_at timestamptz not null,
  status text not null check (status in ('claimed','sending','sent','failed','cancelled','quarantined')),
  attempts integer not null default 1,
  lease_until timestamptz not null,
  delivery_token uuid,
  provider_message_id text,
  last_error text,
  created_at timestamptz not null default now(),
  constraint core_followup_claim_unique unique(workspace_id,invoice_id,scheduled_for)
);
create table if not exists public.cetld_core_automation_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  invoice_id uuid references public.invoices(id) on delete set null,
  direction text not null,
  kind text not null,
  status text not null,
  idempotency_key text not null,
  provider_message_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(workspace_id,idempotency_key)
);
create table if not exists public.cetld_core_automation_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  invoice_id uuid references public.invoices(id) on delete set null,
  type text not null,
  idempotency_key text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique(workspace_id,idempotency_key)
);
alter table public.cetld_core_automation_delivery_claims enable row level security;
alter table public.cetld_core_automation_messages enable row level security;
alter table public.cetld_core_automation_events enable row level security;
revoke all on public.cetld_core_automation_delivery_claims,public.cetld_core_automation_messages,public.cetld_core_automation_events from public,anon,authenticated;
grant all on public.cetld_core_automation_delivery_claims,public.cetld_core_automation_messages,public.cetld_core_automation_events to service_role;

create or replace function public.cetld_core_claim_due_followups(p_owner_id uuid,p_workspace_id uuid,p_now timestamptz default now(),p_limit integer default 25,p_invoice_id uuid default null)
returns table(claim_id uuid,invoice_id uuid,invoice_version bigint)
language plpgsql security invoker set search_path = '' as $$
declare r record; c public.cetld_core_automation_delivery_claims%rowtype;
begin
  if not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=p_owner_id) then return; end if;
  for r in select i.id,i.next_follow_up_at,i.automation_version,s.updated_at
    from public.invoices i join public.workspace_settings s on s.workspace_id=i.workspace_id
    where i.workspace_id=p_workspace_id and (p_invoice_id is null or i.id=p_invoice_id)
      and i.followup_state in ('approved','active','scheduled') and i.next_follow_up_at<=p_now
      and i.status::text not in ('paid','void','cancelled') and i.amount_paid<i.total_amount and i.total_amount>0
      and i.due_date is not null and i.metadata->>'invoice_direction'='receivable'
      and nullif(btrim(i.metadata->>'approved_reminder_text'),'') is not null
      and app.core_safe_followup_time(i.metadata->>'approved_preferences_updated_at')=s.updated_at
    order by i.next_follow_up_at,i.id limit greatest(1,least(p_limit,100)) for update of i skip locked
  loop
    insert into public.cetld_core_automation_delivery_claims(workspace_id,invoice_id,scheduled_for,invoice_version,preferences_updated_at,status,lease_until)
    values(p_workspace_id,r.id,r.next_follow_up_at,r.automation_version,r.updated_at,'claimed',p_now+interval '2 minutes')
    on conflict on constraint core_followup_claim_unique do update set
      invoice_version=excluded.invoice_version,preferences_updated_at=excluded.preferences_updated_at,
      status='claimed',attempts=public.cetld_core_automation_delivery_claims.attempts+1,lease_until=excluded.lease_until,delivery_token=null
      where public.cetld_core_automation_delivery_claims.attempts<3
        and (public.cetld_core_automation_delivery_claims.status in ('failed','cancelled')
          or (public.cetld_core_automation_delivery_claims.status='claimed' and public.cetld_core_automation_delivery_claims.lease_until<p_now))
    returning * into c;
    if found then claim_id:=c.id;invoice_id:=c.invoice_id;invoice_version:=c.invoice_version;return next; end if;
  end loop;
end;
$$;

create or replace function public.cetld_core_authorize_delivery(p_claim_id uuid,p_owner_id uuid,p_workspace_id uuid,p_preferences_version timestamptz default null)
returns table(authorized boolean,reason text,token uuid)
language plpgsql security invoker set search_path = '' as $$
declare c public.cetld_core_automation_delivery_claims%rowtype; i public.invoices%rowtype; s public.workspace_settings%rowtype;
declare p jsonb; local_now timestamp; weekday integer; minute_now integer; start_minute integer; end_minute integer; max_count integer;
begin
  authorized:=false;reason:='not_found';token:=null;
  if not exists(select 1 from public.workspaces where id=p_workspace_id and owner_id=p_owner_id) then return next;return; end if;
  select * into c from public.cetld_core_automation_delivery_claims where id=p_claim_id and workspace_id=p_workspace_id for update;
  if c.id is null then return next;return; end if;
  select * into i from public.invoices where id=c.invoice_id and workspace_id=p_workspace_id for update;
  select * into s from public.workspace_settings where workspace_id=p_workspace_id;
  if i.id is null or s.workspace_id is null then return next;return; end if;
  if c.status<>'claimed' then reason:='not_claimed';return next;return; end if;
  if c.invoice_version<>i.automation_version or c.preferences_updated_at<>s.updated_at or (p_preferences_version is not null and p_preferences_version<>s.updated_at) then reason:='stale_claim';return next;return; end if;
  if c.lease_until<=now() then reason:='expired';return next;return; end if;
  if i.followup_state not in ('approved','active','scheduled') or i.status::text in ('paid','void','cancelled')
    or i.total_amount<=0 or i.amount_paid>=i.total_amount or i.due_date is null
    or i.metadata->>'invoice_direction' is distinct from 'receivable'
    or nullif(btrim(i.metadata->>'approved_reminder_text'),'') is null
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
  update public.cetld_core_automation_delivery_claims set status='sending',delivery_token=token where id=c.id;
  return next;
end;
$$;

create or replace function public.cetld_core_mark_sent(p_claim_id uuid,p_owner_id uuid,p_workspace_id uuid,p_token uuid,p_provider_message_id text)
returns table(ok boolean) language plpgsql security invoker set search_path = '' as $$
begin
  update public.cetld_core_automation_delivery_claims c set status='sent',provider_message_id=left(p_provider_message_id,250)
  where c.id=p_claim_id and c.workspace_id=p_workspace_id and c.status='sending' and c.delivery_token=p_token
    and exists(select 1 from public.workspaces w where w.id=p_workspace_id and w.owner_id=p_owner_id);
  ok:=found;
  if ok then update public.cetld_core_automation_messages set status='sent',provider_message_id=p_provider_message_id
    where workspace_id=p_workspace_id and payload->>'claimId'=p_claim_id::text; end if;
  return next;
end;
$$;
create or replace function public.cetld_core_mark_failed(p_claim_id uuid,p_owner_id uuid,p_workspace_id uuid,p_token uuid,p_error text,p_unknown boolean)
returns table(ok boolean) language plpgsql security invoker set search_path = '' as $$
begin
  update public.cetld_core_automation_delivery_claims c set status=case when p_unknown then 'quarantined' else 'failed' end,last_error=left(p_error,250)
  where c.id=p_claim_id and c.workspace_id=p_workspace_id and c.status in ('claimed','sending')
    and (c.status='claimed' or c.delivery_token=p_token)
    and exists(select 1 from public.workspaces w where w.id=p_workspace_id and w.owner_id=p_owner_id);
  ok:=found;return next;
end;
$$;
revoke execute on function public.cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid) from public,anon,authenticated;
revoke execute on function public.cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz) from public,anon,authenticated;
revoke execute on function public.cetld_core_mark_sent(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
revoke execute on function public.cetld_core_mark_failed(uuid,uuid,uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.cetld_core_claim_due_followups(uuid,uuid,timestamptz,integer,uuid) to service_role;
grant execute on function public.cetld_core_authorize_delivery(uuid,uuid,uuid,timestamptz) to service_role;
grant execute on function public.cetld_core_mark_sent(uuid,uuid,uuid,uuid,text) to service_role;
grant execute on function public.cetld_core_mark_failed(uuid,uuid,uuid,uuid,text,boolean) to service_role;
