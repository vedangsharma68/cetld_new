-- Forward-only repair: reconcile answer receipts without re-opening uncertain
-- Graph handoffs. The current worker re-runs admission, binding and cutoff.
begin;
set local lock_timeout='1s';
set local statement_timeout='5s';
do $reconcile$
begin
 if to_regclass('app.whatsapp_service_deliveries') is null then return;end if;
 -- Track only the deliveries this run transitions so later statements stay
 -- bounded by the reconciliation set instead of the full delivery history.
 execute 'create temporary table _admission_recovery_inserted(event_id bigint primary key) on commit drop';
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
     or m.owner_next_action_ref is not null or m.owner_reply_media_ref is not null or to_jsonb(m)->>'owner_receipt_ref' is not null
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
 ),
 inserted as (
  insert into app.whatsapp_service_deliveries(event_id,workspace_id,phase,request,status,reason,next_attempt_at)
  select event_id,workspace_id,'answer',request,status,
   case status when 'quarantined' then 'legacy_handoff_uncertain' when 'blocked' then 'service_window_closed' else null end,
   coalesce(next_attempt_at,clock_timestamp()) from candidates
  on conflict(event_id,phase) do nothing
  returning event_id
 )
 insert into _admission_recovery_inserted(event_id) select event_id from inserted;

 update public.whatsapp_messages m set status=case when d.status='quarantined' then 'unknown' else 'blocked' end
 from app.whatsapp_service_deliveries d join public.whatsapp_inbound_events e on e.id=d.event_id
 where d.phase='answer' and d.reason in ('legacy_handoff_uncertain','service_window_closed')
  and d.status in ('quarantined','blocked') and m.idempotency_key='reply:'||e.provider_message_id
  and m.direction='outbound' and m.status='pending'
  and d.event_id in (select event_id from _admission_recovery_inserted);
 -- Without an originating inbox event there is no authoritative service window
 -- or transport reservation. Receipts that show a Graph handoff (dispatch
 -- fence or provider identity) may still reconcile through a later callback,
 -- so they stay uncertain; only receipts that provably never dispatched
 -- expire. Never synthesize authority for either.
 update public.whatsapp_messages m set status=case
   when m.dispatch_started_at is not null or m.provider_message_id is not null then 'unknown'
   else 'blocked' end
 where m.direction='outbound' and m.status='pending'
  and (m.idempotency_key like 'reply:%' or m.kind='normal' and m.idempotency_key not like 'ack:%')
  and not exists(select 1 from public.whatsapp_inbound_events e
   where m.idempotency_key='reply:'||e.provider_message_id and m.phone=e.sender_phone);
 -- Recompute rollups only for the parents this run transitioned. Settled
 -- history is unaffected by the reconciliation and must not be rewritten.
 perform app.refresh_service_delivery_pending(event_id) from _admission_recovery_inserted;
end $reconcile$;
-- BEGIN GENERATED ADMISSION REVISION
create or replace function app.private_invoice_admission_revision() returns text
language sql immutable set search_path='' as $$select '4683914212d9c8a45464cc3e041e20e957859d55a81852b276285cddbfbe5b77'::text$$;
revoke all on function app.private_invoice_admission_revision() from public,anon,authenticated,service_role;
-- END GENERATED ADMISSION REVISION
-- The worker's startup gate reads the live admission revision through this
-- definer wrapper (the app function itself stays revoked) and refuses to
-- claim work when it differs from the deployed build.
create or replace function public.whatsapp_dispatch_admission_revision() returns text
language sql stable security definer set search_path='' as $$
 select app.private_invoice_admission_revision()
$$;
revoke all on function public.whatsapp_dispatch_admission_revision() from public;
grant execute on function public.whatsapp_dispatch_admission_revision() to anon,authenticated,service_role;
commit;
