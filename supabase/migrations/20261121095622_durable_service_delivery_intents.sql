begin;
set local lock_timeout='1s';
set local statement_timeout='5s';
insert into storage.buckets as bucket(id,name,public,file_size_limit,allowed_mime_types)
 values('whatsapp-delivery-private','whatsapp-delivery-private',false,10485760,null)
 on conflict(id) do update set public=false,file_size_limit=least(coalesce(bucket.file_size_limit,10485760),10485760);

-- A delivery belongs to an inbox event AND a phase, not to a workspace or to
-- the lifetime of its handler. This also holds unbound confirmations and acks.
create table if not exists app.whatsapp_service_deliveries(
 event_id bigint not null references public.whatsapp_inbound_events(id) on delete cascade,
 workspace_id uuid references public.workspaces(id) on delete cascade,
 phase text not null check(phase in ('answer','ack')),
 request jsonb not null check(octet_length(request::text)<=65536),
 status text not null default 'pending' check(status in ('pending','accepted','blocked','quarantined')),
 reason text,
 next_attempt_at timestamptz not null default now(),
 lease_token uuid,
 lease_until timestamptz,
 resume_state jsonb,
 primary key(event_id,phase)
);
create index if not exists whatsapp_service_delivery_pending on app.whatsapp_service_deliveries(next_attempt_at,event_id) where status='pending';
create index if not exists whatsapp_service_delivery_order on app.whatsapp_service_deliveries(event_id,phase desc) where status='pending';
alter table app.whatsapp_service_deliveries enable row level security;
revoke all on app.whatsapp_service_deliveries from public,anon,authenticated,service_role;

create or replace function app.refresh_service_delivery_pending(p_event_id bigint) returns void
language sql security definer set search_path='' as $$
 update public.whatsapp_inbound_events e set reply_has_pending_intent=
 exists(select 1 from app.whatsapp_service_deliveries d where d.event_id=e.id and d.status='pending')
 or exists(select 1 from public.whatsapp_messages m where m.phone=e.sender_phone and m.direction='outbound'
 and m.idempotency_key in ('reply:'||e.provider_message_id,'ack:'||e.provider_message_id)
 and m.status='pending' and m.dispatch_started_at is null)
 where e.id=p_event_id;
$$;
revoke all on function app.refresh_service_delivery_pending(bigint) from public,anon,authenticated,service_role;

create or replace function public.whatsapp_save_service_delivery(p_message_id text,p_phone text,p_phase text,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.whatsapp_inbound_events;d app.whatsapp_service_deliveries;input jsonb:=p_request->'input';
begin
 if p_phase not in ('answer','ack') or p_request->>'method' not in ('protocol','reply','media')
 or input->>'messageId' is distinct from p_message_id or input->>'to' is distinct from p_phone
 or coalesce(input->>'phase','answer')<>p_phase or octet_length(p_request::text)>65536 then raise exception 'INVALID_DELIVERY_INTENT';end if;
 select * into e from public.whatsapp_inbound_events where provider_message_id=p_message_id and sender_phone=p_phone and status='processing' for update;
 if e.id is null then raise exception 'DELIVERY_EVENT_NOT_LEASED';end if;
 -- Caller-supplied timestamps never extend the original service window.
 p_request:=jsonb_set(p_request,'{input,lastInboundAt}',to_jsonb(coalesce(e.provider_timestamp,e.received_at)));
 select * into d from app.whatsapp_service_deliveries where event_id=e.id and phase=p_phase for update;
 if d.event_id is not null then
  if d.request#>>'{input,workspaceId}' is distinct from input->>'workspaceId'
   or d.request#>>'{input,kind}' is distinct from input->>'kind'
   or coalesce(d.request#>>'{input,audience}','customer')<>coalesce(input->>'audience','customer') then raise exception 'DELIVERY_INTENT_SCOPE_CHANGED';end if;
  -- A protocol route is staged before its side effect; seal its first concrete
  -- reply exactly once. Sealed bytes/options are never replaced by a retry.
  if d.request->>'method'='protocol' and p_request->>'method'<>'protocol' and d.status='pending' then
   update app.whatsapp_service_deliveries set request=p_request where event_id=e.id and phase=p_phase returning * into d;
  end if;
 else
  insert into app.whatsapp_service_deliveries(event_id,workspace_id,phase,request) values(e.id,(input->>'workspaceId')::uuid,p_phase,p_request) returning * into d;
 end if;
 perform app.refresh_service_delivery_pending(e.id);
 return to_jsonb(d);
end $$;

create or replace function public.whatsapp_service_delivery_state(p_message_id text,p_phone text) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(d) order by d.phase),'[]'::jsonb)
 from app.whatsapp_service_deliveries d join public.whatsapp_inbound_events e on e.id=d.event_id
 where e.provider_message_id=p_message_id and e.sender_phone=p_phone;
$$;

create or replace function public.whatsapp_finish_service_delivery(p_message_id text,p_phone text,p_phase text,p_status text,p_reason text default null) returns void
language plpgsql security definer set search_path='' as $$
declare e public.whatsapp_inbound_events;d app.whatsapp_service_deliveries;started timestamptz;
begin
 if p_status not in ('pending','accepted','blocked','quarantined') then raise exception 'INVALID_DELIVERY_STATUS';end if;
 select * into e from public.whatsapp_inbound_events where provider_message_id=p_message_id and sender_phone=p_phone for update;
 select * into d from app.whatsapp_service_deliveries where event_id=e.id and phase=p_phase for update;
 if d.event_id is null then raise exception 'DELIVERY_INTENT_MISSING';end if;
 started:=case when p_phase='ack' then e.ack_dispatch_started_at else e.reply_dispatch_started_at end;
 if p_status='pending' and started is not null then p_status:='quarantined';end if;
 if d.status='pending' then update app.whatsapp_service_deliveries set status=p_status,reason=left(p_reason,100),next_attempt_at=clock_timestamp()+interval '1 minute' where event_id=e.id and phase=p_phase;end if;
 if p_status in ('blocked','quarantined') then
  update public.whatsapp_messages set status=case when p_status='blocked' then 'blocked' else 'unknown' end
  where idempotency_key=(case when p_phase='ack' then 'ack:' else 'reply:' end)||e.provider_message_id and phone=e.sender_phone
  and direction='outbound' and workspace_id is not distinct from (d.request#>>'{input,workspaceId}')::uuid and status='pending';
 end if;
 perform app.refresh_service_delivery_pending(e.id);
end $$;

-- Lease the parent briefly so ALL original authorization/claim/fence routines
-- still require status=processing. A completed answer is restored after its ack
-- phase; this does not reopen model work or reset an accepted transport fence.
create or replace function public.whatsapp_claim_service_delivery() returns jsonb
language plpgsql security definer set search_path='' as $$
declare e public.whatsapp_inbound_events;d app.whatsapp_service_deliveries;token uuid:=gen_random_uuid();started timestamptz;
begin
 select q.* into d from app.whatsapp_service_deliveries q join public.whatsapp_inbound_events i on i.id=q.event_id
 where q.status='pending' and (q.lease_until is null or q.lease_until<clock_timestamp())
 and (q.next_attempt_at<=clock_timestamp() or i.status='pending' and i.next_attempt_at<=clock_timestamp())
 and (i.status<>'processing' or i.claimed_at<clock_timestamp()-interval '5 minutes')
 order by q.event_id,q.phase desc -- answer before ack, using the pending index
 for update of q,i skip locked limit 1;
 if d.event_id is null then return null;end if;
 select * into e from public.whatsapp_inbound_events where id=d.event_id for update;
 started:=case when d.phase='ack' then e.ack_dispatch_started_at else e.reply_dispatch_started_at end;
 if started is not null or coalesce(e.provider_timestamp,e.received_at)<=clock_timestamp()-interval '24 hours' then
  update app.whatsapp_service_deliveries set status=case when started is not null then 'quarantined' else 'blocked' end,reason=case when started is not null then 'handoff_uncertain' else 'service_window_closed' end where event_id=d.event_id and phase=d.phase;
  update public.whatsapp_messages set status=case when started is not null then 'unknown' else 'blocked' end
  where idempotency_key=(case when d.phase='ack' then 'ack:' else 'reply:' end)||e.provider_message_id and phone=e.sender_phone
  and direction='outbound' and workspace_id is not distinct from (d.request#>>'{input,workspaceId}')::uuid and status='pending';
  perform app.refresh_service_delivery_pending(e.id);return null;
 end if;
 update app.whatsapp_service_deliveries set lease_token=token,lease_until=clock_timestamp()+interval '5 minutes',
 resume_state=coalesce(resume_state,to_jsonb(e)) where event_id=d.event_id and phase=d.phase returning * into d;
 update public.whatsapp_inbound_events set status='processing',claim_token=token,claimed_at=clock_timestamp() where id=e.id returning * into e;
 return jsonb_build_object('event',to_jsonb(e),'delivery',to_jsonb(d));
end $$;

create or replace function public.whatsapp_release_service_delivery(p_event_id bigint,p_phase text,p_token uuid) returns void
language plpgsql security definer set search_path='' as $$
declare d app.whatsapp_service_deliveries;e public.whatsapp_inbound_events;previous text;
begin
 select * into e from public.whatsapp_inbound_events where id=p_event_id and claim_token=p_token for update;
 select * into d from app.whatsapp_service_deliveries where event_id=p_event_id and phase=p_phase and lease_token=p_token for update;
 if e.id is null or d.event_id is null then raise exception 'DELIVERY_LEASE_LOST';end if;
 previous:=d.resume_state->>'status';
 if p_phase='ack' or previous in ('done','failed') then
  -- An expired processing lease belongs to a crashed/yielded producer. Clearing
  -- its lease while restoring processing would strand it: inbox claims require
  -- a non-null expired claimed_at. Return unfinished work to pending instead.
  update public.whatsapp_inbound_events set status=case when previous='processing' then 'pending' else previous end,
   next_attempt_at=case when previous='processing' then clock_timestamp() else next_attempt_at end,
   processed_at=(d.resume_state->>'processed_at')::timestamptz,
   claim_token=null,claimed_at=null,error_code=d.resume_state->>'error_code',error_detail=d.resume_state->>'error_detail' where id=e.id;
 else
  update public.whatsapp_inbound_events set status=case when d.status='pending' then 'pending' else 'done' end,
   processed_at=case when d.status='pending' then null else clock_timestamp() end,claim_token=null,claimed_at=null,
   next_attempt_at=d.next_attempt_at,error_code=case when d.status='pending' then 'DELIVERY_PENDING' else null end,error_detail=null where id=e.id;
 end if;
 update app.whatsapp_service_deliveries set lease_token=null,lease_until=null,resume_state=null where event_id=e.id and phase=p_phase;
 perform app.refresh_service_delivery_pending(e.id);
end $$;

-- Scoped receipt updates cannot erase a pending unbound or ack phase.
create or replace function app.track_pending_reply_intent() returns trigger language plpgsql security definer set search_path='' as $$
declare message_id text;
begin
 if new.direction<>'outbound' or new.idempotency_key !~ '^(reply|ack):' then return new;end if;
 message_id:=substring(new.idempotency_key from strpos(new.idempotency_key,':')+1);
 perform app.refresh_service_delivery_pending(e.id) from public.whatsapp_inbound_events e where e.provider_message_id=message_id and e.sender_phone=new.phone;
 return new;
end $$;

revoke all on function public.whatsapp_save_service_delivery(text,text,text,jsonb),public.whatsapp_service_delivery_state(text,text),public.whatsapp_finish_service_delivery(text,text,text,text,text),public.whatsapp_claim_service_delivery(),public.whatsapp_release_service_delivery(bigint,text,uuid) from public,anon,authenticated;
grant execute on function public.whatsapp_save_service_delivery(text,text,text,jsonb),public.whatsapp_service_delivery_state(text,text),public.whatsapp_finish_service_delivery(text,text,text,text,text),public.whatsapp_claim_service_delivery(),public.whatsapp_release_service_delivery(bigint,text,uuid) to service_role;
commit;
