begin;
set local lock_timeout='1s';set local statement_timeout='5s';
alter table public.whatsapp_messages add column if not exists dispatch_started_at timestamptz;
alter table public.whatsapp_inbound_events add column if not exists reply_dispatch_started_at timestamptz;
alter table public.whatsapp_inbound_events add column if not exists reply_dispatch_nonce uuid;
alter table public.whatsapp_inbound_events add column if not exists ack_dispatch_started_at timestamptz;
alter table public.whatsapp_inbound_events add column if not exists ack_dispatch_nonce uuid;
alter table public.whatsapp_inbound_events add column if not exists reply_has_pending_intent boolean not null default false;

alter table public.whatsapp_inbound_events add column if not exists reply_reservation_nonce uuid;
alter table public.whatsapp_inbound_events add column if not exists ack_reservation_nonce uuid;

-- Register a new protocol reservation BEFORE claiming it. A historical claim
-- with no handoff marker is ambiguous and must not be automatically resent.
create or replace function public.whatsapp_prepare_reply_reservation(p_workspace_id uuid,p_message_id text,p_phone text,p_kind text,p_phase text) returns uuid
language plpgsql security definer set search_path='' as $$
declare e public.whatsapp_inbound_events;nonce uuid;
begin
 if p_phase not in ('answer','ack') then return null;end if;
 select * into e from public.whatsapp_inbound_events where provider_message_id=p_message_id and sender_phone=p_phone and status='processing' for update;
 if e.id is null or coalesce(e.provider_timestamp,e.received_at)<=clock_timestamp()-interval '24 hours' then return null;end if;
 if p_phase='ack' then
  if e.ack_reservation_nonce is null and e.owner_ack_claimed_at is not null then return null;end if;
  nonce:=coalesce(e.ack_reservation_nonce,gen_random_uuid());update public.whatsapp_inbound_events set ack_reservation_nonce=nonce where id=e.id;
 else
  if e.reply_reservation_nonce is null and e.reply_claimed_at is not null then return null;end if;
  nonce:=coalesce(e.reply_reservation_nonce,gen_random_uuid());update public.whatsapp_inbound_events set reply_reservation_nonce=nonce where id=e.id;
 end if;return nonce;
end $$;
create or replace function app.fence_registered_reply_claim() returns trigger language plpgsql set search_path='' as $$begin
 if new.reply_claimed_at is not null and new.reply_claimed_at is distinct from old.reply_claimed_at and old.reply_reservation_nonce is not null
 and current_setting('app.whatsapp_claim_nonce',true) is distinct from old.reply_reservation_nonce::text then return null;end if;
 if new.owner_ack_claimed_at is not null and new.owner_ack_claimed_at is distinct from old.owner_ack_claimed_at and old.ack_reservation_nonce is not null
 and current_setting('app.whatsapp_claim_nonce',true) is distinct from old.ack_reservation_nonce::text then return null;end if;
 return new;
end $$;
create or replace trigger fence_registered_reply_claim before update of reply_claimed_at,owner_ack_claimed_at on public.whatsapp_inbound_events for each row execute function app.fence_registered_reply_claim();
revoke all on function app.fence_registered_reply_claim() from public,anon,authenticated,service_role;

create or replace function public.whatsapp_claim_reserved_reply(p_workspace_id uuid,p_message_id text,p_phone text,p_kind text,p_phase text,p_audience text,p_phone_number_id text,p_commercial boolean,p_nonce uuid) returns boolean
language plpgsql security definer set search_path='' as $$begin
 if p_nonce is null or not exists(select 1 from public.whatsapp_inbound_events e where e.provider_message_id=p_message_id and e.sender_phone=p_phone
 and case when p_phase='ack' then e.ack_reservation_nonce=p_nonce else e.reply_reservation_nonce=p_nonce end) then return false;end if;
 perform set_config('app.whatsapp_claim_nonce',p_nonce::text,true);
 if p_audience='owner' and p_kind='normal' then
  if p_commercial then return public.whatsapp_claim_service_owner_reply(p_message_id,p_phone,p_workspace_id,p_phone_number_id,p_phase);end if;
  if p_phase='ack' then return public.whatsapp_claim_owner_ack(p_message_id,p_phone,p_workspace_id);end if;
  return public.whatsapp_claim_owner_reply(p_message_id,p_phone,p_workspace_id);
 elsif p_audience='customer' and p_phase='answer' then
  if p_kind='start_confirmation' then return public.whatsapp_claim_resubscribe_reply(p_message_id,p_phone,p_kind,p_workspace_id);end if;
  return public.whatsapp_claim_inbound_reply(p_message_id,p_phone,p_kind,p_workspace_id);
 end if;return false;
end $$;
revoke all on function public.whatsapp_prepare_reply_reservation(uuid,text,text,text,text),public.whatsapp_claim_reserved_reply(uuid,text,text,text,text,text,text,boolean,uuid) from public,anon,authenticated;
grant execute on function public.whatsapp_prepare_reply_reservation(uuid,text,text,text,text),public.whatsapp_claim_reserved_reply(uuid,text,text,text,text,text,text,boolean,uuid) to service_role;

-- Reservation recovery never grants sending authority. It only re-arms a
-- demonstrably unsent intent; the original claim/authorization must run again.
create or replace function public.whatsapp_rearm_unsent_reply(p_workspace_id uuid,p_message_id text,p_phone text,p_kind text,p_phase text default 'answer') returns boolean
language plpgsql security definer set search_path='' as $$
declare e public.whatsapp_inbound_events;
begin
 if p_phase not in ('answer','ack') then return false;end if;
 select * into e from public.whatsapp_inbound_events where provider_message_id=p_message_id and sender_phone=p_phone and status='processing' for update;
 if e.id is null or coalesce(e.provider_timestamp,e.received_at)<=clock_timestamp()-interval '24 hours' then return false;end if;
 if p_workspace_id is not null and not exists(select 1 from public.whatsapp_messages m where m.workspace_id=p_workspace_id and m.phone=p_phone and m.kind=p_kind
  and m.idempotency_key=(case when p_phase='ack' then 'ack:' else 'reply:' end)||p_message_id and m.direction='outbound' and m.status='pending' and m.dispatch_started_at is null) then return false;end if;
 if p_workspace_id is null and (p_phase<>'answer' or p_kind not in ('verification','start_confirmation','stop_confirmation')) then return false;end if;
 if p_phase='ack' then
  if e.ack_reservation_nonce is null then return false;end if;
  if e.ack_dispatch_started_at is not null or e.owner_ack_claimed_at is null then return false;end if;
  update public.whatsapp_inbound_events set owner_ack_claimed_at=null where id=e.id;
 else
  if e.reply_reservation_nonce is null then return false;end if;
  if e.reply_dispatch_started_at is not null or e.reply_claimed_at is null then return false;end if;
  update public.whatsapp_inbound_events set reply_claimed_at=null where id=e.id;
 end if;return true;
end $$;

-- Exactly one HTTP handoff may start. Retrying a lost RPC response with the
-- SAME invocation nonce is safe before HTTP; another worker has a different
-- nonce and cannot resend an accepted or uncertain handoff.
create or replace function public.whatsapp_begin_reply_dispatch(p_workspace_id uuid,p_message_id text,p_phone text,p_kind text,p_phase text,p_nonce uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare e public.whatsapp_inbound_events;started timestamptz;nonce uuid;
begin
 if p_phase not in ('answer','ack') or p_nonce is null then return false;end if;
 select * into e from public.whatsapp_inbound_events where provider_message_id=p_message_id and sender_phone=p_phone and status='processing' for update;
 if e.id is null or coalesce(e.provider_timestamp,e.received_at)>clock_timestamp() or coalesce(e.provider_timestamp,e.received_at)<=clock_timestamp()-interval '24 hours' then return false;end if;
 if p_phase='ack' then if e.ack_reservation_nonce is null then return false;end if;started:=e.ack_dispatch_started_at;nonce:=e.ack_dispatch_nonce;if e.owner_ack_claimed_at is null then return false;end if;
 else if e.reply_reservation_nonce is null then return false;end if;started:=e.reply_dispatch_started_at;nonce:=e.reply_dispatch_nonce;if e.reply_claimed_at is null then return false;end if;end if;
 if started is not null then return nonce=p_nonce;end if;
 if p_workspace_id is not null then
  perform 1 from public.whatsapp_messages m where m.workspace_id=p_workspace_id and m.phone=p_phone and m.kind=p_kind
   and m.idempotency_key=(case when p_phase='ack' then 'ack:' else 'reply:' end)||p_message_id and m.direction='outbound' and m.status='pending' and m.dispatch_started_at is null for update;
  if not found then return false;end if;
 elsif p_phase<>'answer' or p_kind not in ('verification','start_confirmation','stop_confirmation') then return false;end if;
 if p_phase='ack' then update public.whatsapp_inbound_events set ack_dispatch_started_at=clock_timestamp(),ack_dispatch_nonce=p_nonce where id=e.id;
 else update public.whatsapp_inbound_events set reply_dispatch_started_at=clock_timestamp(),reply_dispatch_nonce=p_nonce where id=e.id;end if;
 update public.whatsapp_messages set dispatch_started_at=clock_timestamp() where workspace_id=p_workspace_id and idempotency_key=(case when p_phase='ack' then 'ack:' else 'reply:' end)||p_message_id;
 return true;
end $$;
revoke all on function public.whatsapp_rearm_unsent_reply(uuid,text,text,text,text),public.whatsapp_begin_reply_dispatch(uuid,text,text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.whatsapp_rearm_unsent_reply(uuid,text,text,text,text),public.whatsapp_begin_reply_dispatch(uuid,text,text,text,text,uuid) to service_role;

create or replace function app.track_pending_reply_intent() returns trigger language plpgsql security definer set search_path='' as $$
declare message_id text;
begin
 if new.direction<>'outbound' or new.idempotency_key !~ '^(reply|ack):' then return new;end if;
 message_id:=substring(new.idempotency_key from strpos(new.idempotency_key,':')+1);
 update public.whatsapp_inbound_events e set reply_has_pending_intent=exists(select 1 from public.whatsapp_messages m
  where m.phone=e.sender_phone and m.workspace_id=new.workspace_id and m.idempotency_key in ('reply:'||message_id,'ack:'||message_id)
  and m.direction='outbound' and m.status='pending' and m.dispatch_started_at is null)
 where e.provider_message_id=message_id and e.sender_phone=new.phone;
 return new;
end $$;
revoke all on function app.track_pending_reply_intent() from public,anon,authenticated,service_role;
create or replace trigger track_pending_reply_intent after insert or update of status,dispatch_started_at on public.whatsapp_messages for each row execute function app.track_pending_reply_intent();
update public.whatsapp_inbound_events e set reply_has_pending_intent=true where exists(select 1 from public.whatsapp_messages m
 where m.phone=e.sender_phone and m.idempotency_key='reply:'||e.provider_message_id and m.direction='outbound' and m.status='pending' and m.dispatch_started_at is null);
commit;
