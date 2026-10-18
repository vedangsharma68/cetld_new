-- Preserve existing consent attribution across STOP then START/UNSTOP.
-- Function-only replacement: no backfill, customer edits, or verification changes.
-- Reapplying this migration is safe; retry/order guards and grants stay intact.
begin;
create or replace function public.whatsapp_resubscribe_phone(
  p_provider_message_id text, p_sender_phone text, p_claim_token uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare e public.whatsapp_inbound_events;
begin
  -- Same lock/order as STOP and outbound consent gates.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_sender_phone, 0));
  select * into e from public.whatsapp_inbound_events
    where provider_message_id = p_provider_message_id and sender_phone = p_sender_phone
      and status = 'processing' and claim_token = p_claim_token
      and message_type = 'text' and lower(regexp_replace(message_text, '^[[:space:]]+|[[:space:]]+$', '', 'g')) in ('start','unstop')
    for update;
  if not found then return false; end if;
  -- Never restore again on a retry, especially after a subsequent STOP.
  if e.start_processed_at is not null then return e.start_applied; end if;
  update public.whatsapp_inbound_events set start_processed_at = clock_timestamp() where id = e.id;
  -- Newest-first inbox processing must not let a queued old START undo STOP.
  if exists (select 1 from public.whatsapp_inbound_events s
      where s.sender_phone = p_sender_phone and s.stop_processed_at is not null
        and (coalesce(s.provider_timestamp,s.received_at),s.id)
          > (coalesce(e.provider_timestamp,e.received_at),e.id))
    or exists (select 1 from public.whatsapp_global_suppressions s
      where s.phone = p_sender_phone and s.suppressed_at > e.received_at)
    or exists (select 1 from public.whatsapp_suppressions s
      where s.phone = p_sender_phone and s.suppressed_at > e.received_at)
  then return false; end if;

  delete from public.whatsapp_global_suppressions where phone = p_sender_phone;
  delete from public.whatsapp_suppressions where phone = p_sender_phone and reason in ('stop','refusal');
  update public.whatsapp_consents c
    set revoked_at = null, revoked_via = null, source = 'inbound_message',
        consented_at = clock_timestamp()
    where c.phone = p_sender_phone and c.revoked_via in ('stop','refusal')
      and c.source in ('verbal','inbound_message')
      and exists (select 1 from public.customers customer
        where customer.workspace_id = c.workspace_id and customer.id = c.customer_id
          and customer.phone = p_sender_phone)
      and not exists (select 1 from public.whatsapp_suppressions s
        where s.workspace_id = c.workspace_id and s.phone = p_sender_phone);
  update public.whatsapp_inbound_events set start_applied = true where id = e.id;
  return true;
end;
$$;
revoke all on function public.whatsapp_resubscribe_phone(text,text,uuid) from public,anon,authenticated;
grant execute on function public.whatsapp_resubscribe_phone(text,text,uuid) to service_role;

commit;
