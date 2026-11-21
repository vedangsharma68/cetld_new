-- Forward-only repair: reconcile answer receipts without re-opening uncertain
-- Graph handoffs. The current worker re-runs admission, binding and cutoff.
begin;
set local lock_timeout='1s';
set local statement_timeout='5s';
do $reconcile$
begin
 if to_regclass('app.whatsapp_service_deliveries') is null then return;end if;
 with candidates as materialized (
  select distinct on(e.id) e.id event_id,m.workspace_id,e.next_attempt_at,
   jsonb_build_object('method','reply','source','legacy_answer_receipt','input',jsonb_build_object(
    'workspaceId',m.workspace_id,'to',e.sender_phone,'messageId',e.provider_message_id,
    'kind',m.kind,'audience',m.audience,'phase','answer','body',m.body,
    'businessName',s.business_name,'lastInboundAt',coalesce(e.provider_timestamp,e.received_at))) request,
   case when m.dispatch_started_at is not null or m.provider_message_id is not null
     or e.reply_dispatch_started_at is not null or e.reply_dispatch_nonce is not null
     or (e.reply_claimed_at is not null and e.reply_reservation_nonce is null)
     or exists(select 1 from public.whatsapp_messages other where other.direction='outbound'
       and other.idempotency_key=m.idempotency_key and other.id<>m.id)
     or m.kind<>'normal' or m.workspace_id is null or s.business_name is null
     or m.invoice_id is not null or m.owner_action_ref is not null
     or m.owner_next_action_ref is not null or m.owner_reply_media_ref is not null or m.owner_receipt_ref is not null
    then 'quarantined'
    when coalesce(e.provider_timestamp,e.received_at)<=clock_timestamp()-interval '24 hours'
      or coalesce(e.provider_timestamp,e.received_at)>clock_timestamp() then 'blocked'
    else 'pending' end status
  from public.whatsapp_messages m join public.whatsapp_inbound_events e
   on m.idempotency_key='reply:'||e.provider_message_id and m.phone=e.sender_phone
  left join public.workspace_settings s on s.workspace_id=m.workspace_id
  where m.direction='outbound' and m.status='pending' and m.idempotency_key like 'reply:%'
   and not exists(select 1 from app.whatsapp_service_deliveries d where d.event_id=e.id and d.phase='answer')
  order by e.id,m.created_at,m.id
 )
 insert into app.whatsapp_service_deliveries(event_id,workspace_id,phase,request,status,reason,next_attempt_at)
 select event_id,workspace_id,'answer',request,status,
  case status when 'quarantined' then 'legacy_handoff_uncertain' when 'blocked' then 'service_window_closed' else null end,
  coalesce(next_attempt_at,clock_timestamp()) from candidates
 on conflict(event_id,phase) do nothing;

 update public.whatsapp_messages m set status=case when d.status='quarantined' then 'unknown' else 'blocked' end
 from app.whatsapp_service_deliveries d join public.whatsapp_inbound_events e on e.id=d.event_id
 where d.phase='answer' and d.reason in ('legacy_handoff_uncertain','service_window_closed')
  and d.status in ('quarantined','blocked') and m.idempotency_key='reply:'||e.provider_message_id
  and m.direction='outbound' and m.status='pending';
 -- Without an originating inbox event there is no authoritative service window
 -- or transport reservation. Expire these receipts; never synthesize authority.
 update public.whatsapp_messages m set status='blocked'
 where m.direction='outbound' and m.status='pending'
  and (m.idempotency_key like 'reply:%' or m.kind='normal' and m.idempotency_key not like 'ack:%')
  and not exists(select 1 from public.whatsapp_inbound_events e
   where m.idempotency_key='reply:'||e.provider_message_id and m.phone=e.sender_phone);
 perform app.refresh_service_delivery_pending(e.id) from public.whatsapp_inbound_events e
 where exists(select 1 from app.whatsapp_service_deliveries d where d.event_id=e.id and d.phase='answer');
end $reconcile$;
commit;
