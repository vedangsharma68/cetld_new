-- Verified Meta messages are durably recorded before acknowledging the webhook.
-- The worker claims rows transactionally so concurrent cron invocations cannot
-- process the same message at once. Payload contains only the message fields
-- needed for routing, not the complete provider webhook.
create table public.whatsapp_inbound_events (
  id bigint generated always as identity primary key,
  provider_message_id text not null unique check (length(provider_message_id) between 1 and 256),
  phone_number_id text not null check (length(phone_number_id) between 1 and 128),
  sender_phone text not null check (sender_phone ~ '^\+[1-9][0-9]{6,14}$'),
  message_type text not null check (length(message_type) between 1 and 64),
  message_text text not null default '' check (length(message_text) <= 4000),
  received_at timestamptz not null default now(),
  provider_timestamp timestamptz,
  status text not null default 'pending' check (status in ('pending','processing','done','failed')),
  attempts integer not null default 0 check (attempts between 0 and 10),
  next_attempt_at timestamptz not null default now(),
  claimed_at timestamptz,
  claim_token uuid,
  processed_at timestamptz,
  stop_processed_at timestamptz,
  stop_confirmation_due boolean not null default false,
  stop_workspace_id uuid references public.workspaces(id) on delete set null,
  reply_claimed_at timestamptz,
  error_code text check (error_code is null or length(error_code) <= 80)
);

create index whatsapp_inbound_pending_idx on public.whatsapp_inbound_events
  (next_attempt_at, id) where status in ('pending','processing');

alter table public.whatsapp_inbound_events enable row level security;
alter table public.whatsapp_inbound_events force row level security;
revoke all on public.whatsapp_inbound_events from anon, authenticated;
grant select, insert, update on public.whatsapp_inbound_events to service_role;
grant usage, select on sequence public.whatsapp_inbound_events_id_seq to service_role;

create or replace function public.whatsapp_claim_inbound_events(p_limit integer)
returns setof public.whatsapp_inbound_events
language sql security definer set search_path = public, pg_temp
as $$
  update public.whatsapp_inbound_events e
  set status = 'processing',
      attempts = e.attempts + 1,
      claimed_at = now(),
      claim_token = gen_random_uuid()
  from (
    select id from public.whatsapp_inbound_events
    where ((status = 'pending' and next_attempt_at <= now())
      or (status = 'processing' and claimed_at < now() - interval '5 minutes'))
      and attempts < 5
    order by id
    for update skip locked
    limit least(greatest(p_limit, 1), 25)
  ) pending
  where e.id = pending.id
  returning e.*;
$$;
revoke all on function public.whatsapp_claim_inbound_events(integer) from public, anon, authenticated;
grant execute on function public.whatsapp_claim_inbound_events(integer) to service_role;

create or replace function public.whatsapp_record_inbound_stop(
  p_provider_message_id text,
  p_confirmation_due boolean,
  p_workspace_id uuid default null
) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update public.whatsapp_inbound_events e
  set stop_processed_at = coalesce(e.stop_processed_at, now()),
      stop_confirmation_due = e.stop_confirmation_due or p_confirmation_due,
      stop_workspace_id = case when p_confirmation_due and e.stop_workspace_id is null
        then p_workspace_id else e.stop_workspace_id end
  where e.provider_message_id = p_provider_message_id;
end;
$$;
revoke all on function public.whatsapp_record_inbound_stop(text,boolean,uuid) from public, anon, authenticated;
grant execute on function public.whatsapp_record_inbound_stop(text,boolean,uuid) to service_role;

create or replace function public.whatsapp_claim_inbound_reply(
  p_provider_message_id text,
  p_sender_phone text,
  p_kind text,
  p_workspace_id uuid default null
) returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare claimed_id bigint;
begin
  if p_kind not in ('normal', 'verification', 'stop_confirmation') then return false; end if;
  update public.whatsapp_inbound_events e
  set reply_claimed_at = now()
  where e.provider_message_id = p_provider_message_id
    and e.sender_phone = p_sender_phone
    and e.status = 'processing'
    and e.reply_claimed_at is null
    and (p_kind <> 'stop_confirmation' or
      (e.stop_processed_at is not null and e.stop_confirmation_due and (
        (p_workspace_id is not null and e.stop_workspace_id = p_workspace_id) or
        (p_workspace_id is null and e.stop_workspace_id is null and exists (
          select 1 from public.whatsapp_global_suppressions g
          where g.phone = p_sender_phone and g.source_message_id = p_provider_message_id
        ))
      )))
    and (p_kind <> 'verification' or
      (e.stop_processed_at is null and not exists (
        select 1 from public.whatsapp_suppressions s where s.phone = p_sender_phone
      ) and not exists (
        select 1 from public.whatsapp_global_suppressions g where g.phone = p_sender_phone
      )))
    and (p_kind <> 'normal' or (p_workspace_id is not null and e.stop_processed_at is null))
  returning e.id into claimed_id;
  return claimed_id is not null;
end;
$$;
revoke all on function public.whatsapp_claim_inbound_reply(text,text,text,uuid) from public, anon, authenticated;
grant execute on function public.whatsapp_claim_inbound_reply(text,text,text,uuid) to service_role;
